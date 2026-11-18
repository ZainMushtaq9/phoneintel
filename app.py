"""PhoneIntel — real phone-number OSINT investigation webapp (Flask).

One investigation interface runs real analysis modules in parallel and
combines them into a single report. Every module returns a structured
result with a status (SUCCESS / PARTIAL / NOT AVAILABLE / FAILED /
NOT SUPPORTED), its data source, a timestamp, a confidence note and
error details. Nothing is fabricated: a module that cannot run says so.

Module map (see docs/repo-audits.md for the full audit of each repo):

- number / carrier / technical — the legitimate core of Phoneinfoga's
  local scanner, GhostTrack's Phone Tracker and PhoneNumberKit,
  implemented with ``phonenumbers`` (Python port of Google's
  libphonenumber). Fully offline; data comes only from the public
  numbering plan.
- ovh — Phoneinfoga's OVH scanner, re-implemented: queries OVH's
  public telephony zones API (no key) for FR/BE/GB/ES/CH numbers and
  matches the number's range to a city. Other countries: NOT AVAILABLE.
- public_osint — Phoneinfoga's googlesearch scanner, re-implemented:
  generates Google dork query URLs (social media, reputation, public
  references). These are LINKS the user opens — nothing is fetched
  here, and no finding is claimed.
- ip — GhostTrack's IP Tracker: looks up an IP the user typed in via
  the free ipwho.is API (no key). A phone owner's IP is NEVER inferred
  from their phone number.
- username — GhostTrack's Username Tracker (separate tool, kept as-is):
  checks whether a username's public profile URL exists on 19 social
  sites, HTTP status only.
- numverify / googlecse — Phoneinfoga scanners that need API keys.
  No keys are configured in this build, so they report NOT SUPPORTED
  with the reason instead of pretending to run.
- ignorant — NOT SUPPORTED by policy: its only function is checking
  whether a phone number is registered on Instagram/Snapchat/Amazon
  (account enumeration). See docs/ignorant-audit.md.

Deliberately NOT included anywhere: live GPS tracking, home-address or
identity lookup from a number, account enumeration, and extracting
phone numbers from social media accounts. A valid number format is not
proof of an active subscriber, and this app never claims otherwise.

Privacy: submitted numbers, IPs and usernames are never stored, never
written to logs and never sent anywhere except the lookup services the
user explicitly invoked (ipwho.is for IPs, api.ovh.com for OVH-zone
checks, profile-URL status checks for usernames). Investigation
results live only in the user's browser; the server keeps a 60-second
in-memory duplicate-request cache (keyed by a hash, never persisted).
"""

import copy
import hashlib
import ipaddress
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone as tz_utc
from urllib.parse import quote_plus

import requests
from flask import Flask, jsonify, render_template, request, Response
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
import phonenumbers
from phonenumbers import carrier, geocoder, timezone

app = Flask(__name__)
# Keep insertion order in JSON responses so report modules appear in
# their fixed display order instead of alphabetically. (Flask 2.2+
# reads this from the JSON provider, not the old JSON_SORT_KEYS key.)
app.json.sort_keys = False
# Behind a reverse proxy the real client IP arrives in X-Forwarded-For.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
# Small cap: request bodies are a number, an IP or a report for export.
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["200 per hour"],
    storage_uri="memory://",
)

# ------------------------------------------------------------------ utils ---

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

