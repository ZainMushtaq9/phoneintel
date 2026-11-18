"""PhoneIntel — phone number intelligence webapp (offline).

Parses, validates and analyses a phone number using the ``phonenumbers``
library (the Python port of Google's libphonenumber — the same engine
that PhoneNumberKit (Swift) is inspired by).

Everything runs locally: no external lookup APIs, no scraping, no API
keys, no account probing, no live location tracking. The region/country
shown comes only from the public numbering plan.
"""

from flask import Flask, jsonify, render_template, request
import phonenumbers
from phonenumbers import carrier, geocoder, timezone

app = Flask(__name__)

# Human-readable names for phonenumbers.PhoneNumberType values.
NUMBER_TYPES = {
    phonenumbers.PhoneNumberType.FIXED_LINE: "Fixed line",
    phonenumbers.PhoneNumberType.MOBILE: "Mobile",
    phonenumbers.PhoneNumberType.FIXED_LINE_OR_MOBILE: "Fixed line or mobile",
    phonenumbers.PhoneNumberType.TOLL_FREE: "Toll free",
    phonenumbers.PhoneNumberType.PREMIUM_RATE: "Premium rate",
    phonenumbers.PhoneNumberType.SHARED_COST: "Shared cost",
    phonenumbers.PhoneNumberType.VOIP: "VOIP",
    phonenumbers.PhoneNumberType.PERSONAL_NUMBER: "Personal number",
    phonenumbers.PhoneNumberType.PAGER: "Pager",
    phonenumbers.PhoneNumberType.UAN: "UAN",
    phonenumbers.PhoneNumberType.VOICEMAIL: "Voicemail",
    phonenumbers.PhoneNumberType.UNKNOWN: "Unknown",
}


def lookup_number(raw_number):
    """Parse and analyse one phone number. Returns a dict of results."""
    raw_number = (raw_number or "").strip()
    if not raw_number:
        raise ValueError("Please enter a phone number.")

    # No default region: the number must carry its own country code
    # (e.g. +1 202-555-0140). This keeps lookups unambiguous.
    parsed = phonenumbers.parse(raw_number, None)

    country_code = parsed.country_code
    national_number = str(parsed.national_number)
    region = phonenumbers.region_code_for_number(parsed) or "Unknown"

    return {
        "input": raw_number,
        "is_possible": phonenumbers.is_possible_number(parsed),
        "is_valid": phonenumbers.is_valid_number(parsed),
        "number_type": NUMBER_TYPES.get(
            phonenumbers.number_type(parsed), "Unknown"
        ),
        "country_code": country_code,
        "national_number": national_number,
        "region_code": region,
        # Approximate region (city/area) from the public numbering plan.
        "location": geocoder.description_for_number(parsed, "en") or "Unknown",
        "carrier": carrier.name_for_number(parsed, "en") or "Unknown",
        "timezones": sorted(timezone.time_zones_for_number(parsed)),
        "formats": {
            "e164": phonenumbers.format_number(
                parsed, phonenumbers.PhoneNumberFormat.E164
            ),
            "international": phonenumbers.format_number(
                parsed, phonenumbers.PhoneNumberFormat.INTERNATIONAL
            ),
            "national": phonenumbers.format_number(
                parsed, phonenumbers.PhoneNumberFormat.NATIONAL
            ),
            "rfc3966": phonenumbers.format_number(
                parsed, phonenumbers.PhoneNumberFormat.RFC3966
            ),
        },
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/lookup", methods=["POST"])
def api_lookup():
    data = request.get_json(silent=True) or {}
    number = data.get("number") or request.form.get("number")
    try:
        return jsonify({"success": True, "data": lookup_number(number)})
    except phonenumbers.NumberParseException as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
