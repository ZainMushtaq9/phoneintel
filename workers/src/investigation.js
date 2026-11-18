// Investigation engine for the PhoneIntel Worker.
// Mirrors the Flask backend's run_investigation: every module returns
// a structured result with a status (SUCCESS / PARTIAL / NOT
// AVAILABLE / FAILED / NOT SUPPORTED), source, confidence, timestamp
// and error details. Modules run in parallel; a module failure never
// kills the report.
//
// Worker-specific honest limits (vs the Flask backend):
//  - carrier: always NOT AVAILABLE — the JS libphonenumber bundle has
//    no carrier mapper. The Flask backend can return a carrier.
//  - technical: PARTIAL at best — timezones are region-level
//    approximations and location is country-level only (no per-number
//    timezone data or city geocoder in the JS bundle).

import { lookupNumber, lookupIp, fetchOvhZones, ValidationError, LookupError } from './lookups.js';
import { OVH_COUNTRIES } from './data.js';
import { buildDorks } from './dorks.js';

export const SUCCESS = 'SUCCESS';
export const PARTIAL = 'PARTIAL';
export const NOT_AVAILABLE = 'NOT AVAILABLE';
export const FAILED = 'FAILED';
export const NOT_SUPPORTED = 'NOT SUPPORTED';

export const MODULE_RUNNERS = ['number', 'carrier', 'technical', 'ovh', 'public_osint', 'ip'];

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function moduleResult(name, label, status, source, confidence, data = null, error = null, detail = null) {
  return { name, label, status, source, confidence, timestamp: utcNow(), data, error, detail };
}

export function runNumberModule(info) {
  let detail = 'Parsed and validated against the public numbering plan. '
    + 'A valid format means the number matches its country\u2019s numbering '
    + 'pattern \u2014 it does not prove an active subscriber.';
  if (!info.is_valid) {
    detail += ' This number does NOT match a valid pattern for its '
      + 'numbering plan: it may be mistyped or unassigned.';
  }
  return moduleResult(
    'number', 'Number Information', SUCCESS,
    'libphonenumber (google-libphonenumber, offline)', 'high',
    {
      input: info.input,
      e164: info.formats.e164,
      international: info.formats.international,
      national: info.formats.national,
      rfc3966: info.formats.rfc3966,
      country: info.country,
      country_code: info.country_code,
      region_code: info.region_code,
      national_number: info.national_number,
      number_type: info.number_type,
      is_valid: info.is_valid,
      is_possible: info.is_possible,
    },
    null, detail,
  );
}

export function runCarrierModule() {
  // The JS libphonenumber bundle does not ship the carrier mapper, so
  // no carrier data exists in this runtime at all. This is a
  // NOT AVAILABLE (runtime limit), not a data gap for this number —
  // the Flask backend (Python phonenumbers) does carrier lookup.
  return moduleResult(
    'carrier', 'Carrier Information', NOT_AVAILABLE,
    'libphonenumber carrier data (not shipped in the JS bundle)', 'n/a', null, null,
    'Carrier lookup is not available in the Workers deployment: the '
    + 'JavaScript libphonenumber bundle has no carrier mapper. The '
    + 'local Flask backend in this repo does carrier lookup.',
  );
}

export function runTechnicalModule(info) {
  const timezones = info.timezones;
  const location = info.location;
  const data = {
    timezones,
    geographic_description: location,
    region_code: info.region_code,
    country: info.country,
    country_code: info.country_code,
    number_type: info.number_type,
    limitations: [
      'Timezone is a region-level approximation, not per-number data.',
      'The geographic description is the country the number range is assigned to \u2014 never a live position.',
      'No subscriber identity, address or live location can be derived from a phone number.',
    ],
  };
  // PARTIAL, never SUCCESS: the JS stack cannot give per-number
  // timezone or city-level geography, so this module's data is
  // approximate by construction.
  return moduleResult(
    'technical', 'Technical Information', PARTIAL,
    'libphonenumber (google-libphonenumber, offline) + region timezone table', 'medium',
    data, null,
    'Numbering metadata from the public numbering plan. Timezone is a '
    + 'region-level approximation and location is country-level only '
    + 'in this deployment.',
  );
}

