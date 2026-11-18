# Four-Repo Audit — PhoneIntel Investigation App

Date: 2026-11-18. Static review of the read-only reference clones in
`~/workspace/phone-repos/` (READMEs, source, dependencies), plus live
checks of the two keyless APIs Phoneinfoga uses (OVH zones, Google
dork URL format). No reference code was executed except reading it,
and no request was sent to any service except the two live API checks
noted below.

Summary: of the four repos in the reel, **none can be imported into
this app as a library** (two are written in other languages, one is
Python but its only function is prohibited here, and the fourth is
Python but its phone logic is just the same libphonenumber calls this
app already uses). What PhoneIntel takes from them is verified
behaviour, re-implemented in original JavaScript (deployed:
Cloudflare Worker + GitHub Pages frontend) and Python (Flask
local-development reference backend): the local number analysis, the
OVH zone lookup, the Google dork links, and the IP/username
trackers. Everything else is documented as NOT SUPPORTED with the
reason, and reported that way in the investigation results — never
faked. Section 5 lists what the free deployment architecture
(Pages + Workers) cannot run, and how each gap is reported.

## 1. Phoneinfoga — sundowndev/phoneinfoga (Go, GPLv3)

"What it is": "Information gathering framework for phone numbers"
(Go). CLI + web UI + REST API. **Stable but unmaintained** — its own
README says upcoming bugs won't be fixed and the repo could be
archived at any time. Architecture: five scanners in `lib/remote/`
behind a common scanner interface (`scanner.go`, `remote.go`,
registered in `init.go`). Each scanner was read in full:

| Scanner | What it really does | Needs | Verdict for PhoneIntel |
|---|---|---|---|
| `local` (`local_scanner.go`) | Offline info via `nyaruka/phonenumbers` (Go libphonenumber port): country, area, carrier, line type, formats | Nothing | **REAL — re-implemented.** Exactly what `google-libphonenumber` (JS, deployed) and `phonenumbers` (Python, Flask reference) provide. Powers the number / carrier / technical modules. |
| `googlesearch` (`googlesearch_scanner.go`) | Generates Google dork query URLs (45 dorks in 5 categories: social media, disposable SMS providers, reputation, individuals, general). **It fetches nothing** — it only builds `google.com/search?q=...` links. | Nothing | **REAL — re-implemented** as the Public OSINT module (Worker `workers/src/dorks.js`, Pages `docs/app.js`, Flask `build_dorks()`). Links only, labelled as links. URL format verified against Phoneinfoga's own test vectors (`googlesearch_scanner_test.go`); all three implementations produce byte-identical URLs. |
| `ovh` (`ovh_scanner.go` + `suppliers/ovh.go`) | Queries OVH's public telephony zones API (`api.ovh.com/1.0/telephony/number/detailedZones?country=xx`), matches the number's first 6 local digits + `xxxx` against published ranges, returns city/ZIP. Only country codes 33, 32, 44, 34, 41 (FR, BE, GB, ES, CH). | Nothing (keyless public endpoint) | **REAL — re-implemented and live-tested.** 2026-11-18: FR endpoint returned HTTP 200 with 412 zone entries; GB returned HTTP 200. PhoneIntel adds a 1-hour server-side cache (Phoneinfoga re-downloads the list on every scan) and reports other countries as NOT AVAILABLE. The endpoint also sends `Access-Control-Allow-Origin: *`, so the browser fallback can call it too. |
| `numverify` (`numverify_scanner.go` + `suppliers/numverify.go`) | Commercial lookup API (apilayer.com/numverify): validity, location, carrier, line type. `DryRun` fails without `NUMVERIFY_API_KEY`. | Paid API key | **NOT SUPPORTED.** No key is configured in this build. Reported as NOT SUPPORTED in every investigation, with the reason. |
| `googlecse` (`googlecse_scanner.go`) | Fetches real search results via Google Custom Search JSON API, running the same dork queries. `DryRun` fails without `GOOGLE_API_KEY` + `GOOGLECSE_CX`. | Google API key + CSE ID (paid beyond 100 queries/day) | **NOT SUPPORTED.** No keys configured. Reported as NOT SUPPORTED; users are pointed at the Public OSINT links, which run the same queries in their own browser. |

**Honest scope (its own README "Anti-features"):** does not claim
verified data; does **not** track a phone or its owner in real time;
does **not** give precise phone location; does **not** hack a phone.
PhoneIntel repeats these limits in its own UI and docs.

