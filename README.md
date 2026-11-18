# PhoneIntel — Phone Number OSINT Investigation

A real, working phone-number OSINT investigation webapp. Enter a
phone number, confirm consent, press **Start Investigation** — the
backend really executes the analysis modules in parallel and combines
them into one report. Every module returns a structured result with a
status, its data source, a timestamp, a confidence note and error
details. Nothing is fabricated: a module that cannot run says so.

Inspired by the phone-number OSINT repos Phoneinfoga, GhostTrack,
PhoneNumberKit and ignorant — but built as a **legitimate** tool: no
account probing, no live location tracking, no extracting phone
numbers from social media. Full audit of all four repos:
[`docs/repo-audits.md`](docs/repo-audits.md) (and the dedicated
[`docs/ignorant-audit.md`](docs/ignorant-audit.md)).

## Architecture ($0 — no paid anything)

| Part | Runs on | What it does |
|---|---|---|
| Frontend (`docs/`) | **GitHub Pages** (static, from the `docs/` folder) | Investigation interface, live progress, module cards, retry, JSON + PDF export (jsPDF, client-side), Username Tracker UI. If the API is unreachable it falls back to offline in-browser analysis and says so. |
| API (`workers/`) | **Cloudflare Workers** (free tier, JavaScript) | Full investigation engine: phone lookup (`google-libphonenumber`), OVH zones, IP lookup (ipwho.is), username checks (server-side fetch), `my-ip`. CORS-enabled for the Pages frontend. No API keys, no secrets. |
| Reference backend (`app.py`) | **Local development only — not deployed** | The original Flask backend. Same API and report shape, plus carrier lookup and a server-side PDF endpoint. Kept as the Python reference and for local testing. Workers cannot execute Python or Go; nothing here is part of the deployed stack. |

The frontend and backend are independently deployable. The static
`netlify/` build from the earlier deployment is still in the repo
and still served by Netlify; it is retired separately once the Pages
deployment is verified (see `netlify/` — do not delete it here).

## Investigation workflow

1. Enter an international phone number (with `+` country code, or pick
   a country from the selector for numbers without one).
2. Optionally add an IP address for IP Intelligence (a phone owner's
   IP is never inferred from their number).
3. Confirm the investigation consent checkbox.
4. Press **Start Investigation**. Modules run in parallel; each card
   shows its own status live. Failed modules have a **Retry** button.
5. Export the report as JSON (in-browser) or PDF (jsPDF, in-browser).