# ISO region code -> country name, for the regions most often looked up.
# Anything not listed falls back to the region code itself — never a guess.
REGION_NAMES = {
    "AE": "United Arab Emirates", "AF": "Afghanistan", "AR": "Argentina",
    "AT": "Austria", "AU": "Australia", "BD": "Bangladesh", "BE": "Belgium",
    "BH": "Bahrain", "BR": "Brazil", "CA": "Canada", "CH": "Switzerland",
    "CL": "Chile", "CN": "China", "CO": "Colombia", "CZ": "Czechia",
    "DE": "Germany", "DK": "Denmark", "EG": "Egypt", "ES": "Spain",
    "FI": "Finland", "FR": "France", "GB": "United Kingdom",
    "GR": "Greece", "HK": "Hong Kong", "HU": "Hungary", "ID": "Indonesia",
    "IE": "Ireland", "IL": "Israel", "IN": "India", "IQ": "Iraq",
    "IR": "Iran", "IS": "Iceland", "IT": "Italy", "JO": "Jordan",
    "JP": "Japan", "KE": "Kenya", "KR": "South Korea", "KW": "Kuwait",
    "KZ": "Kazakhstan", "LK": "Sri Lanka", "MA": "Morocco",
    "MX": "Mexico", "MY": "Malaysia", "NG": "Nigeria",
    "NL": "Netherlands", "NO": "Norway", "NP": "Nepal",
    "NZ": "New Zealand", "OM": "Oman", "PE": "Peru", "PH": "Philippines",
    "PK": "Pakistan", "PL": "Poland", "PT": "Portugal", "QA": "Qatar",
    "RO": "Romania", "RU": "Russia", "SA": "Saudi Arabia",
    "SE": "Sweden", "SG": "Singapore", "TH": "Thailand", "TR": "Turkey",
    "TW": "Taiwan", "UA": "Ukraine", "US": "United States",
    "UZ": "Uzbekistan", "VN": "Vietnam", "ZA": "South Africa",
}

# Module statuses used by the results engine.
SUCCESS = "SUCCESS"
PARTIAL = "PARTIAL"
NOT_AVAILABLE = "NOT AVAILABLE"
FAILED = "FAILED"
NOT_SUPPORTED = "NOT SUPPORTED"


def utc_now():
    """UTC timestamp in ISO 8601 with a Z suffix."""
    return datetime.now(tz_utc.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def module_result(name, label, status, source, confidence, data=None,
                  error=None, detail=None):
    """Build one module's structured result envelope."""
    return {
        "name": name,
        "label": label,
        "status": status,
        "source": source,
        "confidence": confidence,
        "timestamp": utc_now(),
        "data": data,
        "error": error,
        "detail": detail,
    }


def country_name(region_code):
    if not region_code or region_code == "Unknown":
        return "Unknown"
    return REGION_NAMES.get(region_code, region_code)


# ---------------------------------------------------------------- phone ---

def lookup_number(raw_number, region=None):
    """Parse and analyse one phone number. Returns a dict of results.

    ``region`` is an ISO region code used only when the number carries
    no country code of its own (e.g. "0300 1234567" with region "PK").
    With region=None the number must include its country code.
    """
    raw_number = (raw_number or "").strip()
    if not raw_number:
        raise ValueError("Please enter a phone number.")

    parsed = phonenumbers.parse(raw_number, region)

    country_code = parsed.country_code
    national_number = str(parsed.national_number)
    region_code = phonenumbers.region_code_for_number(parsed) or "Unknown"
    national_fmt = phonenumbers.format_number(
        parsed, phonenumbers.PhoneNumberFormat.NATIONAL
    )

    return {
        "input": raw_number,
        "is_possible": phonenumbers.is_possible_number(parsed),
        "is_valid": phonenumbers.is_valid_number(parsed),
        "number_type": NUMBER_TYPES.get(
            phonenumbers.number_type(parsed), "Unknown"
        ),
        "country_code": country_code,
        "national_number": national_number,
        "region_code": region_code,
        "country": country_name(region_code),
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
            "national": national_fmt,
            "rfc3966": phonenumbers.format_number(
                parsed, phonenumbers.PhoneNumberFormat.RFC3966
            ),
        },
        # Phoneinfoga-style derived forms, used by the dork and OVH
        # modules. raw_local is the national number as dialled locally
        # (digits only, trunk prefix kept, e.g. "03001234567").
        "raw_local": re.sub(r"\D", "", national_fmt),
        "international_digits": re.sub(
            r"\D", "",
            phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164),
        ),
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


# ------------------------------------------------------------ OVH zones ---
# Phoneinfoga's OVH scanner, re-implemented. OVH publishes its
# telephony number zones at a public, keyless API endpoint; this
# module matches the investigated number's first 6 local digits
# against those zones and reports the city when there is a match.
# Coverage is limited to the five countries OVH's endpoint serves.

