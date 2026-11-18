# PhoneIntel API — Cloudflare Worker

The investigation API as a Cloudflare Worker (JavaScript, free
tier). Same endpoints and report shape as the Flask reference
backend (`../app.py`), minus carrier lookup and the server-side PDF
endpoint (see "Honest limits" below).

## Endpoints

| Method | Path | Purpose | Rate limit |
|---|---|---|---|
| GET | `/api/health` | Health check | — |
| POST | `/api/investigate` | Full investigation (`{number, country?, ip?, consent: true}`) | 10/min per IP |
| POST | `/api/module/<name>` | Retry one module (`number`, `carrier`, `technical`, `ovh`, `public_osint`, `ip`) | 20/min per IP |
| POST | `/api/lookup` | Single phone lookup | 30/min per IP |
| POST | `/api/ip-lookup` | Single IP lookup (ipwho.is) | 30/min per IP |
| POST | `/api/username-lookup` | Username check across 19 sites (status only) | 30/min per IP |
| GET | `/api/my-ip` | Caller's IP (`CF-Connecting-IP`) | — |

All responses are JSON in the shape
`{success: true, data: ...}` / `{success: false, error: "..."}`.
CORS: `Access-Control-Allow-Origin: *` (public API, no
credentials), with OPTIONS preflight handled. PDF export is
client-side (jsPDF in the Pages frontend) — there is no
`/api/export/pdf` here.

## Deploy

```bash
npm install
npx wrangler login      # first time only
npm run deploy
```

**Auth needed for deploy:** a free Cloudflare account. `wrangler
login` opens a browser approval (OAuth); alternatively set
`CLOUDFLARE_API_TOKEN` (an API token with Workers deploy permission
for the account) and `CLOUDFLARE_ACCOUNT_ID`. No other secrets: no
API keys, no KV, no Durable Objects, no environment variables are
required in production.

The Worker deploys to `https://phoneintel.<your-subdomain>.workers.dev`
(`name = "phoneintel"` in `wrangler.toml`). After deploying, put
that URL in `../docs/config.js` (`window.PHONEINTEL_WORKER_URL`) so
the GitHub Pages frontend calls it.

## Local development

```bash
npm install
npm run dev    # http://127.0.0.1:8787 (no login needed)
```

### Sandbox egress note

In some sandboxes workerd cannot reach the public internet directly
(it does not use the shell's HTTP proxy), so the IP/OVH/username
modules report FAILED under `wrangler dev` there. That is a
local-dev environment limit, not a code bug — on Cloudflare's edge
the Worker's fetches go directly to the internet, and the failure
paths are the designed honest behaviour (FAILED status + reason, the
report still completes). To verify the IP/OVH success paths locally,
run the mock upstream:

```bash
node test/mock-upstream.mjs &   # serves mock ipwho.is/OVH on :8899
# .dev.vars (local only, gitignored) points the Worker at it:
#   IPWHOIS_BASE=http://127.0.0.1:8899/ipwho
#   OVH_BASE=http://127.0.0.1:8899/ovh
npm run dev
```

The mock's fixture data is real observed data (the OVH Abbeville
zone and the Google DNS record were both returned by the live APIs
during Flask-backend testing). The username module cannot be mocked
this way (it fetches 19 real domains); it was verified against the
live sites by running the same module code in Node.

## Files

| File | Contents |
|---|---|
| `src/index.js` | Fetch handler: routing, CORS, rate limiting, body parsing, error handling |
| `src/investigation.js` | Investigation engine: module runners, report assembly, 60-second dedup cache |
| `src/lookups.js` | Phone (google-libphonenumber), IP (ipwho.is), username (19 sites), OVH zones (1h cache) |
| `src/dorks.js` | Phoneinfoga Google-dork link builder (45 links; byte-identical to the Flask backend) |
| `src/data.js` | Region names, region timezones, number types, username site list, OVH countries |
| `test/mock-upstream.mjs` | Mock ipwho.is + OVH server for local testing (see above) |

## Honest limits (all reported in the results, never faked)

- **Carrier: NOT AVAILABLE.** The `google-libphonenumber` JS bundle
  has no carrier mapper. The Flask backend (Python `phonenumbers`)
  does carrier lookup.
- **Technical: PARTIAL.** Timezones are region-level approximations
  and location is country-level only — the JS bundle has no
  per-number timezone data or city geocoder.
- **Numverify / Google CSE: NOT SUPPORTED.** Paid API keys, not
  configured. **Account registration checks: NOT SUPPORTED** by
  policy (see `../docs/ignorant-audit.md`).

## Free-tier notes

- **Bundle size:** 603 KB minified, ~124 KB gzipped — under the
  Workers free 1 MiB compressed limit. (`google-libphonenumber`
  3.2.48 is the bulk of it.)
- **Subrequests:** a username lookup makes 19 parallel subrequests,
  under the 50-per-request free limit. An investigation makes at
  most 2 (OVH + IP).
- **Rate limiting is best-effort:** per-IP sliding windows kept in
  isolate memory (no KV, free-tier-safe). A request may land on any
  isolate, and each isolate keeps its own counters, so a determined
  abuser could spread requests across isolates. A Durable Object
  counter would be the robust upgrade.
- **Dedup cache** (60 s, keyed by SHA-256 of the inputs) and the
  **OVH zone cache** (1 h) are in-memory only and per-isolate;
  nothing is persisted, and no submitted data is logged.
