// PhoneIntel frontend configuration.
//
// Set WORKER_URL to the deployed Cloudflare Worker URL after running
// `npm run deploy` in ../workers, e.g.:
//   window.PHONEINTEL_WORKER_URL = 'https://phoneintel.<your-subdomain>.workers.dev';
//
// Until then the placeholder below keeps the page in offline mode:
// phone analysis runs in the browser (via the libphonenumber CDN
// library), IP lookup and OVH zones still work from the browser, and
// the Username Tracker explains that it needs the API. Nothing is
// faked in either mode — the page always says which mode it is in.
window.PHONEINTEL_WORKER_URL = 'https://phoneintel.YOUR-SUBDOMAIN.workers.dev';