OVH_COUNTRIES = {33: "fr", 32: "be", 44: "gb", 34: "es", 41: "ch"}
OVH_URL = "https://api.ovh.com/1.0/telephony/number/detailedZones?country={cc}"
OVH_TIMEOUT = 20  # seconds (the FR zone list is ~85 KB)
OVH_CACHE_TTL = 3600  # seconds; zone lists change rarely

_ovh_cache = {}
_ovh_cache_lock = threading.Lock()


def _fetch_ovh_zones(country_iso):
    """Fetch one country's OVH zone list, cached for an hour."""
    now = datetime.now(tz_utc.utc)
    with _ovh_cache_lock:
        cached = _ovh_cache.get(country_iso)
        if cached and (now - cached[0]).total_seconds() < OVH_CACHE_TTL:
            return cached[1]
    try:
        resp = requests.get(
            OVH_URL.format(cc=country_iso),
            timeout=OVH_TIMEOUT,
            headers={"User-Agent": "PhoneIntel/1.0"},
        )
        resp.raise_for_status()
        zones = resp.json()
    except requests.exceptions.Timeout:
        raise LookupError("The OVH zones service timed out.")
    except requests.exceptions.RequestException:
        raise LookupError("Could not reach the OVH zones service.")
    if not isinstance(zones, list):
        raise LookupError("The OVH zones service returned unexpected data.")
    with _ovh_cache_lock:
        _ovh_cache[country_iso] = (now, zones)
    return zones


def run_ovh_module(info):
    """OVH number-range lookup (Phoneinfoga OVH scanner)."""
    label = "OVH Number Zones"
    source = "OVH public telephony zones API (api.ovh.com, no key)"
    country_code = info["country_code"]
    if country_code not in OVH_COUNTRIES:
        return module_result(
            "ovh", label, NOT_AVAILABLE, source, "n/a", data=None,
            detail=(
                "OVH publishes number zones only for France, Belgium, "
                "United Kingdom, Spain and Switzerland. This number's "
                "country is not covered."
            ),
        )
    raw_local = info["raw_local"]
    if len(raw_local) <= 6:
        return module_result(
            "ovh", label, NOT_AVAILABLE, source, "n/a", data=None,
            detail="This number is too short for range matching.",
        )
    try:
        zones = _fetch_ovh_zones(OVH_COUNTRIES[country_code])
    except LookupError as exc:
        return module_result(
            "ovh", label, FAILED, source, "n/a", data=None,
            error=str(exc),
            detail="The OVH zones service could not be reached.",
        )
    key = raw_local[:6] + "xxxx"
    match = next((z for z in zones if z.get("number") == key), None)
    if match:
        return module_result(
            "ovh", label, SUCCESS, source, "medium",
            data={
                "found": True,
                "number_range": match.get("number"),
                "city": match.get("city") or "Unknown",
                "zip_code": match.get("zipCode") or "Unknown",
                "country": match.get("country", "").upper(),
            },
            detail=(
                "The number's range is listed in OVH's published zones. "
                "The city is the zone the range is assigned to — not a "
                "live position."
            ),
        )
    return module_result(
        "ovh", label, PARTIAL, source, "low",
        data={"found": False, "number_range": key},
        detail=(
            "The number's range was not found in OVH's published zones. "
            "OVH zones cover only part of the numbering plan, so this "
            "does not mean the number is unassigned."
        ),
    )


# ------------------------------------------------- public OSINT dorks ---
# Phoneinfoga's googlesearch scanner, re-implemented. It generates
# Google dork query URLs — it does NOT fetch search results, and
# neither does this module. The links are handed to the user to open;
# what Google returns depends on what is publicly indexed.

def _dork_url(dork):
    return "https://www.google.com/search?q=" + quote_plus(dork)


def _intext(*values):
    return " | ".join(f'intext:"{v}"' for v in values)


DISPOSABLE_SMS_SITES = [
    "hs3x.com", "receive-sms-now.com", "smslisten.com",
    "smsnumbersonline.com", "freesmscode.com", "catchsms.com",
    "smstibo.com", "smsreceiving.com", "getfreesmsnumber.com",
    "sellaite.com", "receive-sms-online.info", "receivesmsonline.com",
    "receive-a-sms.com", "sms-receive.net", "receivefreesms.com",
    "receive-sms.com", "receivetxt.com", "freephonenum.com",
    "freesmsverification.com", "receive-sms-online.com", "smslive.co",
]