**Search-scraping note:** Phoneinfoga does not scrape Google results
anywhere — the only search-related scanner that fetches anything is
`googlecse`, which uses the official paid API. There is no working
keyless "fetch Google results" path in this repo, and PhoneIntel does
not pretend otherwise: the Public OSINT module is links, and
`googlecse` is NOT SUPPORTED.

## 2. GhostTrack — HunxByts/GhostTrack (Python, no licence file)

A single-file Python CLI (`GhostTR.py`) with four menu options: IP
Tracker, Show Your IP, Phone Number Tracker, Username Tracker.

- **Phone Tracker** is literally the same `phonenumbers` calls this
  app uses (`geocoder`, `carrier`, `timezone`, `is_valid_number`,
  `is_possible_number`, E.164/international/mobile formats) —
  verified by reading `GhostTR.py`. Default region is Indonesia
  (`"ID"`); PhoneIntel instead takes the region from the user's
  country selector, or requires the number to carry its own country
  code.
- **IP Tracker** calls the free `ipwho.is` API (no key) and prints
  country/city/region, latitude/longitude + Google Maps link, ASN,
  ISP, org, timezone. Its README suggests combining it with the
  "Seeker" tool to capture a target's IP — PhoneIntel does **not**
  include that; it only looks up an IP the user types in, and never
  infers a phone owner's IP from their number.
- **Username Tracker** checks whether a username's public profile URL
  exists on ~25 social sites by HTTP status. Dead services from its
  list (Periscope, StumbleUpon, Ello, We Heart It) are dropped in
  PhoneIntel. A "found" result means the URL responded (HTTP 200),
  not proof of an active account — some sites return 200 for missing
  profiles.
- **Verdict:** **re-implemented, not imported.** IP Tracker and
  Username Tracker are rebuilt here in the Worker (server-side, with
  timeouts and honest found/not-found/unknown states) and, for IP
  only, in the browser fallback; its Phone Tracker adds nothing
  beyond the libphonenumber calls already in use.

## 3. PhoneNumberKit — marmelroy/PhoneNumberKit (Swift, MIT)

Swift 5.3 framework for parsing, formatting and validating
international phone numbers, inspired by Google's libphonenumber.
Core files: `PhoneNumberUtility.swift`, `PhoneNumberParser.swift`,
`ParseManager.swift`, `MetadataManager.swift`, `Formatter.swift`,
`PartialFormatter.swift` (as-you-type formatting), `PhoneNumber.swift`.

**Status warning:** this repository is **frozen at 4.3.0 and no
longer maintained** — its README says active development moved to the
PhoneNumberKit organisation (5.0.0+) and its validation metadata
will drift out of date. Any new work should use the maintained
`google-libphonenumber` (JS) / `phonenumbers` (Python) ports, which
track current libphonenumber metadata.

**Verdict:** **cannot be imported** — it is Swift for iOS. Its entire
function (parse, normalise, format, validate, country-code ↔
country-name conversion, using libphonenumber metadata) is covered by
`google-libphonenumber` in the deployed stack (Worker + Pages
frontend) and `phonenumbers` in the Flask reference backend.

## 4. Ignorant — megadose/ignorant (Python, GPLv3)

**Full report:** [`ignorant-audit.md`](ignorant-audit.md) (branch
`ethical-ignorant-audit`, commit `a5fc609`). Static review only —
no module was executed and no request was sent.

**Finding:** its entire functional content is checking whether a
phone number is registered on Instagram, Snapchat and Amazon
(login/registration-endpoint enumeration, including a hard-coded
leaked Instagram signing key) — all prohibited in this project. It
contains **zero** phone validation, formatting or metadata logic of
its own (verified by grep: no `phonenumbers` use at all). Its only
separable piece, a calling-code → country table, is partly wrong
(`44` → `JE`, `61` → `CX`, `1` → `VI`) and is superseded by
`phonenumbers`.

**Verdict:** **nothing integrated, correctly.** No ignorant code or
behaviour is in PhoneIntel. The investigation report lists an
"Account Registration Check" module with status NOT SUPPORTED and
the policy reason, so the absence is explicit rather than silent.
Do not re-attempt it without a new decision.

## Coverage map — where each repo's legitimate function lives

