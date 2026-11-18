"""PhoneIntel — phone number intelligence webapp + GhostTrack features.

Phone lookup parses, validates and analyses a phone number using the
``phonenumbers`` library (the Python port of Google's libphonenumber —
the same engine that PhoneNumberKit (Swift) is inspired by). That part
is fully offline: no external lookup APIs, no scraping, no API keys,
no account probing, no live location tracking. The region/country
shown comes only from the public numbering plan.

GhostTrack features (re-implemented from the tool's documented
behaviour — see https://github.com/HunxByts/GhostTrack):

- IP Tracker: looks up a public IP address via the free ipwho.is API
  (no key). Returns country, city, region, coordinates, ISP/org/ASN
  and timezone. This is IP geolocation of an address the user typed
  in — not live tracking of a person or device.
- Username Tracker: checks whether a username's public profile URL
  exists on a list of social sites, using HTTP status only. No login,
  no page-content scraping, no private data — only whether the public
  profile URL responds. Some sites return HTTP 200 even for missing
  profiles, so a "found" result means "the URL responded", not proof
  of an active account.
- Show Your IP: displays the visitor's own IP address, with a
  one-click lookup of it.

Deliberately NOT included: ignorant-style number-to-account probing
(checking whether a phone number is registered on Instagram, Snapchat
or other services), live location tracking, and extracting phone
numbers from social media accounts.
"""

import ipaddress
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone as tz_utc

import requests
from flask import Flask, jsonify, render_template, request
import phonenumbers
from phonenumbers import carrier, geocoder, timezone

app = Flask(__name__)

# ---------------------------------------------------------------- phone ---

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


# ------------------------------------------------------------------- IP ---

IPWHOIS_URL = "https://ipwho.is/{ip}"
IP_TIMEOUT = 8  # seconds