export async function runOvhModule(info) {
  const label = 'OVH Number Zones';
  const source = 'OVH public telephony zones API (api.ovh.com, no key)';
  const countryCode = info.country_code;
  if (!(countryCode in OVH_COUNTRIES)) {
    return moduleResult(
      'ovh', label, NOT_AVAILABLE, source, 'n/a', null, null,
      'OVH publishes number zones only for France, Belgium, '
      + 'United Kingdom, Spain and Switzerland. This number\u2019s '
      + 'country is not covered.',
    );
  }
  const rawLocal = info.raw_local;
  if (rawLocal.length <= 6) {
    return moduleResult(
      'ovh', label, NOT_AVAILABLE, source, 'n/a', null, null,
      'This number is too short for range matching.',
    );
  }
  let zones;
  try {
    zones = await fetchOvhZones(OVH_COUNTRIES[countryCode]);
  } catch (err) {
    return moduleResult(
      'ovh', label, FAILED, source, 'n/a', null,
      err.message, 'The OVH zones service could not be reached.',
    );
  }
  const key = rawLocal.slice(0, 6) + 'xxxx';
  const match = zones.find((z) => z.number === key);
  if (match) {
    return moduleResult(
      'ovh', label, SUCCESS, source, 'medium',
      {
        found: true,
        number_range: match.number,
        city: match.city || 'Unknown',
        zip_code: match.zipCode || 'Unknown',
        country: (match.country || '').toUpperCase(),
      },
      null,
      'The number\u2019s range is listed in OVH\u2019s published zones. '
      + 'The city is the zone the range is assigned to \u2014 not a '
      + 'live position.',
    );
  }
  return moduleResult(
    'ovh', label, PARTIAL, source, 'low',
    { found: false, number_range: key },
    null,
    'The number\u2019s range was not found in OVH\u2019s published zones. '
    + 'OVH zones cover only part of the numbering plan, so this '
    + 'does not mean the number is unassigned.',
  );
}

export function runPublicOsintModule(info) {
  const dorks = buildDorks(info);
  const total = Object.values(dorks).reduce((n, links) => n + links.length, 0);
  const categories = {};
  for (const [name, links] of Object.entries(dorks)) {
    categories[name] = { count: links.length, links };
  }
  return moduleResult(
    'public_osint', 'Public OSINT (Search Links)', SUCCESS,
    'Google search query links (Phoneinfoga dork patterns)', 'n/a',
    { number: info.formats.e164, total_links: total, categories },
    null,
    'These are search-engine query links, not fetched findings. '
    + 'Open a link to see what Google has publicly indexed for '
    + 'this number. PhoneIntel does not fetch, store or interpret '
    + 'any search results.',
  );
}

export async function runIpModule(rawIp) {
  const label = 'IP Intelligence';
  const source = 'ipwho.is free API (no key)';
  if (!(rawIp || '').trim()) {
    return moduleResult(
      'ip', label, NOT_AVAILABLE, source, 'n/a', null, null,
      'No IP address was provided with this investigation. '
      + 'Enter one to run IP Intelligence \u2014 a phone owner\u2019s IP '
      + 'is never inferred from their phone number.',
    );
  }
  try {
    const data = await lookupIp(rawIp);
    return moduleResult(
      'ip', label, SUCCESS, source, 'medium', data, null,
      'Geolocation shows where the IP is registered (often the '
      + 'ISP\u2019s city), not a device\u2019s live position.',
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return moduleResult('ip', label, FAILED, source, 'n/a', null, err.message, 'The IP address could not be looked up.');
    }
    if (err instanceof LookupError) {
      return moduleResult('ip', label, FAILED, source, 'n/a', null, err.message, 'The IP lookup service could not be reached.');
    }
    return moduleResult('ip', label, FAILED, source, 'n/a', null, 'Unexpected IP lookup error.', 'The IP lookup service could not be reached.');
  }
}