| Repo function (legitimate part) | PhoneIntel location |
|---|---|
| Parse / validate / format numbers (Phoneinfoga local scanner, PhoneNumberKit, GhostTrack phone tracker) | Worker: `workers/src/lookups.js` `lookupNumber()` via `google-libphonenumber`; Pages fallback: `docs/app.js` `lookup()`; Flask reference: `app.py` `lookup_number()` via `phonenumbers` |
| OVH number zones (Phoneinfoga OVH scanner) | Worker: `workers/src/investigation.js` `runOvhModule()` (cached, 1h); Pages fallback: `docs/app.js` `localOvhModule()`; Flask: `app.py` `run_ovh_module()` |
| Google dork links (Phoneinfoga googlesearch scanner) | Worker: `workers/src/dorks.js`; Pages: `docs/app.js` `buildDorks()`; Flask: `app.py` `build_dorks()` — links only in all three, byte-identical URLs |
| IP geolocation + ISP/ASN (GhostTrack IP Tracker) | Worker: `workers/src/lookups.js` `lookupIp()` via free ipwho.is API; Pages fallback: `docs/app.js` `localIpModule()` (browser fetch); Flask: `app.py` `lookup_ip()` |
| Username public-profile checks (GhostTrack Username Tracker) | Worker: `workers/src/lookups.js` `lookupUsername()` (server-side only; the browser cannot do this — CORS) |
| Numverify / Google CSE (Phoneinfoga, keyed scanners) | NOT SUPPORTED, reported with reasons in every investigation |
| Ignorant | Nothing — see §4 and `ignorant-audit.md` |

## 5. Runtime limits under the free architecture (Pages + Workers)

The deployed stack is GitHub Pages (static HTML/JS) + Cloudflare
Workers (JavaScript only, free tier). Nothing in it can execute Go,
Python or Swift, and nothing in it may need a paid API key. What
that means per repo:

- **Phoneinfoga — every component needs a separate runtime.**
  Phoneinfoga is a Go binary: its CLI, web UI, REST API and all five
  scanners run only as compiled Go. None of it can execute on Pages
  or in a Worker. What PhoneIntel ships is a from-scratch
  re-implementation of its *verified behaviour* in JavaScript
  (local analysis via libphonenumber, OVH zones via HTTP, dork links
  via string building) — not its code, not its binary. On top of the
  runtime gap, its two remote scanners need paid API keys
  (Numverify, Google CSE), so they are NOT SUPPORTED even where a
  runtime existed.
- **GhostTrack — none of the re-implemented parts need a separate
  runtime.** Its phone tracker is libphonenumber logic, its IP
  tracker is a plain HTTP call to ipwho.is, and its username tracker
  is plain HTTP status checks — all three run natively in a Worker
  (and the first two also in the browser). Only GhostTrack's own CLI
  program is Python-only, and PhoneIntel does not use it.
- **PhoneNumberKit — Swift-only, cannot run anywhere in this stack.**
  Covered by `google-libphonenumber` (JS), the same engine, which
  bundles into the Worker (verified: 603 KB minified, ~124 KB
  gzipped — under the Workers free 1 MiB compressed limit) and loads
  from a CDN in the browser.
- **ignorant — excluded by policy** (see §4), independent of runtime.

### What the deployed stack reports as NOT AVAILABLE (with reasons)

These are genuine gaps of the free JavaScript architecture, reported
explicitly in every investigation — never silently dropped, never
faked:

| Gap | Reported as | Reason |
|---|---|---|
| Carrier lookup | Carrier module: `NOT AVAILABLE` | The `google-libphonenumber` JS bundle does not ship the carrier mapper. The Flask reference backend (Python `phonenumbers`) does return carrier data. |
| Per-number timezone | Technical module: `PARTIAL` | The JS bundle has no per-number timezone data; timezones come from a region-level table, labelled approximate. Flask returns per-number timezones. |
| City/area geography | Technical module: `PARTIAL` | The JS bundle has no city/area geocoder; location is country-level only. Flask can show a city/area for some numbers. |
| Username checking in the browser fallback | Username tab: explanatory note | Browsers cannot read other sites' HTTP status (CORS). Works through the Worker API. |
| Numverify / Google CSE | `NOT SUPPORTED` | Paid API keys, not configured (see §1). |
| Account registration checks | `NOT SUPPORTED` | Excluded by policy (see §4). |
