// Lookups for the PhoneIntel Worker. Mirrors the Flask backend's
// lookup_number / lookup_ip / lookup_username / OVH zones, with the
// honest limits of the JavaScript stack stated where they bite:
//
//  - No carrier lookup: the google-libphonenumber bundle does not
//    ship the carrier mapper, so carrier is always "Unknown" here.
//    The Flask backend (Python phonenumbers) does carrier lookup.
//  - No per-number timezone or city geocoder: timezones come from
//    the region-level REGION_TIMEZONES table (labelled approximate),
//    and location is country-level only.

// Default import + destructure: the package is a UMD bundle, and
// Node's ESM loader cannot detect all its named exports (it misses
// PhoneNumberFormat). esbuild (wrangler) and Node both handle the
// default import of a CJS module correctly.
import libphonenumber from 'google-libphonenumber';
const { PhoneNumberUtil, PhoneNumberFormat } = libphonenumber;
import {
  countryName, REGION_TIMEZONES, NUMBER_TYPE_NAMES,
  USERNAME_SITES, SITE_HEADERS, OVH_COUNTRIES,
} from './data.js';

// Thrown for bad user input (HTTP 400); LookupError is for a failed
// upstream service (HTTP 502 / module FAILED).
export class ValidationError extends Error {}
export class LookupError extends Error {}

const phoneUtil = PhoneNumberUtil.getInstance();

export function lookupNumber(rawNumber, region) {
  rawNumber = (rawNumber || '').trim();
  if (!rawNumber) throw new ValidationError('Please enter a phone number.');

  // 'ZZ' = unknown region: the number must carry its own country
  // code (e.g. +92 ...), same rule as the Flask app.
  let parsed;
  try {
    parsed = phoneUtil.parse(rawNumber, region || 'ZZ');
  } catch (err) {
    throw new ValidationError(err && err.message ? err.message : 'Could not parse the phone number.');
  }

  const countryCode = parsed.getCountryCode();
  const nationalNumber = String(parsed.getNationalNumber());
  const regionCode = phoneUtil.getRegionCodeForNumber(parsed) || 'Unknown';
  const nationalFmt = phoneUtil.format(parsed, PhoneNumberFormat.NATIONAL);
  const e164 = phoneUtil.format(parsed, PhoneNumberFormat.E164);

  return {
    input: rawNumber,
    is_possible: phoneUtil.isPossibleNumber(parsed),
    is_valid: phoneUtil.isValidNumber(parsed),
    number_type: NUMBER_TYPE_NAMES[phoneUtil.getNumberType(parsed)] || 'Unknown',
    country_code: countryCode,
    national_number: nationalNumber,
    region_code: regionCode,
    country: countryName(regionCode),
    // Country-level only: the JS bundle has no city/area geocoder.
    location: countryName(regionCode),
    // Unavailable: the JS bundle has no carrier mapper.
    carrier: 'Unknown',
    // Approximate: region-level table, not per-number data.
    timezones: REGION_TIMEZONES[regionCode] ? [...REGION_TIMEZONES[regionCode]] : [],
    formats: {
      e164,
      international: phoneUtil.format(parsed, PhoneNumberFormat.INTERNATIONAL),
      national: nationalFmt,
      rfc3966: phoneUtil.format(parsed, PhoneNumberFormat.RFC3966),
    },
    // Phoneinfoga-style derived forms, used by the dork and OVH
    // modules. raw_local is the national number as dialled locally
    // (digits only, trunk prefix kept, e.g. "03001234567").
    raw_local: nationalFmt.replace(/\D/g, ''),
    international_digits: e164.replace(/\D/g, ''),
  };
}

// ------------------------------------------------------------------ IP ---
// Upstream bases are overridable for local testing only: in some
// sandboxes workerd cannot reach the public internet directly (it
// does not use the shell's HTTP proxy), so `wrangler dev` can point
// at a local mock (see test/mock-upstream.mjs and .dev.vars). In
// production no env vars are set and the real public APIs are used.

let IPWHOIS_BASE = 'https://ipwho.is';
let OVH_BASE = 'https://api.ovh.com/1.0/telephony/number/detailedZones';

export function configureUpstreams(env = {}) {
  if (typeof env.IPWHOIS_BASE === 'string' && env.IPWHOIS_BASE) {
    IPWHOIS_BASE = env.IPWHOIS_BASE.replace(/\/$/, '');
  }
  if (typeof env.OVH_BASE === 'string' && env.OVH_BASE) {
    OVH_BASE = env.OVH_BASE.replace(/\/$/, '');
  }
}

const IP_TIMEOUT = 8000; // ms
const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const IPV6_RE = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

