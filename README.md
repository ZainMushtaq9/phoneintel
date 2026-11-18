# PhoneIntel

A phone number intelligence webapp (Flask + Python). Enter a phone number
with its country code and get an offline analysis: validity, number type,
country/region, carrier, timezone(s), and all standard formats. It also
includes GhostTrack's IP Tracker and Username Tracker (see below).

Inspired by the phone-number OSINT repos Phoneinfoga, GhostTrack,
PhoneNumberKit and ignorant — but built as a **legitimate** tool: no
account probing, no live location tracking, no extracting phone numbers
from social media.

## What it does

- **Phone Lookup** (tab 1, fully offline): parses, validates and formats
  numbers using the `phonenumbers` library (the Python port of Google's
  libphonenumber). Shows: valid / possible checks, number type (mobile,
  fixed line, VOIP…), region code, approximate location from the public
  numbering plan, carrier name, timezone(s), country code, national
  number, and E.164 / international / national / RFC 3966 formats.
- **IP Tracker** (tab 2): looks up a public IP address via the free
  ipwho.is API (no key) — country, city, region, coordinates + Google
  Maps link, ISP, organisation, ASN, timezone and calling code. Also
  shows your own IP, with a one-click lookup of it.
- **Username Tracker** (tab 3): checks whether a username's public
  profile URL exists on 19 social sites (Facebook, X, Instagram,
  LinkedIn, GitHub, Pinterest, Tumblr, YouTube, SoundCloud, Snapchat,
  TikTok, Behance, Medium, Quora, Flickr, Twitch, Dribbble, Telegram,
  Product Hunt). HTTP status only — no login, no page content is read.
  "Found" means the profile URL responded (HTTP 200); some sites return
  200 even for missing profiles, so it is not proof of an active
  account.
- Single-page dark UI with three tabs, plus a JSON API
  (`POST /api/lookup`, `POST /api/ip-lookup`,
  `POST /api/username-lookup`, `GET /api/my-ip`).

## Why `phonenumbers`? How the four repos map to this app

The repos from the reel can't be imported into a Python app directly:

- **Phoneinfoga** is written in **Go**.
- **PhoneNumberKit** is written in **Swift** (for iOS).
- **GhostTrack** is Python, and its Phone Tracker is literally the same
  `phonenumbers` calls this app uses (geocoder, carrier, timezone,
  valid/possible, formats) — verified by reading its `GhostTR.py`. Its
  IP Tracker (ipwho.is) and Username Tracker (profile-URL status
  checks) are re-implemented here as tabs 2 and 3.
- **ignorant** is Python, but its whole purpose is checking whether a
  phone number is registered on Instagram, Snapchat, Amazon and other
  services — number-to-account probing. This webapp deliberately does
  not include that.

`phonenumbers` is the Python equivalent of the engine PhoneNumberKit is
inspired by (Google's libphonenumber), and it covers the legitimate core:
parsing, validation, formatting, carrier, timezone and region lookup —
all offline, from data bundled with the library.

Read-only reference clones of all four repos live in
`~/workspace/phone-repos/` (not part of this repo).

## Ignorant audit (2026-11-18)

The Ignorant repository was fully audited (static code review only — no
module was executed and no request was sent to any service) to see
whether any of it could be safely and usefully integrated. Full report:
[`docs/ignorant-audit.md`](docs/ignorant-audit.md).

**Finding: nothing was integrated, because there is nothing safe in it
that this app does not already do better.** Ignorant's entire functional
content is checking whether a phone number is registered on Instagram,
Snapchat and Amazon (login/registration-endpoint enumeration, including
a hard-coded leaked Instagram signing key) — all prohibited here. It
contains no phone validation, formatting or metadata logic of its own
(no `phonenumbers` use at all); everything it was hoped to contribute is
already covered by this app's libphonenumber-based lookup, with correct
data. Its only separable piece, a calling-code → country table, is
partly wrong (`44` → `JE`, `61` → `CX`, `1` → `VI`) and is superseded
by `phonenumbers`. No `modules/ignorant_safe/` was created and no new
UI section was added, because there is no genuinely new functionality
to put in them.

## Run it

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5000 in your browser.

## API

```bash
curl -X POST http://127.0.0.1:5000/api/lookup \
  -H "Content-Type: application/json" \
  -d '{"number": "+1 202-555-0140"}'
```

Response:

```json
{
  "success": true,
  "data": {
    "input": "+1 202-555-0140",
    "is_possible": true,
    "is_valid": true,
    "number_type": "Fixed line or mobile",
    "country_code": 1,
    "national_number": "2025550140",
    "region_code": "US",
    "location": "Washington D.C.",
    "carrier": "Unknown",
    "timezones": ["America/New_York"],
    "formats": {
      "e164": "+12025550140",
      "international": "+1 202-555-0140",
      "national": "(202) 555-0140",
      "rfc3966": "tel:+1-202-555-0140"
    }
  }
}
```

(`+1 202-555-0140` is from the reserved fictional 555 range — safe to
use as a demo number. Never test with a real person's number.)

```bash
# IP lookup (8.8.8.8 = Google's public DNS, safe demo IP)
curl -X POST http://127.0.0.1:5000/api/ip-lookup \
  -H "Content-Type: application/json" \
  -d '{"ip": "8.8.8.8"}'

# Username check (checks the username's public profile URL on 19 sites)
curl -X POST http://127.0.0.1:5000/api/username-lookup \
  -H "Content-Type: application/json" \
  -d '{"username": "github"}'

# Your own IP
curl http://127.0.0.1:5000/api/my-ip
```

## Static version (Netlify)

The `netlify/` folder holds a fully static build of the same app — same
look, same checks — that runs entirely in the browser using the
`google-libphonenumber` JavaScript library from a CDN. `netlify.toml`
sets the publish directory to `netlify` with no build command, so the
repo can be imported on Netlify as-is.

The static build also includes the IP Tracker tab (browser fetch to
ipwho.is, which allows cross-origin requests) and the Show-Your-IP
helper (api.ipify.org). The Username Tracker tab is an honest note:
browsers cannot read other sites' HTTP status (CORS), so username
checking needs the Python app above — nothing is faked.

Static-version limits (all shown in the UI too):

- **No carrier lookup** — the JavaScript library does not ship the
  carrier mapper, so the static build reports carrier as unavailable.
  Use the Python app above for carrier data.
- **Timezone is approximate** — the JS library has no timezone API, so
  timezones come from a region-level mapping, labelled approximate.
- **Location is country-level only** (the Python app can show a
  city/area for some numbers).
- **No username checking** (see above).

## Limits

- The number must include its country code (e.g. `+92 …`, `+44 …`).
- "Location" is only the approximate area from the public numbering plan
  (e.g. a city/region for a landline area code) — never a live position.
- Carrier data is not available for every country/number; in that case
  the field shows "Unknown".
- IP geolocation shows where an IP is registered (often the ISP's city),
  not the device's live position. Private/reserved IPs (e.g. 192.168.x.x)
  cannot be looked up.
- Username "Found" means the profile URL responded with HTTP 200; some
  sites return 200 even for missing profiles, and some block automated
  checks (those show as "Unknown").
