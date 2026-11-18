// PhoneIntel API — Cloudflare Worker entry point.
//
// Endpoints (same shapes as the Flask local backend in ../app.py):
//   GET  /api/health
//   POST /api/investigate        {number, country?, ip?, consent:true}
//   POST /api/module/<name>      retry one module (consent required)
//   POST /api/lookup             {number, country?}
//   POST /api/ip-lookup          {ip}
//   POST /api/username-lookup    {username}
//   GET  /api/my-ip
//
// No API keys, no secrets, no storage. Submitted numbers, IPs and
// usernames are never logged or retained — the only in-memory state
// is a 60-second duplicate cache keyed by a hash of the inputs, a
// 1-hour OVH zone cache, and per-IP rate-limit counters.

import {
  lookupNumber, lookupIp, lookupUsername, configureUpstreams,
  ValidationError, LookupError,
} from './lookups.js';
import {
  runInvestigation, runSingleModule, MODULE_RUNNERS,
} from './investigation.js';

// ---------------------------------------------------------------- CORS ---

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

const ok = (data, extra) => json({ success: true, data }, 200, extra);
const fail = (message, status = 400) => json({ success: false, error: message }, status);

// -------------------------------------------------------- rate limiting ---
// KV-free, per-IP sliding window, in memory. Best-effort by design:
// a request may land on any Worker isolate, and each isolate keeps
// its own counters — so a determined abuser could spread requests
// across isolates. This stops casual abuse and accidents on the free
// tier; a Durable Object counter would be the robust (paid-adjacent)
// upgrade. Limits mirror the Flask backend.

const RATE_LIMITS = {
  investigate: 10, // per minute
  module: 20,
  lookup: 30,
  'ip-lookup': 30,
  'username-lookup': 30,
};
const RATE_WINDOW = 60 * 1000;
// Bound the map so a flood of distinct IPs cannot grow memory
// without limit; oldest entries are dropped first.
const RATE_MAP_MAX = 5000;

const rateHits = new Map();

function rateLimited(clientIp, route) {
  const limit = RATE_LIMITS[route];
  if (!limit) return false;
  const key = clientIp + ':' + route;
  const now = Date.now();
  let hits = rateHits.get(key) || [];
  hits = hits.filter((t) => now - t < RATE_WINDOW);
  if (hits.length >= limit) {
    rateHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateHits.set(key, hits);
  if (rateHits.size > RATE_MAP_MAX) {
    // Drop the oldest key (Map preserves insertion order).
    rateHits.delete(rateHits.keys().next().value);
  }
  return false;
}

function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

// ------------------------------------------------------------- helpers ---

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw Object.assign(new ValidationError('Request is too large.'), { status: 413 });
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
}

function requireConsent(data) {
  if (![true, 'true', 'on', 'yes', 1].includes(data.consent)) {
    throw new ValidationError(
      'Please confirm the investigation consent checkbox before starting an investigation.',
    );
  }
}

function cleanRegion(rawRegion) {
  const region = (rawRegion || '').trim().toUpperCase();
  if (!region) return null;
  if (!/^[A-Z]{2}$/.test(region)) {
    throw new ValidationError('Country must be a two-letter ISO code.');
  }
  return region;
}

// -------------------------------------------------------------- routes ---

async function handleInvestigate(request) {
  const data = await readBody(request);
  requireConsent(data);
  const region = cleanRegion(data.country);
  const number = (data.number || '').trim();
  const rawIp = (data.ip || '').trim();
  if (!number) throw new ValidationError('Please enter a phone number.');
  const { report, duplicate } = await runInvestigation(number, region, rawIp);
  return json({ success: true, duplicate, data: report });
}

async function handleModuleRetry(request, name) {
  if (!MODULE_RUNNERS.includes(name)) {
    return fail("Unknown module '" + name + "'.", 404);
  }
  const data = await readBody(request);
  requireConsent(data);
  const region = cleanRegion(data.country);
  const module = await runSingleModule(
    name, (data.number || '').trim(), region, (data.ip || '').trim(),
  );
  return json({ success: true, module });
}

async function handleLookup(request) {
  const data = await readBody(request);
  const region = cleanRegion(data.country);
  return ok(lookupNumber(data.number, region));
}

async function handleIpLookup(request) {
  const data = await readBody(request);
  try {
    return ok(await lookupIp(data.ip));
  } catch (err) {
    if (err instanceof LookupError) return fail(err.message, 502);
    throw err;
  }
}

async function handleUsernameLookup(request) {
  const data = await readBody(request);
  return ok(await lookupUsername(data.username));
}

function handleMyIp(request) {
  return ok({ ip: clientIp(request) });
}

// --------------------------------------------------------------- fetch ---

export default {
  async fetch(request, env = {}) {
    // Local-test upstream overrides (no-op in production).
    configureUpstreams(env);
    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const ip = clientIp(request);

    try {
      if (request.method === 'GET' && path === '/api/health') {
        return json({ status: 'ok' });
      }
      if (request.method === 'GET' && path === '/api/my-ip') {
        return handleMyIp(request);
      }
      if (request.method === 'POST' && path === '/api/investigate') {
        if (rateLimited(ip, 'investigate')) {
          return json(
            { success: false, error: 'Rate limit exceeded. Please wait a moment and try again.' },
            429, { 'Retry-After': '60' },
          );
        }
        return await handleInvestigate(request);
      }
      const moduleMatch = path.match(/^\/api\/module\/([a-z_]+)$/);
      if (request.method === 'POST' && moduleMatch) {
        if (rateLimited(ip, 'module')) {
          return json(
            { success: false, error: 'Rate limit exceeded. Please wait a moment and try again.' },
            429, { 'Retry-After': '60' },
          );
        }
        return await handleModuleRetry(request, moduleMatch[1]);
      }
      if (request.method === 'POST' && path === '/api/lookup') {
        if (rateLimited(ip, 'lookup')) {
          return json(
            { success: false, error: 'Rate limit exceeded. Please wait a moment and try again.' },
            429, { 'Retry-After': '60' },
          );
        }
        return await handleLookup(request);
      }
      if (request.method === 'POST' && path === '/api/ip-lookup') {
        if (rateLimited(ip, 'ip-lookup')) {
          return json(
            { success: false, error: 'Rate limit exceeded. Please wait a moment and try again.' },
            429, { 'Retry-After': '60' },
          );
        }
        return await handleIpLookup(request);
      }
      if (request.method === 'POST' && path === '/api/username-lookup') {
        if (rateLimited(ip, 'username-lookup')) {
          return json(
            { success: false, error: 'Rate limit exceeded. Please wait a moment and try again.' },
            429, { 'Retry-After': '60' },
          );
        }
        return await handleUsernameLookup(request);
      }
      return fail('Not found.', 404);
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(err.message, err.status || 400);
      }
      if (err instanceof LookupError) {
        return fail(err.message, 502);
      }
      // Never leak internals or submitted data in an error response.
      return fail('Internal server error.', 500);
    }
  },
};
