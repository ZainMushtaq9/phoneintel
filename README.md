# PhoneIntel

A phone number intelligence webapp (Flask + Python). Enter a phone number
with its country code and get an offline analysis: validity, number type,
country/region, carrier, timezone(s), and all standard formats.

Inspired by the phone-number OSINT repos Phoneinfoga, GhostTrack,
PhoneNumberKit and ignorant — but built as a **legitimate, fully offline**
tool: no account probing, no live location tracking, no external APIs.

## What it does

- Parses, validates and formats numbers using the `phonenumbers` library
  (the Python port of Google's libphonenumber).
- Shows: valid / possible checks, number type (mobile, fixed line, VOIP…),
  region code, approximate location from the public numbering plan,
  carrier name, timezone(s), country code, national number, and E.164 /
  international / national / RFC 3966 formats.
- Single-page dark UI, plus a JSON API at `POST /api/lookup`.

## Why `phonenumbers`?

The repos from the reel can't be imported into a Python app directly:

- **Phoneinfoga** is written in **Go**.
- **PhoneNumberKit** is written in **Swift** (for iOS).
- **GhostTrack** and **ignorant** are Python, but they are CLI tools built
  around scraping / account-probing behaviour that this webapp
  deliberately does not include.

`phonenumbers` is the Python equivalent of the engine PhoneNumberKit is
inspired by (Google's libphonenumber), and it covers the legitimate core:
parsing, validation, formatting, carrier, timezone and region lookup —
all offline, from data bundled with the library.

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

## Static version (Netlify)

The `netlify/` folder holds a fully static build of the same app — same
look, same checks — that runs entirely in the browser using the
`google-libphonenumber` JavaScript library from a CDN. `netlify.toml`
sets the publish directory to `netlify` with no build command, so the
repo can be imported on Netlify as-is.

Static-version limits (all shown in the UI too):

- **No carrier lookup** — the JavaScript library does not ship the
  carrier mapper, so the static build reports carrier as unavailable.
  Use the Python app above for carrier data.
- **Timezone is approximate** — the JS library has no timezone API, so
  timezones come from a region-level mapping, labelled approximate.
- **Location is country-level only** (the Python app can show a
  city/area for some numbers).

## Limits

- The number must include its country code (e.g. `+92 …`, `+44 …`).
- "Location" is only the approximate area from the public numbering plan
  (e.g. a city/region for a landline area code) — never a live position.
- Carrier data is not available for every country/number; in that case
  the field shows "Unknown".