FILE_EXTENSIONS = [
    "doc", "docx", "odt", "pdf", "rtf", "sxw", "psw", "ppt", "pptx",
    "pps", "csv", "txt", "xls",
]


def build_dorks(info):
    """Build Phoneinfoga-style Google dork links for a number.

    Returns {category: [{dork, url}, ...]}. Pure string building —
    no network access, no fetching, no results claimed.
    """
    e164 = info["formats"]["e164"]
    intl = info["international_digits"]
    raw_local = info["raw_local"]
    local_fmt = info["formats"]["national"]

    def link(dork):
        return {"dork": dork, "url": _dork_url(dork)}

    social = [
        link(f"site:{site} " + _intext(intl, e164, raw_local))
        for site in ("facebook.com", "twitter.com", "linkedin.com",
                     "instagram.com", "vk.com")
    ]

    disposable = [link(f"site:hs3x.com intext:\"{intl}\"")]
    disposable += [
        link(f"site:{site} " + _intext(intl, raw_local))
        for site in DISPOSABLE_SMS_SITES[1:]
    ]

    reputation = [
        link(f"site:whosenumber.info intext:\"{e164}\" intitle:\"who called\""),
        link(f"intitle:\"Phone Fraud\" " + _intext(intl, e164, raw_local)),
        link(f"site:findwhocallsme.com intext:\"{e164}\" | intext:\"{intl}\""),
        link(f"site:yellowpages.ca intext:\"{e164}\""),
        link(f"site:phonenumbers.ie intext:\"{e164}\""),
        link(f"site:who-calledme.com intext:\"{e164}\""),
        link(f"site:usphonesearch.net intext:\"{raw_local}\""),
        link(f"site:whocalled.us inurl:{raw_local}"),
        link(f"site:quinumero.info intext:\"{raw_local}\" | intext:\"{intl}\""),
        link(f"site:uk.popularphotolook.com inurl:{raw_local}"),
    ]

    individuals = [
        link(f"site:{site} " + _intext(intl, e164, raw_local))
        for site in ("numinfo.net", "sync.me", "pastebin.com",
                     "whycall.me", "locatefamily.com")
    ]
    individuals += [
        link(f"site:whocallsyou.de intext:\"{raw_local}\""),
        link(f"site:spytox.com intext:\"{raw_local}\""),
    ]

    filetypes = "(" + " | ".join(f"ext:{ext}" for ext in FILE_EXTENSIONS) + ")"
    general = [
        link(_intext(intl, e164, raw_local, local_fmt)),
        link(filetypes + " " + _intext(intl, e164, raw_local)),
    ]

    return {
        "social_media": social,
        "disposable_providers": disposable,
        "reputation": reputation,
        "individuals": individuals,
        "general": general,
    }


def run_public_osint_module(info):
    """Public search-engine OSINT links (Phoneinfoga googlesearch)."""
    dorks = build_dorks(info)
    total = sum(len(v) for v in dorks.values())
    return module_result(
        "public_osint", "Public OSINT (Search Links)", SUCCESS,
        "Google search query links (Phoneinfoga dork patterns)",
        "n/a",
        data={
            "number": info["formats"]["e164"],
            "total_links": total,
            "categories": {
                name: {"count": len(links), "links": links}
                for name, links in dorks.items()
            },
        },
        detail=(
            "These are search-engine query links, not fetched findings. "
            "Open a link to see what Google has publicly indexed for "
            "this number. PhoneIntel does not fetch, store or interpret "
            "any search results."
        ),
    )


# ------------------------------------------- modules that cannot run ---

