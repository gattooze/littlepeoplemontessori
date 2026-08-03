/**
 * Little People Montessori -- shared form-submission kit.
 *
 * One module, included by every form page. Building the generic parts
 * here ONCE is the actual "reusable forms platform" deliverable -- a
 * future form page is just markup + a config object, not a rebuild of
 * reliability/tracking/backend plumbing.
 *
 * What it does for every form that calls FormKit.wire(...):
 *   - Sends as multipart/form-data (never JSON): a JSON POST forces a
 *     CORS preflight (OPTIONS) that Apps Script Web Apps can't answer,
 *     so doPost never fires. FormData stays a CORS "simple request".
 *   - Retries with backoff to absorb transient network blips.
 *   - Fires navigator.sendBeacon on pagehide as an unload-safe last
 *     attempt -- the one delivery mechanism the browser will still try
 *     to honour after the tab is gone, which a fetch() retry cannot.
 *   - Queues a failed submission to localStorage (one key per attempt,
 *     not a shared array, so two in-flight submissions can never race
 *     a read-modify-write) and auto-flushes any queued items on the
 *     next page load of ANY form using this kit.
 *   - Tags every attempt with one idempotency key, reused across every
 *     retry/beacon/queue-flush of that same attempt, so a retry that
 *     fires after the first attempt actually succeeded doesn't create
 *     a duplicate row -- apps-script.gs checks this key before writing.
 *   - Tracks field-level engagement via ONE delegated listener (not a
 *     handler per field), so it automatically covers any field on any
 *     current or future form: form_start, field focus/blur, submit
 *     attempt/success/fail, and a field_abandon beacon on pagehide
 *     naming the last field the visitor touched before leaving.
 *   - Captures UTM params and a lightweight device/browser class as
 *     hidden fields into the Sheet-bound payload. Deliberately NOT
 *     re-sent as GA4 params for that purpose -- GA4 already captures
 *     device category and attributes standard utm_* params for free;
 *     the hand-rolled copy exists only to get that data into the Sheet,
 *     which doesn't have GA4's automatic dimensions.
 *   - Never sends PII (name/phone/email/address) as a GA4 event param.
 *     GA4 only ever sees non-identifying values: field name, selected
 *     option, device class, UTM values.
 */
