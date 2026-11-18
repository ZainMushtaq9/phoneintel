/* PhoneIntel static build — runs fully in the browser using
 * google-libphonenumber (JS port of Google's libphonenumber).
 *
 * No server, no external lookups, no account probing, no live
 * location tracking. Location is country-level only, from the
 * public numbering plan.
 *
 * Two honest limits of the JavaScript library (both shown in the UI):
 *  - No carrier lookup: the JS bundle does not ship the carrier
 *    mapper, so carrier is reported as unavailable here. The
 *    Python/Flask app in this repo does carrier lookup.
 *  - No timezone API: timezones come from the region-level mapping
 *    below and are labelled approximate, never exact.
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