def not_supported_modules():
    """Phoneinfoga/ignorant modules that cannot run in this build.

    Listed explicitly so the report is honest about what is missing
    and why, instead of silently dropping them.
    """
    return {
        "numverify": module_result(
            "numverify", "Numverify Lookup", NOT_SUPPORTED,
            "Numverify commercial API (apilayer.com)", "n/a", data=None,
            detail=(
                "Needs a Numverify API key, which is not configured in "
                "this build. Numverify is a paid service; its free tier "
                "still requires an API key."
            ),
        ),
        "googlecse": module_result(
            "googlecse", "Google Custom Search", NOT_SUPPORTED,
            "Google Custom Search JSON API", "n/a", data=None,
            detail=(
                "Needs a Google API key and a Custom Search Engine ID, "
                "which are not configured in this build. Use the Public "
                "OSINT search links instead — they run the same queries "
                "in your own browser."
            ),
        ),
        "ignorant": module_result(
            "ignorant", "Account Registration Check", NOT_SUPPORTED,
            "Excluded by policy — see docs/ignorant-audit.md", "n/a",
            data=None,
            detail=(
                "Deliberately excluded: ignorant checks whether a phone "
                "number is registered on Instagram, Snapchat and Amazon "
                "by probing their login/recovery endpoints. That is "
                "account enumeration, and PhoneIntel does not do it."
            ),
        ),
    }


# ------------------------------------------------- investigation engine ---

def run_number_module(info):
    """Panel A — number information (libphonenumber, offline)."""
    detail = (
        "Parsed and validated against the public numbering plan. "
        "A valid format means the number matches its country's numbering "
        "pattern — it does not prove an active subscriber."
    )
    if not info["is_valid"]:
        detail += (
            " This number does NOT match a valid pattern for its "
            "numbering plan: it may be mistyped or unassigned."
        )
    return module_result(
        "number", "Number Information", SUCCESS,
        "libphonenumber (phonenumbers, offline)", "high",
        data={
            "input": info["input"],
            "e164": info["formats"]["e164"],
            "international": info["formats"]["international"],
            "national": info["formats"]["national"],
            "rfc3966": info["formats"]["rfc3966"],
            "country": info["country"],
            "country_code": info["country_code"],
            "region_code": info["region_code"],
            "national_number": info["national_number"],
            "number_type": info["number_type"],
            "is_valid": info["is_valid"],
            "is_possible": info["is_possible"],
        },
        detail=detail,
    )


def run_carrier_module(info):
    """Panel B — carrier information (libphonenumber, offline)."""
    carrier_name = info["carrier"]
    if carrier_name and carrier_name != "Unknown":
        return module_result(
            "carrier", "Carrier Information", SUCCESS,
            "libphonenumber carrier data (offline)", "high",
            data={"carrier": carrier_name},
            detail=(
                "Carrier from the numbering-plan database. Number "
                "portability means the current operator may differ."
            ),
        )
    return module_result(
        "carrier", "Carrier Information", NOT_AVAILABLE,
        "libphonenumber carrier data (offline)", "n/a", data=None,
        detail=(
            "No carrier data for this number in the numbering-plan "
            "database. This is common for many regions, virtual ranges "
            "and fictional/test numbers."
        ),
    )


def run_technical_module(info):
    """Panel D — technical / numbering metadata (libphonenumber)."""
    timezones = info["timezones"]
    location = info["location"]
    data = {
        "timezones": timezones,
        "geographic_description": location,
        "region_code": info["region_code"],
        "country": info["country"],
        "country_code": info["country_code"],
        "number_type": info["number_type"],
        "limitations": [
            "Timezone comes from the numbering plan, not from the device.",
            "The geographic description is the area the number range is "
            "assigned to — never a live position.",
            "No subscriber identity, address or live location can be "
            "derived from a phone number.",
        ],
    }
    if timezones or location != "Unknown":
        status, detail = SUCCESS, (
            "Numbering metadata from the public numbering plan."
        )
    else:
        status, detail = PARTIAL, (
            "No timezone or geographic description is published for this "
            "number's range."
        )
    return module_result(
        "technical", "Technical Information", status,
        "libphonenumber (phonenumbers, offline)", "high",
        data=data, detail=detail,
    )


