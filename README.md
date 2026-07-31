# little people montessori

Website for Little People Montessori, Mumbai — a Montessori house for children 18 months to 6 years, with a casa daycare and an activity centre, under an old mango tree.

Main site: `index.html` (hash-routed pages, hand-drawn SVG illustration system, no build step).

Standalone lead-capture pages, unlinked from the main nav:
- `join.html` — WhatsApp-share enquiry form
- `open-house-rsvp.html` — Open House RSVP (unlisted via `noindex`, shared only as a direct link)

Both, plus the enquiry form on `index.html`, submit through `assets/js/form-kit.js` to a shared Google Apps Script Web App (deploy steps and the backend script are kept outside this public repo — see the sibling `littlepeoplemontessori-forms` directory).

To publish via GitHub Pages: Settings → Pages → deploy from `main`, root.