export async function lookupIp(rawIp) {
  rawIp = (rawIp || '').trim();
  if (!rawIp) throw new ValidationError('Please enter an IP address.');
  if (!IPV4_RE.test(rawIp) && !IPV6_RE.test(rawIp)) {
    throw new ValidationError("'" + rawIp + "' is not a valid IP address.");
  }

  let data;
  try {
    const resp = await fetch(IPWHOIS_BASE + '/' + encodeURIComponent(rawIp), {
      headers: { 'User-Agent': 'PhoneIntel/1.0' },
      signal: AbortSignal.timeout(IP_TIMEOUT),
    });
    if (!resp.ok) throw new LookupError('The IP lookup service returned HTTP ' + resp.status + '.');
    data = await resp.json();
  } catch (err) {
    if (err instanceof LookupError) throw err;
    if (err && err.name === 'TimeoutError') {
      throw new LookupError('The IP lookup service timed out. Please try again.');
    }
    throw new LookupError('Could not reach the IP lookup service. Check your connection and try again.');
  }

  if (!data.success) {
    // ipwho.is reports reserved/private/invalid IPs this way.
    throw new ValidationError(data.message || 'IP lookup failed.');
  }

  const connection = data.connection || {};
  const tz = data.timezone || {};
  const flag = data.flag || {};
  const lat = data.latitude;
  const lon = data.longitude;

  // ipwho.is does not return a current-time field; derive it from the
  // UTC offset (seconds) it does return.
  let currentTime = 'Unknown';
  if (typeof tz.offset === 'number') {
    currentTime = new Date(Date.now() + tz.offset * 1000)
      .toISOString().slice(0, 16).replace('T', ' ');
  }

  return {
    ip: data.ip || rawIp,
    type: data.type || 'Unknown',
    country: data.country || 'Unknown',
    country_code: data.country_code || 'Unknown',
    region: data.region || 'Unknown',
    city: data.city || 'Unknown',
    postal: data.postal || 'Unknown',
    latitude: lat,
    longitude: lon,
    maps_url: (lat != null && lon != null)
      ? 'https://www.google.com/maps/@' + lat + ',' + lon + ',8z'
      : null,
    continent: data.continent || 'Unknown',
    is_eu: data.is_eu,
    calling_code: data.calling_code || 'Unknown',
    capital: data.capital || 'Unknown',
    flag_emoji: flag.emoji || '',
    asn: connection.asn || 'Unknown',
    org: connection.org || 'Unknown',
    isp: connection.isp || 'Unknown',
    domain: connection.domain || 'Unknown',
    timezone_id: tz.id || 'Unknown',
    timezone_abbr: tz.abbr || 'Unknown',
    timezone_utc: tz.utc || 'Unknown',
    current_time: currentTime,
  };
}

// ------------------------------------------------------------- username ---

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SITE_TIMEOUT = 6000; // ms per site

async function checkSite([name, urlTemplate], username) {
  const url = urlTemplate.replace('{}', username);
  let status;
  try {
    const resp = await fetch(url, {
      headers: SITE_HEADERS,
      signal: AbortSignal.timeout(SITE_TIMEOUT),
    });
    status = resp.status;
    // Status only — never read the page body. Cancel the stream so
    // the connection is released.
    if (resp.body) resp.body.cancel().catch(() => {});
  } catch (err) {
    return {
      site: name, url, status: 'unknown',
      detail: err && err.name === 'TimeoutError' ? 'timed out' : 'request failed',
    };
  }

  if (status === 200) {
    return { site: name, url, status: 'found', detail: 'profile URL responded (HTTP 200)' };
  }
  if (status === 404 || status === 410) {
    return { site: name, url, status: 'not_found', detail: 'HTTP ' + status };
  }
  return { site: name, url, status: 'unknown', detail: 'HTTP ' + status + ' — could not verify' };
}

export async function lookupUsername(rawUsername) {
  const username = (rawUsername || '').trim().replace(/^@+/, '');
  if (!username) throw new ValidationError('Please enter a username.');
  if (!USERNAME_RE.test(username)) {
    throw new ValidationError(
      "Usernames may only contain letters, digits, '.', '_' and '-', up to 64 characters.",
    );
  }

  // 19 parallel subrequests — under the Workers free-plan limit of
  // 50 subrequests per request.
  const results = await Promise.all(
    USERNAME_SITES.map((site) => checkSite(site, username)),
  );
  return {
    username,
    results,
    found: results.filter((r) => r.status === 'found').length,
    not_found: results.filter((r) => r.status === 'not_found').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
  };
}

// ------------------------------------------------------------ OVH zones ---

const OVH_TIMEOUT = 20000; // ms (the FR zone list is ~85 KB)
const OVH_CACHE_TTL = 3600 * 1000; // zone lists change rarely

// In-memory cache, per Worker isolate. Best-effort: a cold isolate
// refetches. Nothing is persisted.
const ovhCache = new Map();

export async function fetchOvhZones(countryIso) {
  const now = Date.now();
  const cached = ovhCache.get(countryIso);
  if (cached && now - cached.at < OVH_CACHE_TTL) return cached.zones;
  let zones;
  try {
    const resp = await fetch(OVH_BASE + '?country=' + countryIso, {
      headers: { 'User-Agent': 'PhoneIntel/1.0' },
      signal: AbortSignal.timeout(OVH_TIMEOUT),
    });
    if (!resp.ok) throw new LookupError('The OVH zones service returned HTTP ' + resp.status + '.');
    zones = await resp.json();
  } catch (err) {
    if (err instanceof LookupError) throw err;
    if (err && err.name === 'TimeoutError') {
      throw new LookupError('The OVH zones service timed out.');
    }
    throw new LookupError('Could not reach the OVH zones service.');
  }
  if (!Array.isArray(zones)) {
    throw new LookupError('The OVH zones service returned unexpected data.');
  }
  ovhCache.set(countryIso, { at: now, zones });
  return zones;
}

export { OVH_COUNTRIES };