def run_ip_module(raw_ip):
    """Panel E — IP intelligence (GhostTrack IP Tracker)."""
    label = "IP Intelligence"
    source = "ipwho.is free API (no key)"
    if not (raw_ip or "").strip():
        return module_result(
            "ip", label, NOT_AVAILABLE, source, "n/a", data=None,
            detail=(
                "No IP address was provided with this investigation. "
                "Enter one to run IP Intelligence — a phone owner's IP "
                "is never inferred from their phone number."
            ),
        )
    try:
        data = lookup_ip(raw_ip)
    except ValueError as exc:
        return module_result(
            "ip", label, FAILED, source, "n/a", data=None,
            error=str(exc),
            detail="The IP address could not be looked up.",
        )
    except LookupError as exc:
        return module_result(
            "ip", label, FAILED, source, "n/a", data=None,
            error=str(exc),
            detail="The IP lookup service could not be reached.",
        )
    return module_result(
        "ip", label, SUCCESS, source, "medium",
        data=data,
        detail=(
            "Geolocation shows where the IP is registered (often the "
            "ISP's city), not a device's live position."
        ),
    )


# Duplicate-request protection: identical investigations within 60
# seconds return the cached report instead of re-running modules.
# In-memory only, keyed by a hash of the inputs, never persisted.
INVESTIGATION_CACHE_TTL = 60  # seconds
_investigation_cache = {}
_investigation_cache_lock = threading.Lock()


def _cache_key(e164, raw_ip):
    return hashlib.sha256(f"{e164}|{raw_ip or ''}".encode()).hexdigest()


def _cache_get(key):
    now = datetime.now(tz_utc.utc)
    with _investigation_cache_lock:
        for old_key in [
            k for k, (ts, _) in _investigation_cache.items()
            if (now - ts).total_seconds() > INVESTIGATION_CACHE_TTL
        ]:
            del _investigation_cache[old_key]
        hit = _investigation_cache.get(key)
        if hit:
            return copy.deepcopy(hit[1])
    return None


def _cache_put(key, report):
    with _investigation_cache_lock:
        _investigation_cache[key] = (datetime.now(tz_utc.utc), copy.deepcopy(report))


MODULE_RUNNERS = ("number", "carrier", "technical", "ovh", "public_osint", "ip")


