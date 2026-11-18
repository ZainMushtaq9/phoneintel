# Ignorant Repository — Security Audit & Integration Decision

**Date:** 2026-11-18
**Audited repo:** [megadose/ignorant](https://github.com/megadose/ignorant) v1.2 (GPLv3)
**Reference clone (read-only, unmodified):** `~/workspace/phone-repos/ignorant`
**Auditor:** PhoneIntel — static code review only.
**Method:** every file in the repository was read in full. No module was
executed, no request was sent to any third-party service, and no check was
run against any real phone number or account at any point in this audit.

## Verdict (read this first)

**Nothing from Ignorant was integrated into PhoneIntel — because there is
nothing safe in it that PhoneIntel does not already do better.**

The audit found that Ignorant's entire functional content is
phone-number-to-account enumeration, and that it contains **zero** phone
validation, formatting, or metadata logic of its own: it does not use
`phonenumbers` or any numbering-plan data at all — it takes raw strings
from the command line and concatenates `country_code + phone`. Every
"safe feature" it was hoped to contribute (input validation,
normalization, formatting, country/calling-code identification, public
metadata) simply does not exist in its code. PhoneIntel already covers
all of those through Google's libphonenumber (the `phonenumbers` Python
library), with strictly more capability and correct data.

Forcing an integration would have meant either (a) duplicating
`phonenumbers` functionality in a worse form, or (b) shipping the
enumeration itself under a new name. Both were rejected. The honest
finding is: **no meaningful safe component can be extracted.**

> PhoneIntel provides privacy-respecting phone-number analysis. It does
> not identify private social-media accounts, enumerate registrations or
> access restricted personal information.

No `modules/ignorant_safe/` was created and no new "Phone Intelligence
(Ethical Mode)" UI section was added, because there is no genuinely new
functionality to put in them. The existing Phone Lookup tab already does
everything such a section would show. No code in `app.py`, `templates/`,
`netlify/` or `requirements.txt` was changed by this audit.

## 1. Repository inventory

| File | Lines (approx.) | What it is |
| --- | --- | --- |
| `ignorant/core.py` | ~195 | CLI entry point, module loader, orchestration, result printing, self-update |
| `ignorant/instruments.py` | 9 | Trio progress-bar instrument (tqdm) |
| `ignorant/localuseragent.py` | 1 (huge) | JSON blob of old browser User-Agent strings |
| `ignorant/modules/shopping/amazon.py` | ~35 | Amazon login-form account check |
| `ignorant/modules/social_media/instagram.py` | ~50 | Instagram private-API account check |
| `ignorant/modules/social_media/snapchat.py` | ~75 | Snapchat registration-endpoint account check |
| `ignorant/__init__.py`, `ignorant/modules/__init__.py`, `ignorant/modules/shopping/__init__.py`, `ignorant/modules/social_media/__init__.py` | 0 each | Empty package markers |
| `setup.py` | ~25 | Packaging metadata; deps: `termcolor`, `bs4`, `httpx`, `trio`, `argparse`, `tqdm` |
| `README.md`, `LICENSE` (GPLv3), `FUNDING.yml`, `.gitignore` | — | Docs / legal / meta only |

## 2. Component categorization

### PROHIBITED — must be excluded (account enumeration)

| Component | Why it is prohibited |
| --- | --- |
| `amazon()` in `modules/shopping/amazon.py` | Submits the target phone number to Amazon's sign-in form (`POST https://www.amazon.com/ap/signin/`) and infers account existence from the `auth-password-missing-alert` element. Login-flow account enumeration. It also sends the target's number to Amazon's authentication system, which can trigger owner-facing security notifications. |
| `instagram()` in `modules/social_media/instagram.py` | POSTs the target number to Instagram's private `i.instagram.com/api/v1/users/lookup/` endpoint, impersonating the official Android app (forged `Instagram 101.0.0.15.120` User-Agent, HMAC-signed body) using a **hard-coded leaked Instagram signing key** (`IG_SIG_KEY`). Private-API abuse + app impersonation + account enumeration. The hard-coded key must never be copied, reused, or published anywhere. |
| `snapchat()` in `modules/social_media/snapchat.py` | Harvests an `xsrf_token` cookie from `accounts.snapchat.com`, then POSTs the target number to `accounts.snapchat.com/accounts/validate_phone_number` and reads `TAKEN_NUMBER` vs `OK`. Registration-endpoint account enumeration. |
| `maincore()` / `main()` / `launch_module()` in `core.py` | The orchestration whose only purpose is to run the three enumeration modules concurrently (trio nursery) and print which services the number is registered on. |
| `import_submodules()` / `get_functions()` in `core.py` | Dynamic loader whose only purpose is discovering and loading the enumeration modules. A generic plugin pattern, but PhoneIntel has three fixed features and no need for a plugin system; importing the loader would only serve the enumeration. |