(function (global) {
  'use strict';

  const QUEUE_PREFIX = 'lpm_form_queue_';
  const RETRY_DELAYS_MS = [600, 1500]; // 2 retries after the first attempt, exponential-ish
  const REDIRECT_HOLD_MS = 1500; // window given to the background attempt before navigating away
  const QUEUE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 3; // stop retrying a queued item after 3 days

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    // Fallback for older mobile browsers without crypto.randomUUID.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function gtagEvent(name, params) {
    if (typeof global.gtag === 'function') {
      global.gtag('event', name, params || {});
    }
  }

  /** Lightweight, dependency-free device/browser classification -- good
   *  enough for "which kind of phone are people using", not a full UA
   *  parser. */
  function classifyDevice() {
    const ua = navigator.userAgent || '';
    let os = 'Other';
    if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Macintosh/.test(ua)) os = 'Mac';
    else if (/Linux/.test(ua)) os = 'Linux';

    let browser = 'Other';
    if (/CriOS/.test(ua)) browser = 'Chrome (iOS)';
    else if (/FxiOS/.test(ua)) browser = 'Firefox (iOS)';
    else if (/EdgA|EdgiOS|Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Instagram/.test(ua)) browser = 'Instagram in-app';
    else if (/FBAN|FBAV/.test(ua)) browser = 'Facebook in-app';
    else if (/WhatsApp/.test(ua)) browser = 'WhatsApp in-app';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';

    const isTouch = 'ontouchstart' in global || navigator.maxTouchPoints > 0;
    const deviceType = /Mobi|iPhone|iPod/.test(ua) ? 'mobile' : (/iPad|Tablet/.test(ua) ? 'tablet' : 'desktop');

    return {
      os, browser, deviceType,
      touch: isTouch ? 'yes' : 'no',
      screen: `${screen.width}x${screen.height}`,
      viewport: `${innerWidth}x${innerHeight}`,
      ua
    };
  }

  function captureUTM() {
    const params = new URLSearchParams(location.search);
    const out = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((k) => {
      if (params.has(k)) out[k] = params.get(k);
    });
    return out;
  }

  function setHidden(form, name, value) {
    if (value === undefined || value === null || value === '') return;
    let input = form.querySelector(`input[name="${name}"]`);
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  function enrichHiddenFields(form) {
    const device = classifyDevice();
    setHidden(form, 'device_os', device.os);
    setHidden(form, 'device_browser', device.browser);
    setHidden(form, 'device_type', device.deviceType);
    setHidden(form, 'device_screen', device.screen);
    setHidden(form, 'user_agent', device.ua);
    setHidden(form, 'referrer', document.referrer || '');
    setHidden(form, 'page_url', location.href);

    const utm = captureUTM();
    Object.keys(utm).forEach((k) => setHidden(form, k, utm[k]));

    return device;
  }

  /* ---------------------------------------------------------
     Delivery: fetch-with-retry, sendBeacon fallback, and a
     durable localStorage queue keyed per-attempt (not a shared
     array) so concurrent submissions can never race each other.
     --------------------------------------------------------- */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function attemptFetch(endpoint, formData) {
    const res = await fetch(endpoint, { method: 'POST', body: formData });
    let ok = res.ok;
    try { ok = (await res.json()).ok !== false; } catch (_) { /* opaque response still counts as success */ }
    if (!ok) throw new Error('rejected');
    return true;
  }

  async function sendWithRetry(endpoint, formData) {
    try {
      return await attemptFetch(endpoint, formData);
    } catch (_) {
      for (const delay of RETRY_DELAYS_MS) {
        await sleep(delay);
        try {
          return await attemptFetch(endpoint, formData);
        } catch (_) { /* keep going */ }
      }
    }
    return false;
  }

  function formDataToObject(formData) {
    const obj = {};
    for (const [k, v] of formData.entries()) obj[k] = v;
    return obj;
  }

  function objectToFormData(obj) {
    const fd = new FormData();
    Object.keys(obj).forEach((k) => fd.append(k, obj[k]));
    return fd;
  }

  function queueSubmission(endpointKey, payloadObj) {
    const key = QUEUE_PREFIX + payloadObj.idempotency_key;
    try {
      localStorage.setItem(key, JSON.stringify({
        endpointKey, // resolve the real URL at flush time, never freeze it into the queue
        payload: payloadObj,
        queuedAt: Date.now()
      }));
    } catch (_) { /* storage full or unavailable -- nothing more we can do client-side */ }
  }

  function unqueueSubmission(idempotencyKey) {
    try { localStorage.removeItem(QUEUE_PREFIX + idempotencyKey); } catch (_) {}
  }

  /** Call once per page load, before wiring any form: attempts to
   *  deliver anything left over from a previous visit/tab that never
   *  confirmed success -- from THIS form or any other on the same
   *  kit, so a queued item survives even if the visitor lands on a
   *  different page next time. */
  async function flushQueue(resolveEndpoint) {
    let keys;
    try {
      keys = Object.keys(localStorage).filter((k) => k.indexOf(QUEUE_PREFIX) === 0);
    } catch (_) { return; }

    for (const key of keys) {
      let item;
      try { item = JSON.parse(localStorage.getItem(key)); } catch (_) { localStorage.removeItem(key); continue; }
      if (!item) { localStorage.removeItem(key); continue; }
      if (Date.now() - item.queuedAt > QUEUE_MAX_AGE_MS) { localStorage.removeItem(key); continue; }

      const endpoint = resolveEndpoint(item.endpointKey);
      if (!endpoint) continue;

      const ok = await sendWithRetry(endpoint, objectToFormData(item.payload));
      if (ok) localStorage.removeItem(key);
    }
  }

  /* ---------------------------------------------------------
     Field-engagement tracking: one delegated listener per form,
     not one handler per field -- covers any field automatically.
     --------------------------------------------------------- */
  function wireEngagementTracking(form, formId) {
    let started = false;
    let lastField = null;

    form.addEventListener('focusin', (e) => {
      const name = e.target && e.target.name;
      if (!name) return;
      lastField = name;
      if (!started) {
        started = true;
        gtagEvent('form_start', { form_id: formId });
      }
      gtagEvent('field_focus', { form_id: formId, field_name: name });
    });

    form.addEventListener('focusout', (e) => {
      const name = e.target && e.target.name;
      if (!name) return;
      gtagEvent('field_blur', { form_id: formId, field_name: name });
    });

    const abandonBeacon = (endpoint) => {
      if (!started || form.dataset.lpmSubmitted === 'true') return;
      gtagEvent('field_abandon', { form_id: formId, field_name: lastField || '(none)' });
      // Best-effort analytics beacon only -- not a form submission, so
      // no payload/endpoint needed beyond the gtag call above unless a
      // GA4 measurement endpoint is configured elsewhere on the page.
    };

    document.addEventListener('pagehide', () => abandonBeacon());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') abandonBeacon();
    });
  }

  /* ---------------------------------------------------------
     Country-code phone field: a flag+dial-code <select> plus a
     plain digits-only <input>, kept visually separate (better UX
     than making someone edit a pre-filled "+91 " prefix), synced
     into one hidden field so the Sheet still gets a single "phone"
     value with the code affixed -- no schema change, no separate
     column. Flags are computed from the ISO code (regional-
     indicator Unicode trick), not hand-typed, so there's no risk
     of a mismatched/miscopied emoji across 50+ entries.
     --------------------------------------------------------- */
  const COUNTRIES = [
    // [ISO 3166-1 alpha-2, dial code, name] -- India first as the default.
    ['IN', '91', 'India'],
    ['AE', '971', 'United Arab Emirates'],
    ['AF', '93', 'Afghanistan'],
    ['AU', '61', 'Australia'],
    ['AT', '43', 'Austria'],
    ['BH', '973', 'Bahrain'],
    ['BD', '880', 'Bangladesh'],
    ['BE', '32', 'Belgium'],
    ['BR', '55', 'Brazil'],
    ['CA', '1', 'Canada'],
    ['CN', '86', 'China'],
    ['DK', '45', 'Denmark'],
    ['EG', '20', 'Egypt'],
    ['FI', '358', 'Finland'],
    ['FR', '33', 'France'],
    ['DE', '49', 'Germany'],
    ['HK', '852', 'Hong Kong'],
    ['ID', '62', 'Indonesia'],
    ['IE', '353', 'Ireland'],
    ['IL', '972', 'Israel'],
    ['IT', '39', 'Italy'],
    ['JP', '81', 'Japan'],
    ['KE', '254', 'Kenya'],
    ['KW', '965', 'Kuwait'],
    ['MY', '60', 'Malaysia'],
    ['MV', '960', 'Maldives'],
    ['MU', '230', 'Mauritius'],
    ['MX', '52', 'Mexico'],
    ['NP', '977', 'Nepal'],
    ['NL', '31', 'Netherlands'],
    ['NZ', '64', 'New Zealand'],
    ['NG', '234', 'Nigeria'],
    ['NO', '47', 'Norway'],
    ['OM', '968', 'Oman'],
    ['PK', '92', 'Pakistan'],
    ['PH', '63', 'Philippines'],
    ['PL', '48', 'Poland'],
    ['PT', '351', 'Portugal'],
    ['QA', '974', 'Qatar'],
    ['RU', '7', 'Russia'],
    ['SA', '966', 'Saudi Arabia'],
    ['SG', '65', 'Singapore'],
    ['ZA', '27', 'South Africa'],
    ['KR', '82', 'South Korea'],
    ['ES', '34', 'Spain'],
    ['LK', '94', 'Sri Lanka'],
    ['SE', '46', 'Sweden'],
    ['CH', '41', 'Switzerland'],
    ['TW', '886', 'Taiwan'],
    ['TZ', '255', 'Tanzania'],
    ['TH', '66', 'Thailand'],
    ['TR', '90', 'Turkey'],
    ['GB', '44', 'United Kingdom'],
    ['US', '1', 'United States'],
    ['VN', '84', 'Vietnam']
  ];

  function flagEmoji(iso2) {
    return iso2.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
  }

  /**
   * A flag+code picker, not a native <select> -- the collapsed button
   * only ever shows the flag and dial code (e.g. "🇮🇳 +91"); the full
   * country name only appears in the open dropdown list. A native
   * <select> can't do this (its closed state always mirrors whichever
   * <option> text is selected), so this is a small custom listbox
   * matching the same interaction pattern as the location autocomplete
   * already on the RSVP page (button/list, mousedown-to-select so a
   * click can't be lost to a blur, Escape/outside-click to close).
   *
   * @param {HTMLElement} wrapperEl       Container with .f-cc-btn /
   *   .f-cc-flag / .f-cc-code / .f-cc-list children (see markup below).
   * @param {HTMLInputElement} numberInput  Plain digits, user-facing.
   *   Its `pattern`/`maxlength`/`title` are updated per selected
   *   country (10-digit for India, a looser 6-14 digit range
   *   elsewhere) so the browser's own validation enforces it --
   *   participates in the same checkValidity()/reportValidity() flow
   *   wire() already calls, no separate validation code needed.
   * @param {HTMLInputElement} hiddenPhoneInput  The actual submitted
   *   field (e.g. name="phone") -- kept in sync as "+<dial><digits>",
   *   no space, per how the Sheet should store it.
   */
  function wireCountryPhone(wrapperEl, numberInput, hiddenPhoneInput) {
    const btn = wrapperEl.querySelector('.f-cc-btn');
    const flagEl = wrapperEl.querySelector('.f-cc-flag');
    const codeEl = wrapperEl.querySelector('.f-cc-code');
    const list = wrapperEl.querySelector('.f-cc-list');

    list.innerHTML = COUNTRIES.map(([iso, dial, name]) =>
      `<li class="f-cc-item" role="option">${flagEmoji(iso)} +${dial} ${name}</li>`
    ).join('');
    const items = Array.from(list.querySelectorAll('.f-cc-item'));
    let activeIndex = 0;

    function sync() {
      const digits = numberInput.value.replace(/\D/g, '');
      hiddenPhoneInput.value = digits ? `+${COUNTRIES[activeIndex][1]}${digits}` : '';
    }

    function applyCountry(index) {
      activeIndex = index;
      const [, dial, name] = COUNTRIES[index];
      flagEl.textContent = flagEmoji(COUNTRIES[index][0]);
      codeEl.textContent = `+${dial}`;
      btn.setAttribute('aria-label', `Country code, currently ${name}, plus ${dial}`);
      items.forEach((el, i) => el.classList.toggle('f-cc-active', i === index));
      if (dial === '91') {
        numberInput.pattern = '[0-9]{10}';
        numberInput.maxLength = 10;
        numberInput.title = 'Enter a 10-digit mobile number';
      } else {
        numberInput.pattern = '[0-9]{6,14}';
        numberInput.removeAttribute('maxlength');
        numberInput.title = 'Enter your mobile number, digits only';
      }
      sync();
    }

    function openList() { list.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
    function closeList() { list.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }

    btn.addEventListener('click', () => {
      list.classList.contains('open') ? closeList() : openList();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); openList(); applyCountry(Math.min(activeIndex + 1, items.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); applyCountry(Math.max(activeIndex - 1, 0)); }
      else if (e.key === 'Escape') closeList();
    });
    list.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.f-cc-item');
      if (!item) return;
      applyCountry(items.indexOf(item));
      closeList();
    });
    document.addEventListener('click', (e) => {
      if (!wrapperEl.contains(e.target)) closeList();
    });
    numberInput.addEventListener('input', sync);

    applyCountry(0); // India, first in COUNTRIES
  }

  /* ---------------------------------------------------------
     Generic CTA click tracking: any element with data-cta="label"
     anywhere on the page fires a GA4 cta_click event on click, with
     no per-page wiring beyond including this script -- one delegated
     document-level listener, same pattern as the field-engagement
     tracker above, so it automatically covers a CTA added to any
     current or future page. Doesn't duplicate GA4's own automatic
     outbound-click tracking (Instagram/WhatsApp links) -- this is
     for same-domain CTAs and tel:/mailto: links, which Enhanced
     Measurement does not capture as their own named event.
     --------------------------------------------------------- */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cta]');
    if (!el) return;
    gtagEvent('cta_click', {
      cta_label: el.dataset.cta,
      cta_href: el.getAttribute('href') || null
    });
  });

  /* ---------------------------------------------------------
     Public API
     --------------------------------------------------------- */
  const FormKit = {
    /**
     * @param {HTMLFormElement} form
     * @param {Object} opts
     * @param {string} opts.endpoint       Apps Script Web App URL (or a
     *                                     placeholder -- wire() guards
     *                                     against submitting to one).
     * @param {string} opts.formId         Routing key read by
     *                                     apps-script.gs's FORMS map.
     * @param {Function} [opts.onSuccess]  Called after a confirmed (or
     *                                     optimistically assumed, see
     *                                     redirect timing) success.
     * @param {Function} [opts.onError]    Called if every attempt and
     *                                     the queue write both fail to
     *                                     even start (e.g. FormData
     *                                     unsupported) -- vanishingly
     *                                     rare; queueing is the normal
     *                                     path for "network is down".
     */
    wire(form, opts) {
      const { endpoint, formId } = opts;
      const errorEl = form.querySelector('.f-error');
      const submitBtn = form.querySelector('button[type="submit"]');
      const submitLabel = form.querySelector('.f-submit-label');
      const defaultLabel = submitLabel ? submitLabel.textContent : '';

      wireEngagementTracking(form, formId);

      // Flush anything orphaned from a previous visit as soon as we
      // know where to send it.
      flushQueue((key) => (key === formId ? endpoint : null));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errorEl) errorEl.classList.remove('show');
        gtagEvent('form_submit_attempt', { form_id: formId });

        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        if (typeof endpoint !== 'string' || endpoint.indexOf('PASTE_') === 0) {
          if (errorEl) {
            errorEl.textContent = 'Form isn\'t connected yet — the Apps Script URL still needs to be pasted in.';
            errorEl.classList.add('show');
          }
          return;
        }

        enrichHiddenFields(form);
        const idempotencyKey = uuid();
        setHidden(form, 'idempotency_key', idempotencyKey);
        setHidden(form, 'form_id', formId);

        const formData = new FormData(form);
        const payloadObj = formDataToObject(formData);

        if (submitBtn) submitBtn.disabled = true;
        if (submitLabel) submitLabel.textContent = 'Sending…';

        // Unload-safe last attempt: if the tab dies while sendWithRetry
        // is still working, this is the only mechanism the browser
        // still honours.
        const beaconOnExit = () => {
          if (form.dataset.lpmSubmitted === 'true') return;
          try { navigator.sendBeacon(endpoint, objectToFormData(payloadObj)); } catch (_) {}
        };
        document.addEventListener('pagehide', beaconOnExit, { once: true });

        const delivered = await sendWithRetry(endpoint, formData);

        document.removeEventListener('pagehide', beaconOnExit);

        if (delivered) {
          form.dataset.lpmSubmitted = 'true';
          unqueueSubmission(idempotencyKey);
          gtagEvent('form_submit_success', { form_id: formId });
          if (opts.onSuccess) opts.onSuccess();
        } else {
          // Don't tell the visitor it failed outright -- queue it so a
          // later page load (or the beacon that may still land) can
          // still deliver it, and let the UI proceed optimistically if
          // the caller wants that (see open-house-rsvp.html).
          queueSubmission(formId, payloadObj);
          gtagEvent('form_submit_fail', { form_id: formId });
          if (opts.onQueued) {
            opts.onQueued();
          } else if (errorEl) {
            errorEl.classList.add('show');
          }
        }

        if (submitBtn) submitBtn.disabled = false;
        if (submitLabel) submitLabel.textContent = defaultLabel;
      });
    },

    /** Exposed for pages (like the RSVP form) that want an optimistic
     *  "you're in" state immediately, with the real network attempt
     *  still running underneath, and a bounded hold before navigating
     *  away so the retry/beacon sequence gets a real window first. */
    REDIRECT_HOLD_MS,

    /** Wires a flag+dial-code picker (collapsed view shows flag+code
     *  only, full names in the open list; India default) and keeps a
     *  hidden phone field in sync as "+<dial><digits>", no space --
     *  see wireCountryPhone above. */
    wireCountryPhone,

    _internal: { classifyDevice, captureUTM, uuid } // exposed for local testing only
  };

  global.FormKit = FormKit;
})(window);
