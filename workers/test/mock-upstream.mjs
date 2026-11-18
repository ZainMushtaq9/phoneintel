// Mock upstream APIs for local `wrangler dev` testing.
//
// In some sandboxes workerd cannot reach the public internet
// directly (it does not use the shell's HTTP proxy), so the
// Worker's IP and OVH modules would always report FAILED there.
// This mock serves the same response shapes as the real APIs so
// the fetch + parse + module logic can be verified end to end in
// workerd. The fixture data is real observed data (the OVH Abbeville
// zone and the Google DNS record were both returned by the live
// APIs during Flask-backend testing) — it is test data only and is
// never served to users.
//
// Usage:
//   node test/mock-upstream.mjs &
//   # .dev.vars (local only, gitignored) points the Worker at it:
//   IPWHOIS_BASE=http://127.0.0.1:8899/ipwho
//   OVH_BASE=http://127.0.0.1:8899/ovh
//   npm run dev

import http from 'node:http';

const PORT = 8899;

// ipwho.is-shaped response for 8.8.8.8 (Google Public DNS).
const IPWHO_8888 = {
  ip: '8.8.8.8',
  success: true,
  type: 'IPv4',
  continent: 'North America',
  continent_code: 'NA',
  country: 'United States',
  country_code: 'US',
  region: 'California',
  city: 'Mountain View',
  latitude: 37.3860517,
  longitude: -122.0838511,
  postal: '94039',
  flag: { img: 'https://cdn.ipwho.is/flags/us.svg', emoji: '🇺🇸', emoji_unicode: 'U+1F1FA U+1F1F8' },
  connection: { asn: 15169, org: 'Google LLC', isp: 'Google LLC', domain: 'google.com' },
  timezone: { id: 'America/Los_Angeles', abbr: 'PST', is_dst: false, offset: -28800, utc: '-08:00', current_time: '2026-11-18T00:00:00-08:00' },
  calling_code: '1',
  capital: 'Washington D.C.',
  borders: 'CA,MX',
};

// OVH-shaped zone list for France (subset; the real list has 412
// entries — the module only needs the matching row to be present).
const OVH_FR = [
  { number: '036517xxxx', city: 'Abbeville', zipCode: '80100', country: 'fr' },
  { number: '014201xxxx', city: 'Paris', zipCode: '75001', country: 'fr' },
  { number: '047202xxxx', city: 'Lyon', zipCode: '69001', country: 'fr' },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/ipwho/8.8.8.8') {
    res.end(JSON.stringify(IPWHO_8888));
    return;
  }
  if (url.pathname.startsWith('/ipwho/')) {
    res.end(JSON.stringify({ ip: url.pathname.slice(7), success: false, message: 'invalid IP address' }));
    return;
  }
  if (url.pathname === '/ovh' && url.searchParams.get('country') === 'fr') {
    res.end(JSON.stringify(OVH_FR));
    return;
  }
  if (url.pathname === '/ovh') {
    res.end(JSON.stringify([]));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Mock upstream listening on http://127.0.0.1:' + PORT);
});