### RESTRICTED — not integrated (evasion / dangerous patterns)

| Component | Why it was excluded |
| --- | --- |
| `localuseragent.py` (User-Agent pool) | Its only function is rotating browser identities so the automated enumeration requests evade bot detection and rate limiting. UA rotation to dodge platform controls is itself a prohibited bypass technique. The strings are also stale (Chrome 24–41, Firefox 17–40, IE, Opera 11–12, Safari 5 — circa 2013–2015); decade-old User-Agents are a bot signal today, not cover. PhoneIntel's username checker uses one honest, modern User-Agent and needs no rotation. |
| `check_update()` in `core.py` | Phones home to `pypi.org`, then silently runs `pip install --upgrade ignorant` via subprocess with no signature verification. An auto-update mechanism that executes package installs as the user is a supply-chain risk and has no place in a webapp. |
| `convert_to_country_code` dict in `snapchat.py` | The only separable data in the repo: a calling-code → country mapping. It is lossy and partly wrong (`1` → `VI` instead of the NANP countries, `44` → `JE` instead of `GB`, `61` → `CX` instead of `AU`, `39` → `VA` instead of `IT`, `47` → `SJ` instead of `NO`, `7` → `RU` only, dropping Kazakhstan). `phonenumbers.region_code_for_number()` already does this correctly for every number. Duplicative and inferior — excluded. |
| `print_result()` / `credit()` in `core.py` | Terminal colour output and author/donation banner for the CLI. PhoneIntel is a web app with JSON responses; there is nothing to reuse. |
| `instruments.py` (`TrioProgress`) | A trio instrument driving a tqdm CLI progress bar, triggered only by `launch_module` tasks. Tied to trio + CLI; PhoneIntel is synchronous Flask. No value. |
| `setup.py` (dependencies) | Declares `termcolor`, `bs4`, `httpx`, `trio`, `argparse`, `tqdm`. None are needed: PhoneIntel uses `requests` + Flask and has no async or HTML-parsing need. Adding them would add attack surface for zero benefit. |

### SAFE — examined, none integrated (nothing of value)

No component earned a SAFE verdict with genuine value. The closest
candidates were checked and rejected:

- **Input validation / normalization:** does not exist in Ignorant. It
  takes two raw CLI strings and concatenates them. PhoneIntel validates
  with `phonenumbers.parse()` and returns structured errors — strictly
  better.
- **Phone formatting:** does not exist in Ignorant (no `phonenumbers`
  import anywhere; verified by grep). PhoneIntel already formats E.164,
  international, national and RFC 3966.
- **Country / calling-code identification:** only the flawed
  `convert_to_country_code` dict (see RESTRICTED above).
- **Public metadata processing:** does not exist in Ignorant — it has no
  carrier, geocoder, timezone or numbering-plan code at all.
- **Structured result formatting:** Ignorant's output dict
  (`{"name", "domain", "method", "frequent_rate_limit", "rateLimit",
  "exists"}`) is the enumeration verdict itself — the `exists` field
  *is* the prohibited answer. It cannot be reused without the
  enumeration. PhoneIntel's JSON schema already covers its own results.
- **Error handling:** Ignorant uses bare `except:` clauses that swallow
  every error and mislabel any failure as `rateLimit: True`. That is an
  anti-pattern; PhoneIntel's explicit exception handling (400 for bad
  input, 502 for upstream failure) is better.
- **Modular provider architecture:** the module system exists only to
  host enumeration plug-ins. PhoneIntel's three fixed endpoints need no
  provider framework.
- **Logging / diagnostics:** Ignorant has none (only terminal prints).

## 3. Network endpoints (complete — found by static grep)

| Endpoint | Used by | Purpose | Verdict |
| --- | --- | --- | --- |
| `https://www.amazon.com/ap/signin` (GET + POST) | `amazon()` | Login-form enumeration | PROHIBITED |
| `https://i.instagram.com/api/v1/users/lookup/` (POST) | `instagram()` | Private-API enumeration | PROHIBITED |
| `https://accounts.snapchat.com` (GET) + `https://accounts.snapchat.com/accounts/validate_phone_number` (POST) | `snapchat()` | Registration enumeration | PROHIBITED |
| `https://pypi.org/pypi/ignorant/json` (GET) | `check_update()` | Version check → auto pip install | RESTRICTED (dangerous) |

No other network calls exist in the repository. No request to any of
these endpoints was made during this audit.

## 4. Security and privacy risks found

1. **Account enumeration by design.** All three site modules exist to
   reveal whether a phone number is registered on a service — private
   association data about a third party, obtained without that person's
   knowledge or consent. The README's claim that "ignorant does not
   alert the target phone number" is unverified, and the Amazon login
   attempt can in fact trigger owner-facing security notifications.
