/* PhoneIntel frontend (GitHub Pages).
 *
 * Two modes, always labelled:
 *  - API mode: the Cloudflare Worker (see config.js) runs the full
 *    investigation — phone analysis, OVH zones, IP intelligence,
 *    search links and username checks.
 *  - Offline mode: when the Worker is not configured or unreachable,
 *    phone analysis runs in the browser via the google-libphonenumber
 *    CDN library, IP lookup calls ipwho.is directly (CORS verified),
 *    OVH zones are fetched from the browser (CORS verified), and the
 *    Username Tracker explains that it needs the API (browsers cannot
 *    read other sites' HTTP status). Nothing is faked in either mode.
 *
 * PDF export runs client-side with jsPDF (CDN); JSON export is a
 * client-side download. No data leaves the browser except the API
 * calls the user starts.
 */
(function () {
  'use strict';

  /* ============================ data tables ============================ */

  var NUMBER_TYPE_NAMES = {
    '-1': 'Unknown',
    0: 'Fixed line',
    1: 'Mobile',
    2: 'Fixed line or mobile',
    3: 'Toll free',
    4: 'Premium rate',
    5: 'Shared cost',
    6: 'VOIP',
    7: 'Personal number',
    8: 'Pager',
    9: 'UAN',
    10: 'Voicemail'
  };

  /* Approximate primary timezone(s) per region code. Regions not
   * listed here show "Unknown" — never a guess. */
  var REGION_TIMEZONES = {
    AE: ['Asia/Dubai'],
    AF: ['Asia/Kabul'],
    AR: ['America/Argentina/Buenos_Aires'],
    AT: ['Europe/Vienna'],
    AU: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide'],
    BD: ['Asia/Dhaka'],
    BE: ['Europe/Brussels'],
    BH: ['Asia/Bahrain'],
    BR: ['America/Sao_Paulo', 'America/Fortaleza', 'America/Manaus'],
    CA: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax'],
    CH: ['Europe/Zurich'],
    CL: ['America/Santiago'],
    CN: ['Asia/Shanghai'],
    CO: ['America/Bogota'],
    CZ: ['Europe/Prague'],
    DE: ['Europe/Berlin'],
    DK: ['Europe/Copenhagen'],
    EG: ['Africa/Cairo'],
    ES: ['Europe/Madrid'],
    FI: ['Europe/Helsinki'],
    FR: ['Europe/Paris'],
    GB: ['Europe/London'],
    GR: ['Europe/Athens'],
    HK: ['Asia/Hong_Kong'],
    HU: ['Europe/Budapest'],
    ID: ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'],
    IE: ['Europe/Dublin'],
    IL: ['Asia/Jerusalem'],
    IN: ['Asia/Kolkata'],
    IQ: ['Asia/Baghdad'],
    IR: ['Asia/Tehran'],
    IS: ['Atlantic/Reykjavik'],
    IT: ['Europe/Rome'],
    JO: ['Asia/Amman'],
    JP: ['Asia/Tokyo'],
    KE: ['Africa/Nairobi'],
    KR: ['Asia/Seoul'],
    KW: ['Asia/Kuwait'],
    KZ: ['Asia/Almaty'],
    LK: ['Asia/Colombo'],
    MA: ['Africa/Casablanca'],
    MX: ['America/Mexico_City', 'America/Monterrey', 'America/Tijuana'],
    MY: ['Asia/Kuala_Lumpur'],
    NG: ['Africa/Lagos'],
    NL: ['Europe/Amsterdam'],
    NO: ['Europe/Oslo'],
    NP: ['Asia/Kathmandu'],
    NZ: ['Pacific/Auckland'],
    OM: ['Asia/Muscat'],
    PE: ['America/Lima'],
    PH: ['Asia/Manila'],
    PK: ['Asia/Karachi'],
    PL: ['Europe/Warsaw'],
    PT: ['Europe/Lisbon'],
    QA: ['Asia/Qatar'],
    RO: ['Europe/Bucharest'],
    RU: ['Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Vladivostok'],
    SA: ['Asia/Riyadh'],
    SE: ['Europe/Stockholm'],
    SG: ['Asia/Singapore'],
    TH: ['Asia/Bangkok'],
    TR: ['Europe/Istanbul'],
    TW: ['Asia/Taipei'],
    UA: ['Europe/Kyiv'],
    US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
    UZ: ['Asia/Tashkent'],
    VN: ['Asia/Ho_Chi_Minh'],
    ZA: ['Africa/Johannesburg']
  };

  var OVH_COUNTRIES = { 33: 'fr', 32: 'be', 44: 'gb', 34: 'es', 41: 'ch' };

  var regionNames = null;
  try {
    regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch (e) {
    regionNames = null;
  }

  function countryName(regionCode) {
    if (!regionCode || regionCode === 'Unknown') return 'Unknown';
    if (regionNames) {
      try {
        return regionNames.of(regionCode) || regionCode;
      } catch (e) {
        return regionCode;
      }
    }
    return regionCode;
  }

  /* ============================ phone lookup ============================ */

  function lookup(rawNumber, region) {
    var lib = window.libphonenumber;
    var util = lib.PhoneNumberUtil.getInstance();
    var formats = lib.PhoneNumberFormat;

    rawNumber = (rawNumber || '').trim();
    if (!rawNumber) throw new Error('Please enter a phone number.');

    /* 'ZZ' = unknown region: the number must carry its own country
     * code (e.g. +92 ...), same rule as the backends. */
    var parsed = util.parse(rawNumber, region || 'ZZ');
    var regionCode = util.getRegionCodeForNumber(parsed) || 'Unknown';
    var nationalFmt = util.format(parsed, formats.NATIONAL);
    var e164 = util.format(parsed, formats.E164);

    return {
      input: rawNumber,
      is_possible: util.isPossibleNumber(parsed),
      is_valid: util.isValidNumber(parsed),
      number_type: NUMBER_TYPE_NAMES[util.getNumberType(parsed)] || 'Unknown',
      country_code: parsed.getCountryCode(),
      national_number: String(parsed.getNationalNumber()),
      region_code: regionCode,
      country: countryName(regionCode),
      location: countryName(regionCode),
      carrier: 'Unknown',
      timezones: REGION_TIMEZONES[regionCode] ? REGION_TIMEZONES[regionCode].slice() : [],
      formats: {
        e164: e164,
        international: util.format(parsed, formats.INTERNATIONAL),
        national: nationalFmt,
        rfc3966: util.format(parsed, formats.RFC3966)
      },
      raw_local: nationalFmt.replace(/\D/g, ''),
      international_digits: e164.replace(/\D/g, '')
    };
  }

  /* ============================ dork links ============================ */
  /* Phoneinfoga's googlesearch patterns. Pure string building: generates
   * Google search URLs for the number. Nothing is fetched — the user
   * opens a link to see what Google has publicly indexed. Byte-identical
   * to the Python and Worker backends (verified against Phoneinfoga's
   * own test vectors). */

  var DISPOSABLE_SMS_SITES = [
    'hs3x.com', 'receive-sms-now.com', 'smslisten.com',
    'smsnumbersonline.com', 'freesmscode.com', 'catchsms.com',
    'smstibo.com', 'smsreceiving.com', 'getfreesmsnumber.com',
    'sellaite.com', 'receive-sms-online.info', 'receivesmsonline.com',
    'receive-a-sms.com', 'sms-receive.net', 'receivefreesms.com',
    'receive-sms.com', 'receivetxt.com', 'freephonenum.com',
    'freesmsverification.com', 'receive-sms-online.com', 'smslive.co'
  ];

  var FILE_EXTENSIONS = [
    'doc', 'docx', 'odt', 'pdf', 'rtf', 'sxw', 'psw', 'ppt', 'pptx',
    'pps', 'csv', 'txt', 'xls'
  ];

  function dorkUrl(dork) {
    // Matches Python quote_plus exactly: encodeURIComponent leaves
    // ( ) ! ' * unescaped, quote_plus percent-encodes them.
    return 'https://www.google.com/search?q=' + encodeURIComponent(dork)
      .replace(/%20/g, '+')
      .replace(/\(/g, '%28').replace(/\)/g, '%29')
      .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\*/g, '%2A');
  }

  function intext() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      parts.push('intext:"' + arguments[i] + '"');
    }
    return parts.join(' | ');
  }

  function buildDorks(info) {
    var e164 = info.formats.e164;
    var intl = info.international_digits;
    var rawLocal = info.raw_local;
    var localFmt = info.formats.national;

    function link(dork) {
      return { dork: dork, url: dorkUrl(dork) };
    }

    var social = ['facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'vk.com']
      .map(function (site) {
        return link('site:' + site + ' ' + intext(intl, e164, rawLocal));
      });

    var disposable = [link('site:hs3x.com intext:"' + intl + '"')];
    DISPOSABLE_SMS_SITES.slice(1).forEach(function (site) {
      disposable.push(link('site:' + site + ' ' + intext(intl, rawLocal)));
    });

    var reputation = [
      link('site:whosenumber.info intext:"' + e164 + '" intitle:"who called"'),
      link('intitle:"Phone Fraud" ' + intext(intl, e164, rawLocal)),
      link('site:findwhocallsme.com intext:"' + e164 + '" | intext:"' + intl + '"'),
      link('site:yellowpages.ca intext:"' + e164 + '"'),
      link('site:phonenumbers.ie intext:"' + e164 + '"'),
      link('site:who-calledme.com intext:"' + e164 + '"'),
      link('site:usphonesearch.net intext:"' + rawLocal + '"'),
      link('site:whocalled.us inurl:' + rawLocal),
      link('site:quinumero.info intext:"' + rawLocal + '" | intext:"' + intl + '"'),
      link('site:uk.popularphotolook.com inurl:' + rawLocal)
    ];

    var individuals = ['numinfo.net', 'sync.me', 'pastebin.com', 'whycall.me', 'locatefamily.com']
      .map(function (site) {
        return link('site:' + site + ' ' + intext(intl, e164, rawLocal));
      });
    individuals.push(link('site:whocallsyou.de intext:"' + rawLocal + '"'));
    individuals.push(link('site:spytox.com intext:"' + rawLocal + '"'));

    var filetypes = '(' + FILE_EXTENSIONS.map(function (e) { return 'ext:' + e; }).join(' | ') + ')';
    var general = [
      link(intext(intl, e164, rawLocal, localFmt)),
      link(filetypes + ' ' + intext(intl, e164, rawLocal))
    ];

    return {
      social_media: social,
      disposable_providers: disposable,
      reputation: reputation,
      individuals: individuals,
      general: general
    };
  }

  /* ====================== local (offline) report ====================== */
  /* Builds the same report shape as the Worker, in the browser. Used
   * when the Worker is not configured or unreachable. */

  function utcNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function randomId() {
    var hex = '';
    var bytes = new Uint8Array(6);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (var j = 0; j < bytes.length; j++) {
      hex += ('0' + bytes[j].toString(16)).slice(-2);
    }
    return hex;
  }

  function moduleResult(name, label, status, source, confidence, data, error, detail) {
    return {
      name: name, label: label, status: status, source: source,
      confidence: confidence, timestamp: utcNow(),
      data: data || null, error: error || null, detail: detail || null
    };
  }

  function notSupportedModules() {
    return {
      numverify: moduleResult('numverify', 'Numverify Lookup', 'NOT SUPPORTED',
        'Numverify commercial API (apilayer.com)', 'n/a', null, null,
        'Needs a Numverify API key, which is not configured in this build. Numverify is a paid service; its free tier still requires an API key.'),
      googlecse: moduleResult('googlecse', 'Google Custom Search', 'NOT SUPPORTED',
        'Google Custom Search JSON API', 'n/a', null, null,
        'Needs a Google API key and a Custom Search Engine ID, which are not configured in this build. Use the Public OSINT search links instead — they run the same queries in your own browser.'),
      ignorant: moduleResult('ignorant', 'Account Registration Check', 'NOT SUPPORTED',
        'Excluded by policy — see docs/ignorant-audit.md', 'n/a', null, null,
        'Deliberately excluded: ignorant checks whether a phone number is registered on Instagram, Snapchat and Amazon by probing their login/recovery endpoints. That is account enumeration, and PhoneIntel does not do it.')
    };
  }

  function localNumberModule(info) {
    var detail = 'Parsed and validated against the public numbering plan. '
      + 'A valid format means the number matches its country\u2019s numbering '
      + 'pattern \u2014 it does not prove an active subscriber.';
    if (!info.is_valid) {
      detail += ' This number does NOT match a valid pattern for its '
        + 'numbering plan: it may be mistyped or unassigned.';
    }
    return moduleResult('number', 'Number Information', 'SUCCESS',
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
        is_possible: info.is_possible
      },
      null, detail);
  }

  function localCarrierModule() {
    return moduleResult('carrier', 'Carrier Information', 'NOT AVAILABLE',
      'libphonenumber carrier data (not shipped in the JS bundle)', 'n/a', null, null,
      'Carrier lookup is not available in the browser or Workers deployment: the JavaScript libphonenumber bundle has no carrier mapper. The local Flask backend in this repo does carrier lookup.');
  }

  function localTechnicalModule(info) {
    return moduleResult('technical', 'Technical Information', 'PARTIAL',
      'libphonenumber (google-libphonenumber, offline) + region timezone table', 'medium',
      {
        timezones: info.timezones,
        geographic_description: info.location,
        region_code: info.region_code,
        country: info.country,
        country_code: info.country_code,
        number_type: info.number_type,
        limitations: [
          'Timezone is a region-level approximation, not per-number data.',
          'The geographic description is the country the number range is assigned to \u2014 never a live position.',
          'No subscriber identity, address or live location can be derived from a phone number.'
        ]
      },
      null,
      'Numbering metadata from the public numbering plan. Timezone is a region-level approximation and location is country-level only in this deployment.');
  }

  function localOsintModule(info) {
    var dorks = buildDorks(info);
    var total = 0;
    var categories = {};
    Object.keys(dorks).forEach(function (name) {
      total += dorks[name].length;
      categories[name] = { count: dorks[name].length, links: dorks[name] };
    });
    return moduleResult('public_osint', 'Public OSINT (Search Links)', 'SUCCESS',
      'Google search query links (Phoneinfoga dork patterns)', 'n/a',
      { number: info.formats.e164, total_links: total, categories: categories },
      null,
      'These are search-engine query links, not fetched findings. Open a link to see what Google has publicly indexed for this number. PhoneIntel does not fetch, store or interpret any search results.');
  }

  function fetchWithTimeout(url, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return fetch(url, { signal: controller.signal }).finally(function () {
      clearTimeout(timer);
    });
  }

  function localOvhModule(info) {
    var label = 'OVH Number Zones';
    var source = 'OVH public telephony zones API (api.ovh.com, no key)';
    var countryIso = OVH_COUNTRIES[info.country_code];
    if (!countryIso) {
      return Promise.resolve(moduleResult('ovh', label, 'NOT AVAILABLE', source, 'n/a', null, null,
        'OVH publishes number zones only for France, Belgium, United Kingdom, Spain and Switzerland. This number\u2019s country is not covered.'));
    }
    var rawLocal = info.raw_local;
    if (rawLocal.length <= 6) {
      return Promise.resolve(moduleResult('ovh', label, 'NOT AVAILABLE', source, 'n/a', null, null,
        'This number is too short for range matching.'));
    }
    return fetchWithTimeout('https://api.ovh.com/1.0/telephony/number/detailedZones?country=' + countryIso, 20000)
      .then(function (resp) {
        if (!resp.ok) throw new Error('The OVH zones service returned HTTP ' + resp.status + '.');
        return resp.json();
      })
      .then(function (zones) {
        var key = rawLocal.slice(0, 6) + 'xxxx';
        var match = null;
        for (var i = 0; i < zones.length; i++) {
          if (zones[i].number === key) { match = zones[i]; break; }
        }
        if (match) {
          return moduleResult('ovh', label, 'SUCCESS', source, 'medium',
            {
              found: true,
              number_range: match.number,
              city: match.city || 'Unknown',
              zip_code: match.zipCode || 'Unknown',
              country: (match.country || '').toUpperCase()
            },
            null,
            'The number\u2019s range is listed in OVH\u2019s published zones. The city is the zone the range is assigned to \u2014 not a live position.');
        }
        return moduleResult('ovh', label, 'PARTIAL', source, 'low',
          { found: false, number_range: key },
          null,
          'The number\u2019s range was not found in OVH\u2019s published zones. OVH zones cover only part of the numbering plan, so this does not mean the number is unassigned.');
      })
      .catch(function (err) {
        return moduleResult('ovh', label, 'FAILED', source, 'n/a', null,
          err && err.name === 'AbortError' ? 'The OVH zones service timed out.' : 'Could not reach the OVH zones service.',
          'The OVH zones service could not be reached.');
      });
  }

  var IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
  var IPV6_RE = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

  function mapIpData(d, rawIp) {
    var connection = d.connection || {};
    var tz = d.timezone || {};
    var flag = d.flag || {};
    var currentTime = 'Unknown';
    if (typeof tz.offset === 'number') {
      currentTime = new Date(Date.now() + tz.offset * 1000)
        .toISOString().slice(0, 16).replace('T', ' ');
    }
    return {
      ip: d.ip || rawIp,
      type: d.type || 'Unknown',
      country: d.country || 'Unknown',
      country_code: d.country_code || 'Unknown',
      region: d.region || 'Unknown',
      city: d.city || 'Unknown',
      postal: d.postal || 'Unknown',
      latitude: d.latitude,
      longitude: d.longitude,
      maps_url: (d.latitude != null && d.longitude != null)
        ? 'https://www.google.com/maps/@' + d.latitude + ',' + d.longitude + ',8z'
        : null,
      continent: d.continent || 'Unknown',
      is_eu: d.is_eu,
      calling_code: d.calling_code || 'Unknown',
      capital: d.capital || 'Unknown',
      flag_emoji: flag.emoji || '',
      asn: connection.asn || 'Unknown',
      org: connection.org || 'Unknown',
      isp: connection.isp || 'Unknown',
      domain: connection.domain || 'Unknown',
      timezone_id: tz.id || 'Unknown',
      timezone_abbr: tz.abbr || 'Unknown',
      timezone_utc: tz.utc || 'Unknown',
      current_time: currentTime
    };
  }

  function localIpModule(rawIp) {
    var label = 'IP Intelligence';
    var source = 'ipwho.is free API (no key)';
    rawIp = (rawIp || '').trim();
    if (!rawIp) {
      return Promise.resolve(moduleResult('ip', label, 'NOT AVAILABLE', source, 'n/a', null, null,
        'No IP address was provided with this investigation. Enter one to run IP Intelligence — a phone owner\u2019s IP is never inferred from their phone number.'));
    }
    if (!IPV4_RE.test(rawIp) && !IPV6_RE.test(rawIp)) {
      return Promise.resolve(moduleResult('ip', label, 'FAILED', source, 'n/a', null,
        "'" + rawIp + "' is not a valid IP address.",
        'The IP address could not be looked up.'));
    }
    return fetchWithTimeout('https://ipwho.is/' + encodeURIComponent(rawIp), 8000)
      .then(function (resp) {
        if (!resp.ok) throw new Error('The IP lookup service returned HTTP ' + resp.status + '.');
        return resp.json();
      })
      .then(function (d) {
        if (!d.success) throw new Error(d.message || 'IP lookup failed.');
        return moduleResult('ip', label, 'SUCCESS', source, 'medium', mapIpData(d, rawIp), null,
          'Geolocation shows where the IP is registered (often the ISP\u2019s city), not a device\u2019s live position.');
      })
      .catch(function (err) {
        return moduleResult('ip', label, 'FAILED', source, 'n/a', null,
          err && err.message ? err.message : 'Could not reach the IP lookup service.',
          'The IP lookup service could not be reached.');
      });
  }

  var MODULE_ORDER = ['number', 'carrier', 'technical', 'ovh', 'public_osint', 'ip', 'numverify', 'googlecse', 'ignorant'];

  function buildLocalReport(rawNumber, regionHint, rawIp) {
    var info = lookup(rawNumber, regionHint);
    return Promise.all([localOvhModule(info), localIpModule(rawIp)])
      .then(function (results) {
        var modules = {
          number: localNumberModule(info),
          carrier: localCarrierModule(),
          technical: localTechnicalModule(info),
          ovh: results[0],
          public_osint: localOsintModule(info),
          ip: results[1]
        };
        var ordered = {};
        MODULE_ORDER.forEach(function (name) {
          if (modules[name]) ordered[name] = modules[name];
        });
        var ns = notSupportedModules();
        Object.keys(ns).forEach(function (name) { ordered[name] = ns[name]; });

        var counts = { total: Object.keys(ordered).length };
        Object.keys(ordered).forEach(function (name) {
          var k = ordered[name].status.toLowerCase().replace(/ /g, '_');
          counts[k] = (counts[k] || 0) + 1;
        });

        return {
          investigation_id: randomId(),
          timestamp: utcNow(),
          mode: 'local',
          input: {
            number: info.formats.e164,
            country_hint: regionHint || null,
            ip: (rawIp || '').trim() || null
          },
          summary: counts,
          modules: ordered
        };
      });
  }

  /* Expose the pure functions for node-based testing. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      REGION_TIMEZONES: REGION_TIMEZONES,
      NUMBER_TYPE_NAMES: NUMBER_TYPE_NAMES,
      OVH_COUNTRIES: OVH_COUNTRIES,
      buildDorks: buildDorks,
      lookup: lookup,
      buildLocalReport: buildLocalReport,
      notSupportedModules: notSupportedModules
    };
  }

  if (typeof document === 'undefined') return;

  /* ============================ API layer ============================ */

  function workerUrl() {
    var url = (window.PHONEINTEL_WORKER_URL || '').trim();
    return url.replace(/\/$/, '');
  }

  function workerConfigured() {
    var url = workerUrl();
    return !!url && url.indexOf('YOUR-SUBDOMAIN') === -1;
  }

  function apiPost(path, body) {
    return fetch(workerUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.json().then(function (payload) {
        return { status: resp.status, payload: payload };
      });
    });
  }

  function apiGet(path) {
    return fetch(workerUrl() + path).then(function (resp) {
      return resp.json().then(function (payload) {
        return { status: resp.status, payload: payload };
      });
    });
  }

  /* ============================ UI helpers ============================ */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }
  function statusClass(status) {
    return 'badge st-' + status.toLowerCase().replace(/ /g, '-');
  }
  function dlRow(term, value) {
    return '<dt>' + esc(term) + '</dt><dd>' + esc(value) + '</dd>';
  }

  var MODULE_LABELS = {
    number: 'A. Number Information',
    carrier: 'B. Carrier Information',
    technical: 'D. Technical Information',
    ovh: 'OVH Number Zones',
    public_osint: 'C. Public OSINT',
    ip: 'E. IP Intelligence',
    numverify: 'Numverify Lookup',
    googlecse: 'Google Custom Search',
    ignorant: 'Account Registration Check'
  };
  var lastReport = null;
  var lastInputs = null;
  var lastMode = null; // 'worker' or 'local'

  function setModeBanner(text) {
    setText('mode-banner', text);
  }

  /* ============================ module cards ============================ */

  function moduleBody(mod) {
    var d = mod.data || {};
    var html = '';
    if (mod.name === 'number' && d.e164) {
      html += '<dl>' + dlRow('International', d.international) + dlRow('National', d.national)
        + dlRow('E.164', d.e164) + dlRow('RFC 3966', d.rfc3966) + dlRow('Country', d.country + ' (' + d.region_code + ')')
        + dlRow('Country code', '+' + d.country_code) + dlRow('National number', d.national_number)
        + dlRow('Type', d.number_type) + dlRow('Valid', d.is_valid ? 'Yes' : 'No')
        + dlRow('Possible', d.is_possible ? 'Yes' : 'No') + '</dl>';
    } else if (mod.name === 'carrier' && d.carrier) {
      html += '<dl>' + dlRow('Carrier', d.carrier) + '</dl>';
    } else if (mod.name === 'technical' && d.timezones) {
      html += '<dl>' + dlRow('Timezone(s)', d.timezones.length ? d.timezones.join(', ') : 'Unknown')
        + dlRow('Geographic description', d.geographic_description)
        + dlRow('Region', d.country + ' (' + d.region_code + ')') + '</dl>';
      if (d.limitations && d.limitations.length) {
        html += '<details><summary>Source limitations</summary><ul>'
          + d.limitations.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>';
      }
    } else if (mod.name === 'ovh' && d.found) {
      html += '<dl>' + dlRow('Number range', d.number_range) + dlRow('City', d.city)
        + dlRow('ZIP code', d.zip_code) + dlRow('Country', d.country) + '</dl>';
    } else if (mod.name === 'ovh' && d.number_range) {
      html += '<dl>' + dlRow('Number range checked', d.number_range) + dlRow('Found in OVH zones', 'No') + '</dl>';
    } else if (mod.name === 'public_osint' && d.categories) {
      html += '<p class="hint">' + d.total_links + ' search links generated. Open a link to see what Google has publicly indexed — nothing was fetched by PhoneIntel.</p>';
      Object.keys(d.categories).forEach(function (cat) {
        var group = d.categories[cat];
        html += '<details><summary>' + esc(cat.replace(/_/g, ' ')) + ' (' + group.count + ' links)</summary><ul class="dork-list">';
        group.links.forEach(function (l) {
          html += '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.dork) + '</a></li>';
        });
        html += '</ul></details>';
      });
    } else if (mod.name === 'ip' && d.ip) {
      html += '<dl>' + dlRow('IP', d.ip + ' (' + d.type + ')') + dlRow('Country', d.country + ' (' + d.country_code + ')')
        + dlRow('Region', d.region) + dlRow('City', d.city) + dlRow('Coordinates', (d.latitude != null ? d.latitude + ', ' + d.longitude : 'Unknown'))
        + dlRow('ISP', d.isp) + dlRow('Organisation', d.org) + dlRow('ASN', 'AS' + d.asn)
        + dlRow('Timezone', d.timezone_id + ' (' + d.timezone_utc + ')') + dlRow('Local time', d.current_time) + '</dl>';
      if (d.maps_url) html += '<p><a href="' + esc(d.maps_url) + '" target="_blank" rel="noopener">Open in Google Maps</a></p>';
    }
    return html;
  }

  function moduleCard(mod, retryable) {
    var html = '<div class="card module-card" id="mod-' + esc(mod.name) + '">'
      + '<div class="module-head"><h2>' + esc(MODULE_LABELS[mod.name] || mod.label) + '</h2>'
      + '<span class="' + statusClass(mod.status) + '">' + esc(mod.status) + '</span></div>'
      + '<p class="module-meta">Source: ' + esc(mod.source) + ' · Confidence: ' + esc(mod.confidence) + ' · ' + esc(mod.timestamp) + '</p>';
    if (mod.detail) html += '<p class="hint">' + esc(mod.detail) + '</p>';
    if (mod.error) html += '<div class="error">' + esc(mod.error) + '</div>';
    html += moduleBody(mod);
    if (retryable && mod.status === 'FAILED') {
      html += '<button type="button" class="btn-secondary retry-btn" data-module="' + esc(mod.name) + '">Retry module</button>';
    }
    return html + '</div>';
  }

  function renderReport(report) {
    var s = report.summary || {};
    setText('s-success', s.success || 0);
    setText('s-partial', s.partial || 0);
    setText('s-na', s.not_available || 0);
    setText('s-failed', s.failed || 0);
    setText('s-ns', s.not_supported || 0);
    var modeNote = lastMode === 'local'
      ? ' · Offline mode (ran in your browser)'
      : ' · API mode (Cloudflare Worker)';
    setText('report-meta', 'Investigation ' + report.investigation_id + ' · ' + report.timestamp
      + ' · Number: ' + report.input.number + (report.input.ip ? ' · IP: ' + report.input.ip : '')
      + modeNote
      + (report.duplicate ? ' · (duplicate — served from the 60-second cache)' : ''));
    var cards = document.getElementById('module-cards');
    cards.innerHTML = '';
    MODULE_ORDER.forEach(function (name) {
      var mod = report.modules[name];
      if (!mod) return;
      cards.insertAdjacentHTML('beforeend', moduleCard(mod, true));
    });
    cards.querySelectorAll('.retry-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { retryModule(btn.dataset.module, btn); });
    });
    document.getElementById('inv-results').classList.remove('hidden');
  }

  function replaceCard(mod) {
    var card = document.getElementById('mod-' + mod.name);
    if (!card) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = moduleCard(mod, true);
    card.replaceWith(tmp.firstChild);
    var newBtn = document.querySelector('#mod-' + mod.name + ' .retry-btn');
    if (newBtn) newBtn.addEventListener('click', function () { retryModule(mod.name, newBtn); });
  }

  function retryModule(name, btn) {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    var done = function (mod) {
      if (mod) {
        lastReport.modules[name] = mod;
        replaceCard(mod);
      }
      btn.disabled = false;
      btn.textContent = 'Retry module';
    };
    var showErr = function (message) {
      var box = document.getElementById('inv-error');
      box.textContent = message;
      box.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Retry module';
    };
    if (lastMode === 'worker') {
      apiPost('/api/module/' + encodeURIComponent(name), lastInputs)
        .then(function (r) {
          if (!r.payload.success) { showErr(r.payload.error || 'Retry failed.'); return; }
          done(r.payload.module);
        })
        .catch(function () { showErr('Could not reach the API. Check your connection and try again.'); });
    } else {
      // Local retry: only ovh/ip can fail locally (they fetch); the
      // other modules are pure functions.
      var info;
      try {
        info = lookup(lastInputs.number, lastInputs.country || null);
      } catch (err) {
        showErr(err.message || 'Retry failed.');
        return;
      }
      if (name === 'ovh') {
        localOvhModule(info).then(done);
      } else if (name === 'ip') {
        localIpModule(lastInputs.ip).then(done);
      } else {
        showErr('This module cannot be retried offline.');
      }
    }
  }

  /* ============================ investigation form ============================ */

  // Tabs.
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.add('hidden'); });
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
    });
  });

  var invForm = document.getElementById('investigate-form');
  var invError = document.getElementById('inv-error');
  var progressBox = document.getElementById('progress');
  var progressList = document.getElementById('progress-list');
  var invResults = document.getElementById('inv-results');
  var startBtn = document.getElementById('start-btn');

  function ensureLib() {
    // Wait for the CDN phone library (needed for offline mode only).
    if (window.libphonenumber) return Promise.resolve();
    if (window.__libReady && window.__libReady.then) {
      return window.__libReady.then(function () {
        if (!window.libphonenumber) throw new Error('Could not load the phone-number library from the CDN. Check your connection and reload the page.');
      });
    }
    return Promise.reject(new Error('Could not load the phone-number library from the CDN. Check your connection and reload the page.'));
  }

  invForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var number = document.getElementById('number').value.trim();
    var country = document.getElementById('country').value;
    var ip = document.getElementById('ip').value.trim();
    var consent = document.getElementById('consent').checked;
    invError.classList.add('hidden');
    invResults.classList.add('hidden');

    if (!consent) {
      invError.textContent = 'Please confirm the investigation consent checkbox before starting an investigation.';
      invError.classList.remove('hidden');
      return;
    }

    lastInputs = { number: number, country: country, ip: ip, consent: true };
    progressList.innerHTML = MODULE_ORDER.slice(0, 6).map(function (name) {
      return '<li><span class="progress-dot"></span>' + esc(MODULE_LABELS[name])
        + ' <span class="badge st-running">RUNNING</span></li>';
    }).join('');
    progressBox.classList.remove('hidden');
    startBtn.disabled = true;
    startBtn.textContent = 'Investigating…';

    var finish = function () {
      progressBox.classList.add('hidden');
      startBtn.disabled = false;
      startBtn.textContent = 'Start Investigation';
    };
    var failWith = function (message) {
      finish();
      invError.textContent = message;
      invError.classList.remove('hidden');
    };
    var runLocal = function (fallbackNote) {
      ensureLib()
        .then(function () { return buildLocalReport(number, country || null, ip); })
        .then(function (report) {
          lastMode = 'local';
          if (fallbackNote) setModeBanner(fallbackNote);
          lastReport = report;
          finish();
          renderReport(report);
        })
        .catch(function (err) {
          failWith(err && err.message ? err.message : 'Investigation failed.');
        });
    };

    if (!workerConfigured()) {
      runLocal('Offline mode — the Worker API is not configured yet (see config.js). This report ran in your browser.');
      return;
    }
    apiPost('/api/investigate', lastInputs)
      .then(function (r) {
        if (r.status >= 500) {
          // Server error: fall back to the offline report rather
          // than failing outright.
          runLocal('Worker unreachable — this report ran offline in your browser.');
          return;
        }
        if (!r.payload.success) {
          // 400/404/429 are real answers, not a reason to fall back.
          failWith(r.payload.error || 'Investigation failed.');
          return;
        }
        lastMode = 'worker';
        lastReport = r.payload.data;
        lastReport.mode = 'worker';
        lastReport.duplicate = !!r.payload.duplicate;
        setModeBanner('Connected to the PhoneIntel API (Cloudflare Worker).');
        finish();
        renderReport(lastReport);
      })
      .catch(function () {
        // Network error: fall back to the offline report.
        runLocal('Worker unreachable — this report ran offline in your browser.');
      });
  });

  /* ============================ export ============================ */

  document.getElementById('export-json').addEventListener('click', function () {
    if (!lastReport) return;
    var blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'phoneintel-' + lastReport.investigation_id + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  function flattenForPdf(data, prefix, lines) {
    if (data == null) return;
    if (Array.isArray(data)) {
      data.forEach(function (v) {
        if (typeof v === 'object') flattenForPdf(v, prefix + '- ', lines);
        else lines.push([prefix.replace(/: $/, '') || 'value', String(v)]);
      });
      return;
    }
    if (typeof data === 'object') {
      Object.keys(data).forEach(function (key) {
        flattenForPdf(data[key], prefix ? prefix + key + ': ' : key + ': ', lines);
      });
      return;
    }
    lines.push([prefix.replace(/: $/, '') || 'value', String(data)]);
  }

  document.getElementById('export-pdf').addEventListener('click', function () {
    if (!lastReport) return;
    if (!window.jspdf || !window.jspdf.jsPDF) {
      invError.textContent = 'The PDF library (jsPDF) could not be loaded from the CDN. Check your connection and reload the page.';
      invError.classList.remove('hidden');
      return;
    }
    var doc = new window.jspdf.jsPDF();
    var y = 14;
    var pageWidth = doc.internal.pageSize.getWidth();
    var margin = 14;
    var maxWidth = pageWidth - margin * 2;

    function newPageIfNeeded(lines) {
      if (y + lines * 6 > doc.internal.pageSize.getHeight() - 14) {
        doc.addPage();
        y = 14;
      }
    }
    function writeLine(text, bold, size) {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(size || 10);
      var wrapped = doc.splitTextToSize(text, maxWidth);
      newPageIfNeeded(wrapped.length);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 6;
    }

    writeLine('PhoneIntel Investigation Report', true, 16);
    writeLine('Investigation ID: ' + (lastReport.investigation_id || '-'));
    writeLine('Generated: ' + (lastReport.timestamp || '-'));
    writeLine('Mode: ' + (lastReport.mode === 'local' ? 'Offline (browser)' : 'API (Cloudflare Worker)'));
    var input = lastReport.input || {};
    writeLine('Number: ' + (input.number || '-'));
    if (input.ip) writeLine('IP: ' + input.ip);
    var s = lastReport.summary || {};
    writeLine('Modules: ' + (s.success || 0) + ' success, ' + (s.partial || 0) + ' partial, '
      + (s.not_available || 0) + ' not available, ' + (s.failed || 0) + ' failed, '
      + (s.not_supported || 0) + ' not supported');
    y += 4;

    MODULE_ORDER.forEach(function (name) {
      var mod = lastReport.modules[name];
      if (!mod) return;
      writeLine((MODULE_LABELS[name] || mod.label) + '  [' + mod.status + ']', true, 12);
      writeLine('Source: ' + mod.source);
      writeLine('Confidence: ' + mod.confidence + '  |  Checked: ' + mod.timestamp);
      if (mod.detail) writeLine(mod.detail);
      if (mod.error) writeLine('Error: ' + mod.error);
      var data = mod.data;
      if (data && typeof data === 'object') {
        var lines = [];
        flattenForPdf(data, '', lines);
        lines.forEach(function (pair) {
          // Skip the 45 dork links' full text; the summary line
          // carries the count instead.
          if (pair[1].indexOf('https://www.google.com/search') === 0) return;
          if (pair[0] === 'categories') return;
          writeLine('  ' + pair[0] + ': ' + pair[1].slice(0, 170));
        });
        if (data.total_links) writeLine('  Search links generated: ' + data.total_links);
      }
      y += 2;
    });

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    var disclaimer = 'PhoneIntel provides privacy-respecting phone-number analysis. '
      + 'It does not identify private social-media accounts, enumerate '
      + 'registrations or access restricted personal information. A valid '
      + 'number format does not prove an active subscriber.';
    var wrapped = doc.splitTextToSize(disclaimer, maxWidth);
    newPageIfNeeded(wrapped.length);
    doc.text(wrapped, margin, y);
    doc.save('phoneintel-' + lastReport.investigation_id + '.pdf');
  });

  /* ============================ my IP + username ============================ */

  function loadMyIp() {
    var set = function (ip) { setText('my-ip', ip); };
    if (workerConfigured()) {
      apiGet('/api/my-ip')
        .then(function (r) {
          if (r.payload.success) { set(r.payload.data.ip); return; }
          throw new Error('api error');
        })
        .catch(function () {
          fetch('https://api.ipify.org/?format=json')
            .then(function (resp) { return resp.json(); })
            .then(function (p) { set(p.ip || 'unavailable'); })
            .catch(function () { set('unavailable'); });
        });
    } else {
      fetch('https://api.ipify.org/?format=json')
        .then(function (resp) { return resp.json(); })
        .then(function (p) { set(p.ip || 'unavailable'); })
        .catch(function () { set('unavailable'); });
    }
  }

  loadMyIp();

  document.getElementById('use-my-ip').addEventListener('click', function () {
    var ip = document.getElementById('my-ip').textContent.trim();
    if (!ip || ip === '…' || ip === 'unavailable') return;
    document.getElementById('ip').value = ip;
  });

  var uForm = document.getElementById('username-form');
  var uError = document.getElementById('username-error');
  var uResults = document.getElementById('username-results');

  uForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var username = document.getElementById('username').value.trim();
    uError.classList.add('hidden');
    uResults.classList.add('hidden');

    if (!workerConfigured()) {
      uError.textContent = 'Username checking needs the PhoneIntel API (Cloudflare Worker), which is not configured yet (see config.js). Browsers cannot read other sites\u2019 HTTP status (CORS), so this check cannot run offline — nothing is faked.';
      uError.classList.remove('hidden');
      return;
    }
    apiPost('/api/username-lookup', { username: username })
      .then(function (r) {
        if (!r.payload.success) {
          uError.textContent = r.payload.error || 'Username check failed.';
          uError.classList.remove('hidden');
          return;
        }
        var d = r.payload.data;
        setText('u-found', d.found);
        setText('u-notfound', d.not_found);
        setText('u-unknown', d.unknown);
        setText('u-name', '@' + d.username);
        var rows = document.getElementById('u-rows');
        rows.innerHTML = '';
        d.results.forEach(function (r2) {
          var tr = document.createElement('tr');
          var label = r2.status === 'found' ? 'Found' : (r2.status === 'not_found' ? 'Not found' : 'Unknown');
          tr.innerHTML = '<td>' + esc(r2.site) + '</td>'
            + '<td><span class="status ' + esc(r2.status) + '">' + label + '</span></td>'
            + '<td><a href="' + esc(r2.url) + '" target="_blank" rel="noopener">' + esc(r2.url) + '</a></td>';
          rows.appendChild(tr);
        });
        uResults.classList.remove('hidden');
      })
      .catch(function () {
        uError.textContent = 'Could not reach the API. Check your connection and try again.';
        uError.classList.remove('hidden');
      });
  });

  /* ============================ mode banner ============================ */

  if (!workerConfigured()) {
    setModeBanner('Offline mode — the Worker API is not configured yet (see config.js). Investigations run in your browser; username checking needs the API.');
  } else {
    apiGet('/api/health')
      .then(function (r) {
        if (r.payload.status === 'ok') {
          setModeBanner('Connected to the PhoneIntel API (Cloudflare Worker).');
        } else {
          setModeBanner('Worker unreachable — investigations will run offline in your browser.');
        }
      })
      .catch(function () {
        setModeBanner('Worker unreachable — investigations will run offline in your browser.');
      });
  }
})();
