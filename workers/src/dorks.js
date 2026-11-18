// Phoneinfoga's googlesearch scanner, re-implemented in JS.
// It generates Google dork query URLs — it does NOT fetch search
// results, and neither does this module. The links are handed to the
// user to open; what Google returns depends on what is publicly
// indexed. Same categories and URL format as the Python backend
// (verified against Phoneinfoga's own test vectors).

import { DISPOSABLE_SMS_SITES, FILE_EXTENSIONS } from './data.js';

function dorkUrl(dork) {
  // encodeURIComponent then %20 -> + : matches Python quote_plus
  // exactly, so URLs are byte-identical to the Flask backend's.
  // encodeURIComponent leaves ( ) ! ' * unescaped; quote_plus
  // percent-encodes them, so escape those too.
  return 'https://www.google.com/search?q=' + encodeURIComponent(dork)
    .replace(/%20/g, '+')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\*/g, '%2A');
}

function intext(...values) {
  return values.map((v) => 'intext:"' + v + '"').join(' | ');
}

export function buildDorks(info) {
  const e164 = info.formats.e164;
  const intl = info.international_digits;
  const rawLocal = info.raw_local;
  const localFmt = info.formats.national;

  const link = (dork) => ({ dork, url: dorkUrl(dork) });

  const social = ['facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'vk.com']
    .map((site) => link('site:' + site + ' ' + intext(intl, e164, rawLocal)));

  const disposable = [link('site:hs3x.com intext:"' + intl + '"')];
  DISPOSABLE_SMS_SITES.slice(1).forEach((site) => {
    disposable.push(link('site:' + site + ' ' + intext(intl, rawLocal)));
  });

  const reputation = [
    link('site:whosenumber.info intext:"' + e164 + '" intitle:"who called"'),
    link('intitle:"Phone Fraud" ' + intext(intl, e164, rawLocal)),
    link('site:findwhocallsme.com intext:"' + e164 + '" | intext:"' + intl + '"'),
    link('site:yellowpages.ca intext:"' + e164 + '"'),
    link('site:phonenumbers.ie intext:"' + e164 + '"'),
    link('site:who-calledme.com intext:"' + e164 + '"'),
    link('site:usphonesearch.net intext:"' + rawLocal + '"'),
    link('site:whocalled.us inurl:' + rawLocal),
    link('site:quinumero.info intext:"' + rawLocal + '" | intext:"' + intl + '"'),
    link('site:uk.popularphotolook.com inurl:' + rawLocal),
  ];

  const individuals = ['numinfo.net', 'sync.me', 'pastebin.com', 'whycall.me', 'locatefamily.com']
    .map((site) => link('site:' + site + ' ' + intext(intl, e164, rawLocal)));
  individuals.push(link('site:whocallsyou.de intext:"' + rawLocal + '"'));
  individuals.push(link('site:spytox.com intext:"' + rawLocal + '"'));

  const filetypes = '(' + FILE_EXTENSIONS.map((e) => 'ext:' + e).join(' | ') + ')';
  const general = [
    link(intext(intl, e164, rawLocal, localFmt)),
    link(filetypes + ' ' + intext(intl, e164, rawLocal)),
  ];

  return {
    social_media: social,
    disposable_providers: disposable,
    reputation,
    individuals,
    general,
  };
}