export function notSupportedModules() {
  return {
    numverify: moduleResult(
      'numverify', 'Numverify Lookup', NOT_SUPPORTED,
      'Numverify commercial API (apilayer.com)', 'n/a', null, null,
      'Needs a Numverify API key, which is not configured in '
      + 'this build. Numverify is a paid service; its free tier '
      + 'still requires an API key.',
    ),
    googlecse: moduleResult(
      'googlecse', 'Google Custom Search', NOT_SUPPORTED,
      'Google Custom Search JSON API', 'n/a', null, null,
      'Needs a Google API key and a Custom Search Engine ID, '
      + 'which are not configured in this build. Use the Public '
      + 'OSINT search links instead \u2014 they run the same queries '
      + 'in your own browser.',
    ),
    ignorant: moduleResult(
      'ignorant', 'Account Registration Check', NOT_SUPPORTED,
      'Excluded by policy \u2014 see docs/ignorant-audit.md', 'n/a', null, null,
      'Deliberately excluded: ignorant checks whether a phone '
      + 'number is registered on Instagram, Snapchat and Amazon '
      + 'by probing their login/recovery endpoints. That is '
      + 'account enumeration, and PhoneIntel does not do it.',
    ),
  };
}

// Duplicate-request protection: identical investigations within 60
// seconds return the cached report instead of re-running modules.
// In-memory only, keyed by a SHA-256 hash of the inputs, never
// persisted. Per-isolate, like the Flask single-process cache.
const INVESTIGATION_CACHE_TTL = 60 * 1000;
const investigationCache = new Map();

async function cacheKey(e164, rawIp) {
  const input = e164 + '|' + (rawIp || '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cacheGet(key) {
  const now = Date.now();
  for (const [oldKey, entry] of investigationCache) {
    if (now - entry.at > INVESTIGATION_CACHE_TTL) investigationCache.delete(oldKey);
  }
  const hit = investigationCache.get(key);
  return hit ? structuredClone(hit.report) : null;
}

function cachePut(key, report) {
  investigationCache.set(key, { at: Date.now(), report: structuredClone(report) });
}

export async function runInvestigation(rawNumber, regionHint, rawIp) {
  // Parse once up front: an unparseable number is a request error
  // (400), and its E.164 form is the dedup cache key.
  const info = lookupNumber(rawNumber, regionHint);
  const key = await cacheKey(info.formats.e164, (rawIp || '').trim());
  const cached = cacheGet(key);
  if (cached) {
    cached.duplicate = true;
    return { report: cached, duplicate: true };
  }

  const runners = {
    number: () => runNumberModule(info),
    carrier: () => runCarrierModule(info),
    technical: () => runTechnicalModule(info),
    ovh: () => runOvhModule(info),
    public_osint: () => runPublicOsintModule(info),
    ip: () => runIpModule(rawIp),
  };
  const results = await Promise.allSettled(
    MODULE_RUNNERS.map((name) => runners[name]()),
  );
  const modules = {};
  MODULE_RUNNERS.forEach((name, i) => {
    const settled = results[i];
    if (settled.status === 'fulfilled') {
      modules[name] = settled.value;
    } else {
      // A module must never kill the report.
      modules[name] = moduleResult(
        name, name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), FAILED,
        'PhoneIntel investigation engine', 'n/a', null,
        'Module crashed: ' + (settled.reason && settled.reason.message ? settled.reason.message : 'unknown error'),
        'Unexpected module error. Use retry to run it again.',
      );
    }
  });

  // Fixed display order, then the modules that cannot run in this build.
  const ordered = { ...modules, ...notSupportedModules() };

  const counts = { total: Object.keys(ordered).length };
  for (const mod of Object.values(ordered)) {
    const k = mod.status.toLowerCase().replace(/ /g, '_');
    counts[k] = (counts[k] || 0) + 1;
  }

  const report = {
    investigation_id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    timestamp: utcNow(),
    input: {
      number: info.formats.e164,
      country_hint: regionHint || null,
      ip: (rawIp || '').trim() || null,
    },
    summary: counts,
    modules: ordered,
  };
  cachePut(key, report);
  return { report, duplicate: false };
}

export async function runSingleModule(name, rawNumber, regionHint, rawIp) {
  if (name === 'ip') return runIpModule(rawIp);
  const info = lookupNumber(rawNumber, regionHint);
  const runners = {
    number: () => runNumberModule(info),
    carrier: () => runCarrierModule(info),
    technical: () => runTechnicalModule(info),
    ovh: () => runOvhModule(info),
    public_osint: () => runPublicOsintModule(info),
  };
  return runners[name]();
}
