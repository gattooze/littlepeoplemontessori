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

  /** Best-effort human label for a field -- name/id fallback used only
   *  for the GA4 field_name param (see form_validation_fail below), not
   *  shown to the visitor (the inline message sits right under the
   *  field, so re-naming it in the message text would be redundant). */
  function labelForField(form, el) {
    if (el.id) {
      const lbl = form.querySelector(`label[for="${el.id}"]`);
      if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
    }
    return el.name || el.id || null;
  }

  /* ---------------------------------------------------------
     Inline field-level validation errors: a short message riding on
     the SAME line as the field's own label (right-aligned, small,
     red) -- not a new line under the input, not a single generic
     banner. That's the fix for the 2026-08-19 incident (see wire()
     below). One <style> injected once, shared by every form on this
     kit rather than duplicated per-page -- any current or future
     form using the same .f-field > label convention picks this up
     automatically, no per-page markup or CSS required.

     Turning the label into a flex row is safe even on fields that
     never show an error: <label> is inline by default, but as a
     direct child of .f-field's CSS grid it's already blockified
     (grid/flex children always compute to their block equivalent
     regardless of the specified display), so switching it to
     display:flex changes how its children lay out, not whether the
     label itself behaves as a block. margin-left:auto on the error
     span (not justify-content:space-between on the label) is what
     actually pushes it to the far right -- that stays correct even
     if a label has other children before the error (e.g. an "(if
     applicable)" note), where space-between would instead spread
     gaps between every child. flex-wrap lets a genuinely-too-long
     combination fall to a second line rather than clipping or
     overflowing, for any future form with longer labels/messages. */
  let fieldErrCssInjected = false;
  function ensureFieldErrCss() {
    if (fieldErrCssInjected) return;
    fieldErrCssInjected = true;
    const style = document.createElement('style');
    style.textContent = '.f-field label{display:flex;align-items:baseline;flex-wrap:wrap;' +
      'row-gap:0.15rem;column-gap:0.6rem;}' +
      '.f-field-err{display:none;margin-left:auto;color:#C4634A;font-size:0.72rem;' +
      'font-weight:500;text-align:right;}.f-field-err.show{display:inline-block;}' +
      '.f-field-invalid{border-color:#C4634A !important;}';
    document.head.appendChild(style);
  }

  /** Human-friendly message per constraint, since the browser's own
   *  el.validationMessage is inconsistent across browsers/locales (and
   *  on some mobile browsers is either unhelpfully terse or oddly
   *  phrased for a non-technical parent reading it). Short on purpose
   *  -- these share a line with the label, not a fresh line of their
   *  own to spread out on. */
  function friendlyValidationMessage(el) {
    const v = el.validity;
    if (v.valueMissing) return 'Required';
    if (v.typeMismatch) return el.type === 'email' ? 'Enter a valid email address' : 'Enter a valid value';
    if (v.patternMismatch) return 'Check the format';
    if (v.tooShort || v.tooLong) return 'Check the length';
    if (v.rangeUnderflow || v.rangeOverflow) return 'Enter a valid range';
    return el.validationMessage || 'Check this field';
  }

  /** The field's own <label> is the append target, not the input and
   *  not the wrapping .f-field -- that's what puts the message on the
   *  same line as the field name instead of a new line under the
   *  input. Falls back to the .f-field wrapper (old below-field
   *  behavior) for the rare field with no associated <label>, e.g. a
   *  future form that skips one -- still correct, just not inline.
   *  Every field on every current form (RSVP, admissions, join) has
   *  one, confirmed by grep. */
  function fieldErrorTarget(el) {
    const wrap = el.closest('.f-field');
    if (!wrap) return el.parentElement;
    return wrap.querySelector('label') || wrap;
  }

  function showFieldError(el) {
    ensureFieldErrCss();
    const wrap = fieldErrorTarget(el);
    let err = wrap.querySelector(':scope > .f-field-err');
    if (!err) {
      err = document.createElement('span');
      err.className = 'f-field-err';
      wrap.appendChild(err);
    }
    err.textContent = friendlyValidationMessage(el);
    err.classList.add('show');
    el.classList.add('f-field-invalid');
    el.setAttribute('aria-invalid', 'true');

    // Live-clear as soon as this specific field becomes valid again --
    // don't make the visitor re-click Submit (or re-blur) just to find
    // out they fixed it. Guarded so calling showFieldError() again on
    // the same field (blur, then a later submit attempt, both hitting
    // the same still-invalid field) doesn't stack duplicate listeners.
    if (!el.dataset.lpmClearWired) {
      el.dataset.lpmClearWired = 'true';
      const clear = () => {
        if (el.checkValidity()) {
          err.classList.remove('show');
          el.classList.remove('f-field-invalid');
          el.removeAttribute('aria-invalid');
        }
      };
      el.addEventListener('input', clear);
      el.addEventListener('change', clear);
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
    let body = null;
    try { body = await res.json(); } catch (_) { /* opaque response still counts as success */ }
    if (body && body.ok === false) {
      // A definitive rejection from the server (e.g. a full RSVP slot)
      // -- not a transient failure. Retrying won't help (the same
      // business rule will reject it again) and queuing it would leave
      // a submission stuck forever silently failing every retry, so
      // this must never be treated the same as a network blip.
      const err = new Error(body.error || 'rejected');
      err.rejection = body;
      throw err;
    }
    return true;
  }

  async function sendWithRetry(endpoint, formData) {
    try {
      return await attemptFetch(endpoint, formData);
    } catch (err) {
      if (err && err.rejection) return { rejected: err.rejection };
      for (const delay of RETRY_DELAYS_MS) {
        await sleep(delay);
        try {
          return await attemptFetch(endpoint, formData);
        } catch (err2) {
          if (err2 && err2.rejection) return { rejected: err2.rejection };
          /* transient -- keep going */
        }
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
    let abandoned = false;
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

    // Fires at most once per form per session: pagehide and
    // visibilitychange both fire on every tab-switch/app-background, not
    // just the final close, so without this guard one visitor who
    // checked another tab a few times mid-fill would log as several
    // different "abandons" instead of one (or zero, if they came back
    // and finished).
    const abandonBeacon = () => {
      if (!started || abandoned || form.dataset.lpmSubmitted === 'true') return;
      abandoned = true;
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
     * @param {Function} [opts.onRejected] Called with the server's JSON
     *                                     body ({ok:false, error, message})
     *                                     when it explicitly rejects the
     *                                     submission (e.g. a full RSVP
     *                                     slot) -- never retried/queued.
     *                                     Falls back to the .f-error
     *                                     element if not given.
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
      // Captured once, up front -- restored verbatim before showing the
      // generic network-fail message, since the validation-fail branch
      // below temporarily overwrites errorEl's text with a different
      // message. Without this, a form with no onQueued override (e.g.
      // join.html) would show a stale validation message on a later,
      // unrelated network failure in the same page session.
      const defaultErrorHTML = errorEl ? errorEl.innerHTML : '';
      const submitBtn = form.querySelector('button[type="submit"]');
      const submitLabel = form.querySelector('.f-submit-label');
      const defaultLabel = submitLabel ? submitLabel.textContent : '';

      wireEngagementTracking(form, formId);

      // Validate on blur, not only on submit -- waiting until Submit to
      // show a visitor their first invalid field is exactly the "ancient
      // UX" this fix was supposed to move past. willValidate is true for
      // every real form control that participates in constraint
      // validation (skips buttons, disabled fields, the honeypot's
      // tabindex="-1" input is simply never reached by real tab/blur
      // traffic anyway). Only fires ON BLUR, never while still typing --
      // showFieldError() itself wires the live-clear 'input' listener,
      // so once shown this way it still disappears the moment it's
      // fixed, same as the submit-triggered path.
      Array.from(form.elements).forEach((el) => {
        if (!el.willValidate) return;
        el.addEventListener('blur', () => {
          if (!el.checkValidity()) showFieldError(el);
        });
      });

      // Flush anything orphaned from a previous visit as soon as we
      // know where to send it.
      flushQueue((key) => (key === formId ? endpoint : null));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errorEl) errorEl.classList.remove('show');
        gtagEvent('form_submit_attempt', { form_id: formId });

        if (!form.checkValidity()) {
          // A single generic banner (native reportValidity(), or an
          // earlier version of this fix) isn't enough -- confirmed via a
          // real incident (2026-08-19, RSVP form, iOS Safari): a visitor
          // hit an invalid field, got only the browser's own inline
          // tooltip, didn't notice it, and clicked Submit repeatedly
          // over several minutes with zero visible feedback before
          // giving up for two hours. This instead shows a small message
          // directly under EVERY invalid field at once (not just the
          // first -- fixing one only to discover a second on the next
          // click is its own bad experience), clears each one live as
          // it's fixed, and blocks submission until all are resolved.
          const invalidEls = Array.from(form.querySelectorAll(':invalid'));
          invalidEls.forEach(showFieldError);
          gtagEvent('form_validation_fail', {
            form_id: formId,
            field_name: invalidEls.map((el) => el.name || el.id || 'unknown').join(',')
          });
          if (invalidEls[0] && typeof invalidEls[0].scrollIntoView === 'function') {
            invalidEls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            invalidEls[0].focus({ preventScroll: true });
          }
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

        const result = await sendWithRetry(endpoint, formData);

        document.removeEventListener('pagehide', beaconOnExit);

        if (result === true) {
          form.dataset.lpmSubmitted = 'true';
          unqueueSubmission(idempotencyKey);
          gtagEvent('form_submit_success', { form_id: formId });
          if (opts.onSuccess) opts.onSuccess();
        } else if (result && result.rejected) {
          // The server explicitly rejected this submission for a real
          // reason (e.g. a full RSVP slot) -- must NOT be queued/retried
          // or shown as success; that would tell the visitor they're
          // confirmed when they're not.
          gtagEvent('form_submit_fail', { form_id: formId, reject_reason: result.rejected.error || 'rejected' });
          if (opts.onRejected) {
            opts.onRejected(result.rejected);
          } else if (errorEl) {
            errorEl.textContent = result.rejected.message || 'That submission was rejected -- please check the form and try again.';
            errorEl.classList.add('show');
          }
        } else {
          // Don't tell the visitor it failed outright -- queue it so a
          // later page load (or the beacon that may still land) can
          // still deliver it, and let the UI proceed optimistically if
          // the caller wants that (see open-house-rsvp.html).
          queueSubmission(formId, payloadObj);
          gtagEvent('form_submit_fail', { form_id: formId, reject_reason: 'network' });
          if (opts.onQueued) {
            opts.onQueued();
          } else if (errorEl) {
            errorEl.innerHTML = defaultErrorHTML;
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