def run_investigation(raw_number, region_hint, raw_ip):
    """Run every investigation module in parallel. Returns the report.

    Raises ValueError / phonenumbers.NumberParseException when the
    number itself cannot be parsed — the investigation cannot start.
    Individual module failures never raise: they are reported with
    status FAILED inside the report.
    """
    info = lookup_number(raw_number, region_hint)

    runners = {
        "number": lambda: run_number_module(info),
        "carrier": lambda: run_carrier_module(info),
        "technical": lambda: run_technical_module(info),
        "ovh": lambda: run_ovh_module(info),
        "public_osint": lambda: run_public_osint_module(info),
        "ip": lambda: run_ip_module(raw_ip),
    }
    modules = {}
    with ThreadPoolExecutor(max_workers=len(runners)) as pool:
        futures = {pool.submit(fn): name for name, fn in runners.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                modules[name] = future.result()
            except Exception as exc:  # a module must never kill the report
                modules[name] = module_result(
                    name, name.replace("_", " ").title(), FAILED,
                    "PhoneIntel investigation engine", "n/a", data=None,
                    error=f"Module crashed: {exc}",
                    detail="Unexpected module error. Use retry to run it again.",
                )

    # Fixed display order, then the modules that cannot run in this build.
    ordered = {name: modules[name] for name in MODULE_RUNNERS}
    ordered.update(not_supported_modules())

    counts = {"total": len(ordered)}
    for mod in ordered.values():
        key = mod["status"].lower().replace(" ", "_")
        counts[key] = counts.get(key, 0) + 1

    return {
        "investigation_id": uuid.uuid4().hex[:12],
        "timestamp": utc_now(),
        "input": {
            "number": info["formats"]["e164"],
            "country_hint": region_hint or None,
            "ip": (raw_ip or "").strip() or None,
        },
        "summary": counts,
        "modules": ordered,
    }


# --------------------------------------------------------------- routes ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({"status": "ok"})


def _request_body():
    data = request.get_json(silent=True)
    if isinstance(data, dict):
        return data
    return request.form.to_dict()


def _require_consent(data):
    if data.get("consent") not in (True, "true", "on", "yes", 1):
        raise ValueError(
            "Please confirm the investigation consent checkbox before "
            "starting an investigation."
        )


def _clean_region(raw_region):
    region = (raw_region or "").strip().upper()
    if not region:
        return None
    if not re.fullmatch(r"[A-Z]{2}", region):
        raise ValueError("Country must be a two-letter ISO code.")
    return region


@app.route("/api/investigate", methods=["POST"])
@limiter.limit("10 per minute")
def api_investigate():
    data = _request_body()
    try:
        _require_consent(data)
        region = _clean_region(data.get("country"))
        number = (data.get("number") or "").strip()
        raw_ip = (data.get("ip") or "").strip()
        if not number:
            raise ValueError("Please enter a phone number.")
        # Parse once up front: an unparseable number is a request
        # error (400), and its E.164 form is the dedup cache key.
        info = lookup_number(number, region)
        cached = _cache_get(_cache_key(info["formats"]["e164"], raw_ip))
        if cached is not None:
            cached["duplicate"] = True
            return jsonify({"success": True, "duplicate": True, "data": cached})
        report = run_investigation(number, region, raw_ip)
        _cache_put(_cache_key(info["formats"]["e164"], raw_ip), report)
        return jsonify({"success": True, "duplicate": False, "data": report})
    except phonenumbers.NumberParseException as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/api/module/<name>", methods=["POST"])
@limiter.limit("20 per minute")
def api_module_retry(name):
    """Re-run one investigation module (retry for failed modules)."""
    if name not in MODULE_RUNNERS:
        return jsonify({"success": False, "error": f"Unknown module '{name}'."}), 404
    data = _request_body()
    try:
        _require_consent(data)
        region = _clean_region(data.get("country"))
        if name == "ip":
            return jsonify({"success": True, "module": run_ip_module(data.get("ip"))})
        number = (data.get("number") or "").strip()
        if not number:
            raise ValueError("Please enter a phone number.")
        info = lookup_number(number, region)
        runners = {
            "number": lambda: run_number_module(info),
            "carrier": lambda: run_carrier_module(info),
            "technical": lambda: run_technical_module(info),
            "ovh": lambda: run_ovh_module(info),
            "public_osint": lambda: run_public_osint_module(info),
        }
        return jsonify({"success": True, "module": runners[name]()})
    except phonenumbers.NumberParseException as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


# ------------------------------------------------------------ PDF export ---

def _pdf_text(value):
    """Sanitise text for fpdf2's latin-1 core fonts."""
    text = "" if value is None else str(value)
    return text.encode("latin-1", "replace").decode("latin-1")


def _flatten_for_pdf(data, prefix=""):
    """Flatten a nested dict/list into (key, value) lines for the PDF."""
    lines = []
    if isinstance(data, dict):
        for key, value in data.items():
            lines.extend(_flatten_for_pdf(value, f"{prefix}{key}: " if prefix else f"{key}: "))
    elif isinstance(data, list):
        for value in data:
            if isinstance(value, dict):
                lines.extend(_flatten_for_pdf(value, prefix + "- "))
            else:
                lines.append((prefix.rstrip(": "), _pdf_text(value)))
    else:
        lines.append((prefix.rstrip(": ") or "value", _pdf_text(data)))
    return lines


def build_report_pdf(report):
    """Render an investigation report as a PDF (fpdf2, no storage)."""
    from fpdf import FPDF

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "PhoneIntel Investigation Report", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Investigation ID: {report.get('investigation_id', '-')}", ln=True)
    pdf.cell(0, 6, f"Generated: {report.get('timestamp', '-')}", ln=True)
    input_data = report.get("input") or {}
    pdf.cell(0, 6, f"Number: {input_data.get('number', '-')}", ln=True)
    if input_data.get("ip"):
        pdf.cell(0, 6, f"IP: {input_data.get('ip')}", ln=True)
    summary = report.get("summary") or {}
    pdf.cell(
        0, 6,
        "Modules: "
        f"{summary.get('success', 0)} success, "
        f"{summary.get('partial', 0)} partial, "
        f"{summary.get('not_available', 0)} not available, "
        f"{summary.get('failed', 0)} failed, "
        f"{summary.get('not_supported', 0)} not supported",
        ln=True,
    )
    pdf.ln(4)

    for mod in (report.get("modules") or {}).values():
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 8, _pdf_text(f"{mod.get('label', mod.get('name'))}  [{mod.get('status')}]"), ln=True)
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(0, 6, _pdf_text(f"Source: {mod.get('source')}"), ln=True)
        pdf.cell(
            0, 6,
            _pdf_text(f"Confidence: {mod.get('confidence')}  |  Checked: {mod.get('timestamp')}"),
            ln=True,
        )
        if mod.get("detail"):
            # new_x="LMARGIN": fpdf2's multi_cell otherwise leaves the
            # cursor at the end of the last line, and the next cell's
            # text gets clipped at the right margin.
            pdf.multi_cell(0, 6, _pdf_text(mod["detail"]),
                           new_x="LMARGIN", new_y="NEXT")
        if mod.get("error"):
            pdf.set_text_color(180, 0, 0)
            pdf.multi_cell(0, 6, _pdf_text(f"Error: {mod['error']}"),
                           new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(0, 0, 0)
        data = mod.get("data")
        if isinstance(data, dict) and data:
            for key, value in _flatten_for_pdf(data):
                # Skip the 45 dork links' full text in the PDF; the
                # summary line carries the count instead.
                if key in ("categories",) or str(value).startswith("https://www.google.com/search"):
                    continue
                pdf.cell(0, 6, _pdf_text(f"  {key}: {value}")[:180], ln=True)
            if "total_links" in data:
                pdf.cell(0, 6, f"  Search links generated: {data['total_links']}", ln=True)
        pdf.ln(2)

    pdf.set_font("Helvetica", "I", 9)
    pdf.multi_cell(
        0, 5,
        "PhoneIntel provides privacy-respecting phone-number analysis. "
        "It does not identify private social-media accounts, enumerate "
        "registrations or access restricted personal information. A valid "
        "number format does not prove an active subscriber.",
        new_x="LMARGIN", new_y="NEXT",
    )
    return bytes(pdf.output())


@app.route("/api/export/pdf", methods=["POST"])
@limiter.limit("10 per minute")
def api_export_pdf():
    """Export an investigation report as a PDF.

    The client posts the report JSON it already holds (from
    /api/investigate); nothing is read from server storage, because
    nothing is stored.
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("modules"), dict):
        return jsonify({"success": False, "error": "Invalid report payload."}), 400
    if len(data["modules"]) > 20:
        return jsonify({"success": False, "error": "Report has too many modules."}), 400
    try:
        pdf_bytes = build_report_pdf(data)
    except Exception:
        return jsonify({"success": False, "error": "Could not build the PDF."}), 500
    report_id = str(data.get("investigation_id") or "report")[:16]
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={
            "Content-Disposition":
                f'attachment; filename="phoneintel-{report_id}.pdf"'
        },
    )


# --------------------------------------------------- legacy API (kept) ---

@app.route("/api/lookup", methods=["POST"])
@limiter.limit("30 per minute")
def api_lookup():
    data = _request_body()
    number = data.get("number")
    try:
        return jsonify({"success": True, "data": lookup_number(number)})
    except phonenumbers.NumberParseException as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/api/ip-lookup", methods=["POST"])
@limiter.limit("30 per minute")
def api_ip_lookup():
    data = _request_body()
    ip = data.get("ip")
    try:
        return jsonify({"success": True, "data": lookup_ip(ip)})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


@app.route("/api/username-lookup", methods=["POST"])
@limiter.limit("30 per minute")
def api_username_lookup():
    data = _request_body()
    username = data.get("username")
    try:
        return jsonify({"success": True, "data": lookup_username(username)})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/api/my-ip", methods=["GET"])
def api_my_ip():
    forwarded = request.headers.get("X-Forwarded-For")
    ip = forwarded.split(",")[0].strip() if forwarded else request.remote_addr
    return jsonify({"success": True, "data": {"ip": ip}})


# --------------------------------------------------------- error pages ---

@app.errorhandler(429)
def rate_limit_exceeded(exc):
    return jsonify({
        "success": False,
        "error": "Rate limit exceeded. Please wait a moment and try again.",
    }), 429


@app.errorhandler(413)
def payload_too_large(exc):
    return jsonify({"success": False, "error": "Request is too large."}), 413


@app.errorhandler(500)
def internal_error(exc):
    return jsonify({"success": False, "error": "Internal server error."}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
