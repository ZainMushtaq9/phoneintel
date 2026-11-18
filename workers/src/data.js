// Shared data tables for the PhoneIntel Worker.
// Mirrors the Python backend (app.py) and the static frontend
// (netlify/app.js) so every deployment reports the same values.

export const REGION_NAMES = {
  AE: 'United Arab Emirates', AF: 'Afghanistan', AR: 'Argentina',
  AT: 'Austria', AU: 'Australia', BD: 'Bangladesh', BE: 'Belgium',
  BH: 'Bahrain', BR: 'Brazil', CA: 'Canada', CH: 'Switzerland',
  CL: 'Chile', CN: 'China', CO: 'Colombia', CZ: 'Czechia',
  DE: 'Germany', DK: 'Denmark', EG: 'Egypt', ES: 'Spain',
  FI: 'Finland', FR: 'France', GB: 'United Kingdom',
  GR: 'Greece', HK: 'Hong Kong', HU: 'Hungary', ID: 'Indonesia',
  IE: 'Ireland', IL: 'Israel', IN: 'India', IQ: 'Iraq',
  IR: 'Iran', IS: 'Iceland', IT: 'Italy', JO: 'Jordan',
  JP: 'Japan', KE: 'Kenya', KR: 'South Korea', KW: 'Kuwait',
  KZ: 'Kazakhstan', LK: 'Sri Lanka', MA: 'Morocco',
  MX: 'Mexico', MY: 'Malaysia', NG: 'Nigeria',
  NL: 'Netherlands', NO: 'Norway', NP: 'Nepal',
  NZ: 'New Zealand', OM: 'Oman', PE: 'Peru', PH: 'Philippines',
  PK: 'Pakistan', PL: 'Poland', PT: 'Portugal', QA: 'Qatar',
  RO: 'Romania', RU: 'Russia', SA: 'Saudi Arabia',
  SE: 'Sweden', SG: 'Singapore', TH: 'Thailand', TR: 'Turkey',
  TW: 'Taiwan', UA: 'Ukraine', US: 'United States',
  UZ: 'Uzbekistan', VN: 'Vietnam', ZA: 'South Africa',
};

export function countryName(regionCode) {
  if (!regionCode || regionCode === 'Unknown') return 'Unknown';
  return REGION_NAMES[regionCode] || regionCode;
}

// Approximate primary timezone(s) per region code. Multi-timezone
// countries list their main zones. Regions not listed here show
// "Unknown" — never a guess. These are REGION-level approximations:
// the JS libphonenumber bundle has no per-number timezone data
// (the Python backend does), so the Worker labels them approximate.
export const REGION_TIMEZONES = {
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
  ZA: ['Africa/Johannesburg'],
};

export const NUMBER_TYPE_NAMES = {
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
  10: 'Voicemail',
};

// GhostTrack's username-tracker site list, deduplicated. Services that
// have shut down since (Periscope, StumbleUpon, Ello, We Heart It)
// are left out — checking them would always fail.
export const USERNAME_SITES = [
  ['Facebook', 'https://www.facebook.com/{}'],
  ['X (Twitter)', 'https://x.com/{}'],
  ['Instagram', 'https://www.instagram.com/{}'],
  ['LinkedIn', 'https://www.linkedin.com/in/{}'],
  ['GitHub', 'https://www.github.com/{}'],
  ['Pinterest', 'https://www.pinterest.com/{}'],
  ['Tumblr', 'https://www.tumblr.com/{}'],
  ['YouTube', 'https://www.youtube.com/{}'],
  ['SoundCloud', 'https://soundcloud.com/{}'],
  ['Snapchat', 'https://www.snapchat.com/add/{}'],
  ['TikTok', 'https://www.tiktok.com/@{}'],
  ['Behance', 'https://www.behance.net/{}'],
  ['Medium', 'https://medium.com/@{}'],
  ['Quora', 'https://www.quora.com/profile/{}'],
  ['Flickr', 'https://www.flickr.com/people/{}'],
  ['Twitch', 'https://www.twitch.tv/{}'],
  ['Dribbble', 'https://dribbble.com/{}'],
  ['Telegram', 'https://t.me/{}'],
  ['Product Hunt', 'https://www.producthunt.com/@{}'],
];

export const OVH_COUNTRIES = { 33: 'fr', 32: 'be', 44: 'gb', 34: 'es', 41: 'ch' };

export const DISPOSABLE_SMS_SITES = [
  'hs3x.com', 'receive-sms-now.com', 'smslisten.com',
  'smsnumbersonline.com', 'freesmscode.com', 'catchsms.com',
  'smstibo.com', 'smsreceiving.com', 'getfreesmsnumber.com',
  'sellaite.com', 'receive-sms-online.info', 'receivesmsonline.com',
  'receive-a-sms.com', 'sms-receive.net', 'receivefreesms.com',
  'receive-sms.com', 'receivetxt.com', 'freephonenum.com',
  'freesmsverification.com', 'receive-sms-online.com', 'smslive.co',
];

export const FILE_EXTENSIONS = [
  'doc', 'docx', 'odt', 'pdf', 'rtf', 'sxw', 'psw', 'ppt', 'pptx',
  'pps', 'csv', 'txt', 'xls',
];

export const SITE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};