def lookup_ip(raw_ip):
    """Look up a public IP address via the free ipwho.is API (no key)."""
    raw_ip = (raw_ip or "").strip()
    if not raw_ip:
        raise ValueError("Please enter an IP address.")
    try:
        ipaddress.ip_address(raw_ip)
    except ValueError:
        raise ValueError(f"'{raw_ip}' is not a valid IP address.")

    try:
        resp = requests.get(
            IPWHOIS_URL.format(ip=raw_ip),
            timeout=IP_TIMEOUT,
            headers={"User-Agent": "PhoneIntel/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.Timeout:
        raise LookupError("The IP lookup service timed out. Please try again.")
    except requests.exceptions.RequestException:
        raise LookupError(
            "Could not reach the IP lookup service. Check your connection "
            "and try again."
        )

    if not data.get("success"):
        # ipwho.is reports reserved/private/invalid IPs this way.
        raise ValueError(data.get("message") or "IP lookup failed.")

    connection = data.get("connection") or {}
    tz = data.get("timezone") or {}
    flag = data.get("flag") or {}
    lat = data.get("latitude")
    lon = data.get("longitude")

    # ipwho.is does not return a current-time field; derive it from the
    # UTC offset (seconds) it does return.
    offset = tz.get("offset")
    if isinstance(offset, (int, float)):
        current_time = (
            datetime.now(tz_utc.utc) + timedelta(seconds=offset)
        ).strftime("%Y-%m-%d %H:%M")
    else:
        current_time = "Unknown"

    return {
        "ip": data.get("ip", raw_ip),
        "type": data.get("type", "Unknown"),
        "country": data.get("country", "Unknown"),
        "country_code": data.get("country_code", "Unknown"),
        "region": data.get("region", "Unknown"),
        "city": data.get("city", "Unknown"),
        "postal": data.get("postal", "Unknown"),
        "latitude": lat,
        "longitude": lon,
        "maps_url": (
            f"https://www.google.com/maps/@{lat},{lon},8z"
            if lat is not None and lon is not None
            else None
        ),
        "continent": data.get("continent", "Unknown"),
        "is_eu": data.get("is_eu"),
        "calling_code": data.get("calling_code", "Unknown"),
        "capital": data.get("capital", "Unknown"),
        "flag_emoji": flag.get("emoji", ""),
        "asn": connection.get("asn", "Unknown"),
        "org": connection.get("org", "Unknown"),
        "isp": connection.get("isp", "Unknown"),
        "domain": connection.get("domain", "Unknown"),
        "timezone_id": tz.get("id", "Unknown"),
        "timezone_abbr": tz.get("abbr", "Unknown"),
        "timezone_utc": tz.get("utc", "Unknown"),
        "current_time": current_time,
    }


# ------------------------------------------------------------- username ---

# GhostTrack's username-tracker site list, deduplicated. Services that
# have shut down since (Periscope, StumbleUpon, Ello, We Heart It)
# are left out — checking them would always fail.
USERNAME_SITES = [
    ("Facebook", "https://www.facebook.com/{}"),
    ("X (Twitter)", "https://x.com/{}"),
    ("Instagram", "https://www.instagram.com/{}"),
    ("LinkedIn", "https://www.linkedin.com/in/{}"),
    ("GitHub", "https://www.github.com/{}"),
    ("Pinterest", "https://www.pinterest.com/{}"),
    ("Tumblr", "https://www.tumblr.com/{}"),
    ("YouTube", "https://www.youtube.com/{}"),
    ("SoundCloud", "https://soundcloud.com/{}"),
    ("Snapchat", "https://www.snapchat.com/add/{}"),
    ("TikTok", "https://www.tiktok.com/@{}"),
    ("Behance", "https://www.behance.net/{}"),
    ("Medium", "https://medium.com/@{}"),
    ("Quora", "https://www.quora.com/profile/{}"),
    ("Flickr", "https://www.flickr.com/people/{}"),
    ("Twitch", "https://www.twitch.tv/{}"),
    ("Dribbble", "https://dribbble.com/{}"),
    ("Telegram", "https://t.me/{}"),
    ("Product Hunt", "https://www.producthunt.com/@{}"),
]

# Strict on purpose: the username is interpolated into profile URLs,
# so anything outside this set is rejected rather than escaped.
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
SITE_TIMEOUT = 6  # seconds per site
SITE_WORKERS = 10
SITE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}


def _check_site(site, username):
    """Check one site's public profile URL. Status only — no content."""
    name, url_template = site
    url = url_template.format(username)
    try:
        # stream=True + immediate close: we only need the status code,
        # never the page body.
        with requests.get(
            url, headers=SITE_HEADERS, timeout=SITE_TIMEOUT, stream=True
        ) as resp:
            status = resp.status_code
    except requests.exceptions.Timeout:
        return {"site": name, "url": url, "status": "unknown",
                "detail": "timed out"}
    except requests.exceptions.RequestException:
        return {"site": name, "url": url, "status": "unknown",
                "detail": "request failed"}

    if status == 200:
        return {"site": name, "url": url, "status": "found",
                "detail": "profile URL responded (HTTP 200)"}
    if status in (404, 410):
        return {"site": name, "url": url, "status": "not_found",
                "detail": f"HTTP {status}"}
    return {"site": name, "url": url, "status": "unknown",
            "detail": f"HTTP {status} — could not verify"}


def lookup_username(raw_username):
    """Check a username's public profile URL across the site list."""
    username = (raw_username or "").strip().lstrip("@")
    if not username:
        raise ValueError("Please enter a username.")
    if not USERNAME_RE.match(username):
        raise ValueError(
            "Usernames may only contain letters, digits, '.', '_' and '-', "
            "up to 64 characters."
        )

    results = []
    with ThreadPoolExecutor(max_workers=SITE_WORKERS) as pool:
        futures = {
            pool.submit(_check_site, site, username): site
            for site in USERNAME_SITES
        }
        for future in as_completed(futures):
            results.append(future.result())

    # Keep the output in the site list's order.
    order = {name: i for i, (name, _) in enumerate(USERNAME_SITES)}
    results.sort(key=lambda r: order[r["site"]])
    return {
        "username": username,
        "results": results,
        "found": sum(1 for r in results if r["status"] == "found"),
        "not_found": sum(1 for r in results if r["status"] == "not_found"),
        "unknown": sum(1 for r in results if r["status"] == "unknown"),
    }


# --------------------------------------------------------------- routes ---

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


@app.route("/api/ip-lookup", methods=["POST"])
def api_ip_lookup():
    data = request.get_json(silent=True) or {}
    ip = data.get("ip") or request.form.get("ip")
    try:
        return jsonify({"success": True, "data": lookup_ip(ip)})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


@app.route("/api/username-lookup", methods=["POST"])
def api_username_lookup():
    data = request.get_json(silent=True) or {}
    username = data.get("username") or request.form.get("username")
    try:
        return jsonify({"success": True, "data": lookup_username(username)})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/api/my-ip", methods=["GET"])
def api_my_ip():
    forwarded = request.headers.get("X-Forwarded-For")
    ip = forwarded.split(",")[0].strip() if forwarded else request.remote_addr
    return jsonify({"success": True, "data": {"ip": ip}})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