If the Worker API is not configured or unreachable, the page runs
the investigation offline in the browser (phone analysis via the
`google-libphonenumber` CDN library, IP via ipwho.is, OVH zones
directly) and labels the report "Offline mode". Username checking
cannot run offline (browsers cannot read other sites' HTTP status),
so that tab explains it needs the API.

## Modules and statuses

Every module reports one of: `SUCCESS`, `PARTIAL`, `NOT AVAILABLE`,
`FAILED`, `NOT SUPPORTED`.

| Module | What it really does | Source |
|---|---|---|
| A. Number Information | Parse, validate, formats (E.164 / international / national / RFC 3966), country, country code, national number, type, validity | libphonenumber, offline |
| B. Carrier Information | **NOT AVAILABLE in the deployed stack** — the JavaScript libphonenumber bundle has no carrier mapper. The Flask reference backend does return carrier data where the numbering-plan database provides it. | — |
| C. Public OSINT | 45 Google dork query links (social media, disposable SMS providers, reputation, individuals, general) | Phoneinfoga dork patterns — **links only, nothing fetched** |
| D. Technical Information | Timezone(s) (region-level approximation), geographic description (country-level), confidence + source limitations. Always `PARTIAL` in the deployed stack — the JS bundle has no per-number timezone data or city geocoder. | libphonenumber + region timezone table |
| E. IP Intelligence | Country, region, city, coordinates, ISP, org, ASN, timezone for an IP you provide | ipwho.is free API (no key) |
| OVH Number Zones | Matches the number's range against OVH's published zones (city/ZIP) — FR, BE, GB, ES, CH only | OVH public API (no key), cached 1h |
| Username Tracker | Checks whether a username's public profile URL exists on 19 social sites (HTTP status only) | Worker server-side checks (Workers fetch has no CORS limitation) |
| Numverify Lookup | **NOT SUPPORTED** — needs a Numverify API key (not configured) | — |
| Google Custom Search | **NOT SUPPORTED** — needs a Google API key + CSE ID (not configured); use the Public OSINT links instead | — |
| Account Registration Check | **NOT SUPPORTED by policy** — account enumeration is excluded; see `docs/ignorant-audit.md` | — |

What this app never does: live GPS tracking, home-address or identity
lookup from a number, account enumeration, extracting numbers from
social accounts. A valid number format does not prove an active
subscriber — the report says so wherever it matters.

## Why libphonenumber? How the four repos map to this app

The repos from the reel can't be imported into a JS/Python app directly:

- **Phoneinfoga** is written in **Go** — it needs a Go binary to run,
  so none of it can execute on Pages or in a Worker. Its offline
  layer (local scanner) is exactly what libphonenumber provides; its
  OVH scanner and Google-dork generator are re-implemented here from
  its verified behaviour; its keyed scanners (Numverify, Google CSE)
  are reported NOT SUPPORTED. See the runtime-limits section in
  [`docs/repo-audits.md`](docs/repo-audits.md).
- **PhoneNumberKit** is written in **Swift** (for iOS), frozen at
  4.3.0 and unmaintained. `google-libphonenumber` (JS) is the
  equivalent engine used by the deployed stack; `phonenumbers` is
  the Python equivalent used by the Flask reference backend.
- **GhostTrack** is Python, and its Phone Tracker is literally the
  same libphonenumber calls this app uses — verified by reading its
  `GhostTR.py`. Its IP Tracker (ipwho.is) and Username Tracker
  (profile-URL status checks) are re-implemented here. The
  re-implemented parts need no separate runtime (plain HTTP +
  libphonenumber logic); only GhostTrack's own CLI is Python-only.
- **ignorant** is Python, but its whole purpose is checking whether a
  phone number is registered on Instagram, Snapchat, Amazon and other
  services — number-to-account probing. Deliberately not included;
  see `docs/ignorant-audit.md` for the full audit finding (it also
  contains zero reusable phone logic).

Read-only reference clones of all four repos live in
`~/workspace/phone-repos/` (not part of this repo).

## Run it locally

### Option A — the deployed stack (Pages frontend + Worker API)

```bash
cd workers
npm install
npm run dev          # Worker API at http://127.0.0.1:8787
```

In another terminal, serve the frontend and point it at the local
Worker (temporarily set `window.PHONEINTEL_WORKER_URL` in
`docs/config.js` to `http://127.0.0.1:8787` — remember to restore
it before committing):

```bash
cd docs
python3 -m http.server 8001   # open http://127.0.0.1:8001
```

Note: in some sandboxes workerd cannot reach the public internet
directly (it does not use the shell's HTTP proxy), so the Worker's
IP/OVH/username modules report FAILED there. That is a local-dev
environment limit, not a code bug — on Cloudflare's edge the
Worker's fetches go directly to the internet. For local testing of
the IP/OVH success paths, `workers/test/mock-upstream.mjs` serves
mock ipwho.is/OVH responses; see
[`workers/README.md`](workers/README.md).

### Option B — the Flask reference backend (local only)

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py                   # open http://127.0.0.1:5000
```

Same API and report shape as the Worker, plus carrier lookup and a
server-side PDF endpoint (`POST /api/export/pdf`). Not deployed.

## API

The Worker and the Flask backend serve the same endpoints and the
same response shapes (the Flask backend additionally serves
`POST /api/export/pdf`; the deployed stack exports PDF client-side
with jsPDF).

### `POST /api/investigate` — run a full investigation

```bash
curl -X POST http://127.0.0.1:8787/api/investigate \
  -H "Content-Type: application/json" \
  -d '{"number": "+1 202-555-0140", "country": "", "ip": "8.8.8.8", "consent": true}'
```

Body: `number` (required), `country` (optional ISO code, used only
when the number has no `+` code), `ip` (optional, for IP
Intelligence), `consent` (required, must be `true`).

Response: `{"success": true, "duplicate": false, "data": {report}}`.
The report has `investigation_id`, `timestamp`, `input`, `summary`
(status counts) and `modules` (one structured result per module).
Identical requests within 60 seconds return the cached report with
`"duplicate": true` instead of re-running modules. Rate limit:
10/minute per IP.

(`+1 202-555-0140` is from the reserved fictional 555 range — safe
to use as a demo number. Never test with a real person's number.)

### `POST /api/module/<name>` — retry one module

Names: `number`, `carrier`, `technical`, `ovh`, `public_osint`, `ip`.
Same body as `/api/investigate` (`number` not needed for `ip`).
Returns `{"success": true, "module": {...}}`. Rate limit: 20/minute.

### Single-purpose endpoints (kept, unchanged behaviour)

```bash
# Phone lookup (8.8.8.8 = Google's public DNS, safe demo IP)
curl -X POST http://127.0.0.1:8787/api/lookup \
  -H "Content-Type: application/json" \
  -d '{"number": "+1 202-555-0140"}'

curl -X POST http://127.0.0.1:8787/api/ip-lookup \
  -H "Content-Type: application/json" \
  -d '{"ip": "8.8.8.8"}'

curl -X POST http://127.0.0.1:8787/api/username-lookup \
  -H "Content-Type: application/json" \
  -d '{"username": "github"}'

curl http://127.0.0.1:8787/api/my-ip
curl http://127.0.0.1:8787/api/health
```

Rate limit on the lookup endpoints: 30/minute per IP. JSON export
is done in the browser (the report downloads directly) and needs no
endpoint; PDF export is client-side (jsPDF).

## Deployment (preparation only — not deployed yet)

### Frontend → GitHub Pages

The `docs/` folder is the Pages source. Enable Pages in the repo
settings: **Settings → Pages → Build and deployment → Deploy from
a branch → branch `investigation-app` (or `main` after merge),
folder `/docs`**. No build step, no Actions workflow needed. The
site is then served at
`https://<user>.github.io/phoneintel/`.

### Backend → Cloudflare Workers

```bash
cd workers
npm install
npx wrangler login      # first time only: free Cloudflare account,
                        # approve in the browser (or set
                        # CLOUDFLARE_API_TOKEN instead)
npm run deploy          # deploys to https://phoneintel.<subdomain>.workers.dev
```

Then set that URL in `docs/config.js`
(`window.PHONEINTEL_WORKER_URL`) and commit — the Pages frontend
calls it from then on. Until `config.js` is set, the site runs in
offline mode (see above). No API keys, no secrets, no KV, no
Durable Objects; `wrangler.toml` is ready. Full notes (including
free-tier limits): [`workers/README.md`](workers/README.md).

## Security and privacy

- Rate limiting on all API endpoints. Worker: per-IP sliding window
  in memory (KV-free, free-tier-safe) — best-effort, because each
  Worker isolate keeps its own counters; a Durable Object counter
  would be the robust upgrade. Flask: Flask-Limiter, in-memory.
- Duplicate-request protection: identical investigations within 60
  seconds are served from an in-memory cache keyed by a hash of the
  inputs — never persisted, never logged.
- Timeouts on all outbound calls (IP 8s, OVH 20s, username 6s/site).
- Input validation everywhere (libphonenumber parsing, IP parsing,
  strict username regex); secure error handling (no tracebacks in
  responses); 64 KB request-body cap.
- No storage of submitted numbers, IPs or usernames; no submitted
  data in logs. Investigation results live only in the user's
  browser.
- No API keys anywhere in this build, and no secrets in frontend
  JavaScript. The Worker sends `Access-Control-Allow-Origin: *`
  (public API, no credentials).

## Licenses of the reference repos

- Phoneinfoga — GPLv3. PhoneIntel re-implements its verified
  behaviour (local analysis, OVH zones, dork links) in original code;
  no Phoneinfoga code is copied.
- GhostTrack — no licence file. Behaviour re-implemented with
  attribution; no code copied.
- PhoneNumberKit — MIT. Not used as code (Swift); its function is
  covered by the libphonenumber libraries.
- ignorant — GPLv3. Nothing reused (see `docs/ignorant-audit.md`).

PhoneIntel's own code is original. `google-libphonenumber` and
`phonenumbers` are Apache-2.0 (Google libphonenumber data).

## Limits

- The number must include its country code (e.g. `+92 …`, `+44 …`),
  or a country must be picked from the selector.
- "Location" is only the approximate area from the public numbering
  plan — never a live position.
- Carrier data is not available in the deployed stack (JS bundle has
  no carrier mapper); the Flask reference backend returns it where
  the numbering-plan database provides it.
- Timezone is a region-level approximation in the deployed stack;
  the Flask backend returns per-number timezones.
- OVH zones cover only France, Belgium, UK, Spain, Switzerland.
- IP geolocation shows where an IP is registered (often the ISP's
  city), not the device's live position. Private/reserved IPs cannot
  be looked up.
- Username "Found" means the profile URL responded with HTTP 200;
  some sites return 200 even for missing profiles, and some block
  automated checks (those show as "Unknown").
