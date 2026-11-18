/* PhoneIntel static build — runs fully in the browser using
 * google-libphonenumber (JS port of Google's libphonenumber).
 *
 * Phone analysis is fully in-browser. The IP Tracker calls the free
 * ipwho.is API directly from the browser (verified: it sends
 * Access-Control-Allow-Origin: *, so browser fetch works); "Show Your
 * IP" uses api.ipify.org the same way. No account probing, no live
 * location tracking.
 *
 * Honest limits (all shown in the UI):
 *  - No carrier lookup: the JS bundle does not ship the carrier
 *    mapper, so carrier is reported as unavailable here. The
 *    Python/Flask app in this repo does carrier lookup.
 *  - No timezone API: timezones come from the region-level mapping
 *    below and are labelled approximate, never exact.
 *  - No username checking: browsers cannot read other sites' HTTP
 *    status (CORS), so the Username Tracker tab explains that the
 *    Python app is needed. Nothing is faked.
 */
(function () {
  'use strict';

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

  /* Approximate primary timezone(s) per region code. Multi-timezone
   * countries list their main zones. Regions not listed here show
   * "Unknown" — never a guess. */
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

  function lookup(rawNumber) {
    var lib = window.libphonenumber;
    var util = lib.PhoneNumberUtil.getInstance();
    var formats = lib.PhoneNumberFormat;

    rawNumber = (rawNumber || '').trim();
    if (!rawNumber) throw new Error('Please enter a phone number.');

    /* 'ZZ' = unknown region: the number must carry its own country
     * code (e.g. +92 ...), same rule as the Flask app. */
    var parsed = util.parse(rawNumber, 'ZZ');
    var region = util.getRegionCodeForNumber(parsed) || 'Unknown';
    var tz = REGION_TIMEZONES[region] || [];

    return {
      input: rawNumber,
      isPossible: util.isPossibleNumber(parsed),
      isValid: util.isValidNumber(parsed),
      numberType: NUMBER_TYPE_NAMES[util.getNumberType(parsed)] || 'Unknown',
      countryCode: parsed.getCountryCode(),
      nationalNumber: String(parsed.getNationalNumber()),
      regionCode: region,
      location: countryName(region),
      carrier: 'Not available in static version',
      timezones: tz,
      formats: {
        e164: util.format(parsed, formats.E164),
        international: util.format(parsed, formats.INTERNATIONAL),
        national: util.format(parsed, formats.NATIONAL),
        rfc3966: util.format(parsed, formats.RFC3966)
      }
    };
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function setBool(id, value) {
    var el = document.getElementById(id);
    el.textContent = value ? 'Yes' : 'No';
    el.classList.toggle('yes', value);
    el.classList.toggle('no', !value);
  }

  function init() {
    var form = document.getElementById('lookup-form');
    var errorBox = document.getElementById('error');
    var results = document.getElementById('results');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var number = document.getElementById('number').value.trim();
      errorBox.classList.add('hidden');
      results.classList.add('hidden');

      var d;
      try {
        d = lookup(number);
      } catch (err) {
        errorBox.textContent = err && err.message ? err.message : 'Lookup failed.';
        errorBox.classList.remove('hidden');
        return;
      }

      setBool('r-valid', d.isValid);
      setBool('r-possible', d.isPossible);
      setText('r-type', d.numberType);
      setText('r-cc', '+' + d.countryCode);
      setText('r-national', d.nationalNumber);
      setText('r-region', d.regionCode);
      setText('r-location', d.location);
      setText('r-carrier', d.carrier);
      setText('r-tz', d.timezones.length ? d.timezones.join(', ') : 'Unknown');
      setText('r-e164', d.formats.e164);
      setText('r-intl', d.formats.international);
      setText('r-nat', d.formats.national);
      setText('r-rfc', d.formats.rfc3966);
      results.classList.remove('hidden');
    });
  }

  /* ---- tabs (do not need the phone library) ---- */
  function initTabs() {
    var btns = document.querySelectorAll('.tab-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.add('hidden'); });
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.remove('hidden');
      });
    });
  }

  /* ---- IP tracker (browser fetch to ipwho.is; CORS verified) ---- */
  var IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
  var IPV6_RE = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

  function initIp() {
    var form = document.getElementById('ip-form');
    var input = document.getElementById('ip');
    var errorBox = document.getElementById('ip-error');
    var results = document.getElementById('ip-results');
    if (!form) return;

    function showIp(d) {
      var flag = d.flag && d.flag.emoji ? d.flag.emoji + ' ' : '';
      var conn = d.connection || {};
      var tz = d.timezone || {};
      setText('ip-country', flag + (d.country || 'Unknown') + ' (' + (d.country_code || '?') + ')');
      setText('ip-region', d.region || 'Unknown');
      setText('ip-city', d.city || 'Unknown');
      setText('ip-postal', d.postal || 'Unknown');
      setText('ip-coords', (d.latitude != null && d.longitude != null)
        ? d.latitude + ', ' + d.longitude : 'Unknown');
      var maps = document.getElementById('ip-maps');
      if (d.latitude != null && d.longitude != null) {
        maps.href = 'https://www.google.com/maps/@' + d.latitude + ',' + d.longitude + ',8z';
        maps.textContent = 'Open in Google Maps';
      } else {
        maps.removeAttribute('href');
        maps.textContent = 'Not available';
      }
      setText('ip-addr', d.ip || 'Unknown');
      setText('ip-type', d.type || 'Unknown');
      setText('ip-isp', conn.isp || 'Unknown');
      setText('ip-org', conn.org || 'Unknown');
      setText('ip-asn', conn.asn != null ? 'AS' + conn.asn : 'Unknown');
      setText('ip-domain', conn.domain || 'Unknown');
      setText('ip-tz', (tz.id || 'Unknown') + ' (' + (tz.abbr || '?') + ', UTC' + (tz.utc || '?') + ')');
      /* ipwho.is returns no current-time field; derive it from the UTC
       * offset (seconds) it does return. */
      var localTime = 'Unknown';
      if (typeof tz.offset === 'number') {
        var d2 = new Date(Date.now() + tz.offset * 1000);
        localTime = d2.toISOString().slice(0, 16).replace('T', ' ');
      }
      setText('ip-time', localTime);
      setText('ip-calling', d.calling_code ? '+' + d.calling_code : 'Unknown');
      setText('ip-capital', d.capital || 'Unknown');
      results.classList.remove('hidden');
    }

    function runIpLookup(ip) {
      errorBox.classList.add('hidden');
      results.classList.add('hidden');
      if (!IPV4_RE.test(ip) && !IPV6_RE.test(ip)) {
        errorBox.textContent = "'" + ip + "' is not a valid IP address.";
        errorBox.classList.remove('hidden');
        return;
      }
      fetch('https://ipwho.is/' + encodeURIComponent(ip))
        .then(function (resp) {
          if (!resp.ok) throw new Error('IP lookup service returned HTTP ' + resp.status + '.');
          return resp.json();
        })
        .then(function (d) {
          if (!d.success) throw new Error(d.message || 'IP lookup failed.');
          showIp(d);
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'IP lookup failed.';
          errorBox.classList.remove('hidden');
        });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      runIpLookup(input.value.trim());
    });

    /* Show Your IP (api.ipify.org allows browser fetch; CORS verified). */
    fetch('https://api.ipify.org/?format=json')
      .then(function (r) { return r.json(); })
      .then(function (p) { if (p.ip) setText('my-ip', p.ip); })
      .catch(function () { setText('my-ip', 'unavailable'); });

    document.getElementById('use-my-ip').addEventListener('click', function () {
      var ip = document.getElementById('my-ip').textContent.trim();
      if (!ip || ip === '…' || ip === 'unavailable') return;
      input.value = ip;
      runIpLookup(ip);
    });
  }

  function showLibError() {
    var errorBox = document.getElementById('error');
    if (errorBox) {
      errorBox.textContent = 'Could not load the phone-number library from the CDN. Check your connection and reload the page.';
      errorBox.classList.remove('hidden');
    }
  }

  /* Expose the pure data tables for node-based testing. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      REGION_TIMEZONES: REGION_TIMEZONES,
      NUMBER_TYPE_NAMES: NUMBER_TYPE_NAMES
    };
  }

  if (typeof document === 'undefined') return;

  /* Tabs and the IP tracker do not need the phone library. */
  initTabs();
  initIp();

  if (window.__libReady && window.__libReady.then) {
    window.__libReady.then(function () {
      if (window.libphonenumber) {
        init();
      } else {
        showLibError();
      }
    }, showLibError);
  } else if (window.libphonenumber) {
    init();
  } else {
    showLibError();
  }
})();