2. **Hard-coded leaked credential.** `instagram.py` embeds a real
   Instagram API signing key and forges the official app's identity.
   Reusing it would be credential misuse; it must never be copied into
   any codebase.
3. **Authentication-flow abuse.** The Amazon module drives a real
   sign-in flow and the Snapchat module drives a real registration
   validation flow with someone else's number.
4. **Evasion tooling.** `localuseragent.py` exists to disguise automated
   probing traffic; the README advises "Rate limit, just change your
   IP". Both are rate-limit/detection evasion.
5. **Unsafe self-update.** `check_update()` executes `pip install
   --upgrade` as the user with no verification — a supply-chain risk.
6. **Error masking.** Bare `except:` handlers hide all failures and
   misreport them as rate limits, which would corrupt any audit trail.
7. **No input validation.** Country code and phone number are used raw
   (string concatenation into request bodies) with no parsing or
   sanitisation.
8. **Licence (GPLv3).** Ignorant is GPL-3.0 licensed. Any code reuse
   would impose copyleft obligations on the combined work. Since no code
   was reused, no GPL obligations arise from this audit.

## 5. Baseline comparison — what PhoneIntel already does

| Capability the integration hoped to add | Ignorant | PhoneIntel (already, before this audit) |
| --- | --- | --- |
| Input validation | None (raw strings) | `phonenumbers.parse()` + structured 400 errors |
| Normalization / formatting | None | E.164, international, national, RFC 3966 |
| Country / calling-code ID | Flawed static dict | `region_code_for_number()` (correct, complete) |
| Carrier / region / timezone | None | `carrier`, `geocoder`, `timezone` from libphonenumber |
| Structured OSINT results | Enumeration verdict only | JSON API for phone, IP and username lookups |
| Error handling | Bare `except:` → fake "rate limit" | Typed errors: 400 bad input, 502 upstream failure |
| Rate limiting | None (advises changing IP) | None — see §7 recommendation |
| Phone-number logging | None (CLI prints the number to the terminal) | None — verified: submitted values do not appear in the server log |

## 6. Integration decision

**Integrated: nothing.**

- No `modules/ignorant_safe/` module was created. There is no safe,
  non-duplicative code to put in it; creating one would have meant
  either re-implementing `phonenumbers` poorly or shipping an empty
  shell for appearances.
- No "Phone Intelligence (Ethical Mode)" UI section was added. The
  existing Phone Lookup tab already provides every legitimate item such
  a section could show (formatting, country/calling code, validity,
  public numbering-plan metadata). A second section would duplicate the
  first and imply new capability where there is none.
- No dependencies were added; `requirements.txt` is unchanged.
- No existing feature was modified. Phone lookup, IP Tracker, Username
  Tracker and Show Your IP are untouched.

## 7. Security and privacy assessment of PhoneIntel (post-audit)

Verified by code inspection (grep over `app.py`, `netlify/app.js`,
templates) and by live testing (§8):

- **No enumeration is possible.** PhoneIntel contains no reference to
  any enumeration endpoint: no Amazon sign-in URL, no Instagram
  `users/lookup` URL, no Snapchat `validate_phone_number` URL, no
  signing key, no `TAKEN_NUMBER` logic. The only external endpoints are
  `ipwho.is` (IP geolocation), `api.ipify.org` (show your own IP),
  Google Maps links, and the username tracker's public profile URLs
  (HTTP status only, no page content, no login).
- **Prohibited functionality cannot be invoked.** There is no endpoint,
  parameter, or code path for number-to-account checks. Extra fields in
  a lookup request (e.g. `check_instagram`) are ignored; the response
  schema is unchanged. Requests to guessed enumeration paths
  (`/api/instagram-check`, `/api/snapchat-check`, `/api/ignorant`,
  `/api/account-check`, `/api/enumerate`) return 404.
- **No storage or logging of submitted data.** Phone numbers, IPs and
  usernames are processed in-memory per request and not stored. The
  server log was inspected after the test run: it contains no submitted
  phone number, IP, or username.
- **Input handling is strict.** Phone numbers must parse via
  libphonenumber; IPs must parse via `ipaddress`; usernames must match
  `^[A-Za-z0-9._-]{1,64}$` before being interpolated into URLs. All
  outbound calls have timeouts (8s ipwho.is, 6s per username site).
- **No secrets anywhere.** No API keys exist in the app; nothing
  sensitive is in frontend JS or the repo.
- **Known gap (pre-existing, out of scope, not introduced here):**
  PhoneIntel has no rate limiting on its API endpoints — five rapid
  repeat requests all return 200. This was true before the audit and is
  unrelated to Ignorant. If the app is ever exposed beyond personal use,
  adding a simple per-IP rate limit (e.g. Flask-Limiter) is recommended.

## 8. Test results (2026-11-18, branch `ethical-ignorant-audit`)

Server started from the existing workspace venv, tested, stopped. All
tests use the reserved fictional `+1 202-555-0140` range, Google's
public DNS `8.8.8.8`, and the public username `github` — no real
person's number was used.

| # | Test | Result |
| --- | --- | --- |
| 1 | Homepage `GET /` | 200 |
| 2 | `POST /api/lookup` `+1 202-555-0140` | valid, US, Washington D.C., all 4 formats — unchanged |
| 3 | `POST /api/lookup` `+92 300 1234567` | valid, Mobile, PK, carrier Jazz |
| 4 | `POST /api/lookup` `"not-a-number"` | 400, clean error |
| 5 | `POST /api/lookup` `""` (empty) | 400, clean error |
| 6 | `POST /api/lookup` `"+999 123"` (malformed) | 400, clean error |
| 7 | `POST /api/lookup` `{}` (missing field) | 400, clean error |
| 8 | `POST /api/ip-lookup` `8.8.8.8` | Google LLC, San Jose CA, AS15169, America/Los_Angeles |
| 9 | `POST /api/ip-lookup` `192.168.1.1` (private) | 400 "Reserved range" |
| 10 | `POST /api/ip-lookup` `999.999.999.999` | 400, clean error |
| 11 | `GET /api/my-ip` | 200, returned caller IP |
| 12 | 5× rapid repeat `POST /api/lookup` | 200 × 5 (no rate limiting — see §7 gap) |
| 13 | `POST /api/lookup` with extra `check_instagram` / `check_snapchat` / `enumerate` fields | Extra fields ignored; response keys identical to a normal lookup |
| 14 | `POST /api/instagram-check`, `/api/snapchat-check`, `/api/ignorant`, `/api/account-check`, `/api/enumerate` | 404 each — no such endpoints |
| 15 | `POST /api/username-lookup` `"github"` | 19 sites: 12 found, 0 not found, 7 unknown |
| 16 | `POST /api/username-lookup` `"bad user!"` | 400, clean error |
| 17 | Server-log inspection after all tests | No submitted phone number, IP or username present in the log |
| 18 | Grep: enumeration markers in PhoneIntel code | None found (no Amazon/Instagram/Snapchat enumeration URLs, keys, or verdict logic) |

No API failures or network timeouts were observed during this run; the
app's existing handling for those cases (502 with a clear message for
ipwho.is failures, per-site `unknown` status with 6s timeout for the
username checker) is unchanged from the previously tested code.

## 9. Deployment compatibility

- **No code changed**, so there is nothing to deploy and nothing can
  regress. The static Netlify build (`netlify/`) is untouched and its
  documented limits are unchanged (no carrier data, approximate
  timezone, country-level location, no username checking).
- **No new Python-only features** were added, so no new
  Flask-vs-static gap exists. No CORS limits are newly involved.
- **No new backend dependency** was introduced; `requirements.txt` is
  unchanged.
- The only changes on this branch are documentation (`docs/` +
  `README.md`). Merging them to `main` would trigger a Netlify
  auto-deploy of an identical site (docs do not affect the published
  `netlify/` folder).
- If a future integration ever adds a Python-only feature, it must be
  labelled as such in the UI and README, as the Username Tracker
  already is.

## 10. Files changed on this branch

- **Created:** `docs/ignorant-audit.md` (this file).
- **Modified:** `README.md` (added a short "Ignorant audit" section
  linking here; no other content changed).
- **Not created:** `modules/ignorant_safe/` (nothing passed the audit
  with genuine value), no new UI section, no new API endpoint.
- **Not modified:** `app.py`, `templates/`, `static/`, `netlify/`,
  `netlify.toml`, `requirements.txt`, `.gitignore`.
- **Reference clone untouched:** nothing under
  `~/workspace/phone-repos/ignorant` was modified (verified: the audit
  only read files).

## 11. Reproducing this audit

```bash
# Read-only clone (already present locally)
ls ~/workspace/phone-repos/ignorant/ignorant/

# Confirm Ignorant has no phone-number logic of its own
grep -rn 'phonenumbers' ~/workspace/phone-repos/ignorant --include='*.py'
# → no matches

# List every network call Ignorant makes
grep -rn 'client\.\(get\|post\)\|httpx\.\(get\|post\)' \
  ~/workspace/phone-repos/ignorant --include='*.py'

# Confirm PhoneIntel contains no enumeration code
grep -rniE 'amazon\.com/ap/signin|i\.instagram\.com/api|validate_phone_number|IG_SIG_KEY|TAKEN_NUMBER' \
  ~/workspace/phone-intel-webapp --include='*.py' --include='*.js' \
  --include='*.html' --exclude-dir=venv --exclude-dir=.git
# → no matches
```

Do not execute Ignorant's modules or run checks against real services:
every one of its site modules sends a real person's number to a real
authentication/registration endpoint.
