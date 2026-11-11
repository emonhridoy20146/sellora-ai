/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for Meta's Conversions API, TikTok's Events API and Google Analytics 4's
 * Measurement Protocol, for local demos and browser checks when no ad account is at hand
 * (ADR 0030). It is NOT any of those platforms and nothing it is sent reaches an ad account.
 * It answers in each platform's documented request and response shapes, refuses what their
 * documents say is refused (an unknown token or id, an event older than seven days, a website
 * event without a user agent, personal details not hashed), and shows what it was sent at
 * http://localhost:4120/ so you can see what a real platform would receive.
 *
 *   node scripts/tracking-stand-in.mjs     # listens on 127.0.0.1:4120 (HOST, PORT to change)
 *   TRACKING_META_BASE_URL=http://127.0.0.1:4120/meta \
 *   TRACKING_TIKTOK_BASE_URL=http://127.0.0.1:4120/tiktok \
 *   TRACKING_GA4_BASE_URL=http://127.0.0.1:4120/ga4  npm run dev   # and dev:worker
 *
 * Demo ids and keys (anything else is refused, like the real platforms would):
 *   Meta     pixel ID 1234567890123456, access token demo-meta-capi-token-not-real,
 *            test event code TEST12345
 *   TikTok   pixel code CDEMOPIXEL000000001, access token demo-tiktok-events-token-not-real,
 *            test event code TEST67890
 *   GA4      measurement ID G-DEMO123456, API secret demo-ga4-api-secret-not-real
 *            (the real collect endpoint takes any secret and answers 204; so does this one)
 *
 * Test hooks (not part of any platform API):
 *   GET  /               what it was sent, as a page    GET  /__events   the same, as JSON
 *   GET  /__requests     every request, raw             POST /__reset    forget everything
 *   POST /__fail         the next Meta event call answers a temporary server error
 *
 * Never point a production deployment at it.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4120);
// 0.0.0.0 inside a container; this computer only otherwise.
const HOST = process.env.HOST ?? '127.0.0.1';

const KEYS = {
  meta: {
    pixelId: '1234567890123456',
    pixelName: 'Demo Pixel (stand-in)',
    token: 'demo-meta-capi-token-not-real',
    testCode: 'TEST12345',
  },
  tiktok: {
    pixelCode: 'CDEMOPIXEL000000001',
    token: 'demo-tiktok-events-token-not-real',
    testCode: 'TEST67890',
  },
  ga4: { measurementId: 'G-DEMO123456', secret: 'demo-ga4-api-secret-not-real' },
};

const HEX64 = /^[0-9a-f]{64}$/;
const META_SOURCES = new Set([
  'email',
  'website',
  'app',
  'phone_call',
  'chat',
  'physical_store',
  'system_generated',
  'business_messaging',
  'other',
]);

/** Each event a platform took or refused: what the page and /__events show. */
const events = [];
const requests = [];
let failNextMeta = false;

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function note(platform, e, status, why) {
  events.unshift({
    at: new Date().toISOString(),
    platform,
    event: e.event_name ?? e.event ?? e.name,
    eventId: e.event_id ?? e.params?.transaction_id ?? null,
    test: Boolean(e.test),
    status,
    why: why ?? null,
    data: e,
  });
  events.length = Math.min(events.length, 500);
}

// --- Meta Conversions API -------------------------------------------------------------------

function metaError(res, status, code, message) {
  return send(res, status, {
    error: { message, type: 'OAuthException', code, fbtrace_id: 'StandIn000' },
  });
}

function meta(res, method, path, query, body) {
  const m = /^\/v\d+\.\d+\/(\d+)(\/events)?$/.exec(path);
  if (!m) return metaError(res, 400, 100, 'Unknown path components');
  if (query.get('access_token') !== KEYS.meta.token)
    return metaError(res, 400, 190, 'Invalid OAuth access token - Cannot parse access token');
  if (m[1] !== KEYS.meta.pixelId)
    return metaError(res, 400, 100, `Object with ID '${m[1]}' does not exist`);
  if (!m[2] && method === 'GET') return send(res, 200, { id: m[1], name: KEYS.meta.pixelName });
  if (!m[2] || method !== 'POST') return metaError(res, 400, 100, 'Unsupported request');
  if (failNextMeta) {
    failNextMeta = false;
    return metaError(res, 500, 2, 'An unexpected error has occurred. Please retry.');
  }
  const data = Array.isArray(body?.data) ? body.data : [];
  if (!data.length || data.length > 1000)
    return metaError(res, 400, 100, 'The parameter data is required');
  if (body.test_event_code !== undefined && body.test_event_code !== KEYS.meta.testCode)
    return metaError(res, 400, 100, 'Invalid test_event_code');
  const now = Date.now() / 1000;
  for (const e of data) {
    const user = e.user_data ?? {};
    let why;
    if (typeof e.event_name !== 'string' || typeof e.event_time !== 'number')
      why = 'Invalid parameter: event_name and event_time';
    else if (e.event_time < now - 7 * 24 * 3600 || e.event_time > now + 60)
      why = 'event_time is too far in the past or the future';
    else if (!META_SOURCES.has(String(e.action_source))) why = 'Invalid action_source';
    else if (e.action_source === 'website' && typeof user.client_user_agent !== 'string')
      why = 'client_user_agent is required for website events';
    else
      for (const k of ['em', 'ph', 'fn', 'ln', 'ct', 'country', 'external_id'])
        if (
          user[k] !== undefined &&
          !(Array.isArray(user[k]) && user[k].every((v) => typeof v === 'string' && HEX64.test(v)))
        )
          why = `user_data.${k} must be hashed`;
    if (why) {
      note('meta', { ...e, test: Boolean(body.test_event_code) }, 'refused', why);
      return metaError(res, 400, 100, why);
    }
  }
  for (const e of data) note('meta', { ...e, test: Boolean(body.test_event_code) }, 'taken');
  return send(res, 200, { events_received: data.length, messages: [], fbtrace_id: 'StandIn000' });
}

// --- TikTok Events API 2.0 ------------------------------------------------------------------

function tiktok(res, method, path, headers, body) {
  const answer = (code, message) =>
    send(res, 200, { code, message, request_id: 'stand-in-1', data: {} });
  if (path !== '/open_api/v1.3/event/track/' || method !== 'POST')
    return send(res, 404, { code: 40400, message: 'Not found' });
  if (headers['access-token'] !== KEYS.tiktok.token)
    return answer(40001, 'Access token is invalid or has expired');
  if (body?.event_source !== 'web' || body.event_source_id !== KEYS.tiktok.pixelCode)
    return answer(40002, 'event_source_id is invalid');
  if (body.test_event_code !== undefined && body.test_event_code !== KEYS.tiktok.testCode)
    return answer(40002, 'test_event_code is invalid');
  const data = Array.isArray(body.data) ? body.data : [];
  if (!data.length) return answer(40002, 'data is required');
  for (const e of data) {
    const user = e.user ?? {};
    let why;
    if (typeof e.event !== 'string' || typeof e.event_time !== 'number')
      why = 'event and event_time are required';
    else
      for (const k of ['email', 'phone', 'external_id'])
        if (user[k] !== undefined && !(typeof user[k] === 'string' && HEX64.test(user[k])))
          why = `user.${k} must be SHA-256 hashed`;
    if (why) {
      note('tiktok', { ...e, test: Boolean(body.test_event_code) }, 'refused', why);
      return answer(40002, why);
    }
  }
  for (const e of data) note('tiktok', { ...e, test: Boolean(body.test_event_code) }, 'taken');
  return answer(0, 'OK');
}

// --- GA4 Measurement Protocol ---------------------------------------------------------------

function ga4(res, method, path, query, body) {
  const debug = path === '/debug/mp/collect';
  if ((path !== '/mp/collect' && !debug) || method !== 'POST')
    return send(res, 404, 'Not found', 'text/plain');
  const problems = [];
  if (query.get('measurement_id') !== KEYS.ga4.measurementId)
    problems.push({
      description: 'Unable to find the measurement_id.',
      fieldPath: 'measurement_id',
      validationCode: 'VALUE_INVALID',
    });
  if (typeof body?.client_id !== 'string' || !body.client_id)
    problems.push({
      description: 'Measurement requires a client_id.',
      fieldPath: 'client_id',
      validationCode: 'VALUE_REQUIRED',
    });
  const list = Array.isArray(body?.events) ? body.events : [];
  if (!list.length || list.length > 25)
    problems.push({
      description: 'Measurement requires 1 to 25 events.',
      fieldPath: 'events',
      validationCode: 'VALUE_INVALID',
    });
  if (debug) return send(res, 200, { validationMessages: problems });
  // The real collect endpoint takes anything, even a wrong secret, and answers 204: so it is
  // marked here what Google would have dropped, though the sender is never told.
  const wrongSecret = query.get('api_secret') !== KEYS.ga4.secret;
  for (const e of list)
    note(
      'ga4',
      {
        ...e,
        client_id: body?.client_id,
        consent: body?.consent,
        user_data: body?.user_data,
        test: Boolean(e.params?.debug_mode),
      },
      problems.length || wrongSecret ? 'dropped' : 'taken',
      problems.length
        ? problems.map((p) => p.description).join(' ')
        : wrongSecret
          ? 'Unknown API secret: Google would drop it without saying so.'
          : undefined,
    );
  res.writeHead(204);
  return res.end();
}

// --- The page -------------------------------------------------------------------------------

const LABEL = { meta: 'Meta', tiktok: 'TikTok', ga4: 'Google Analytics 4' };

function page() {
  const rows = events
    .map(
      (e) => `<tr class="${e.status}">
  <td>${esc(e.at.slice(11, 19))}</td><td>${esc(LABEL[e.platform])}</td>
  <td><b>${esc(e.event)}</b>${e.test ? ' <span class="tag">test</span>' : ''}</td>
  <td><code>${esc(e.eventId ?? '')}</code></td>
  <td>${esc(e.status)}${e.why ? `: ${esc(e.why)}` : ''}</td>
  <td><details><summary>payload</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details></td>
</tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Ad tracking stand-in</title>
<style>
  :root { color-scheme: light dark; --ink:#1d1d1f; --muted:#6b6b70; --line:#e3e3e6; --bg:#fafafa; --bad:#b3261e; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) { :root { --ink:#ececf0; --muted:#a0a0a8; --line:#33333a; --bg:#17171a; --bad:#ff8a80; --warn:#ffcc66; } }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px; color: var(--ink); background: var(--bg); }
  h1 { font-size: 20px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 16px; max-width: 70ch; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; } code, pre { font-size: 12px; } pre { white-space: pre-wrap; max-width: 60ch; }
  tr.refused td, tr.dropped td { color: var(--bad); } .tag { font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; color: var(--warn); }
  .wrap { overflow-x: auto; }
</style></head><body>
<h1>Ad tracking stand-in</h1>
<p>Not Meta, TikTok or Google: nothing here reaches an ad account. These are the server events Sellora sent, newest first, as a real platform would receive them. The page refreshes every 5 seconds.</p>
<div class="wrap"><table><thead><tr><th>Time</th><th>Platform</th><th>Event</th><th>Event id</th><th>Answer</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">Nothing yet.</td></tr>'}</tbody></table></div>
</body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const raw = await readBody(req);
  const body = raw ? json(raw) : null;
  if (!path.startsWith('/__') && path !== '/')
    requests.push({ at: new Date().toISOString(), method, path, query: url.search, body });
  if (requests.length > 1000) requests.shift();

  if (path === '/' && method === 'GET') return send(res, 200, page(), 'text/html; charset=utf-8');
  if (path === '/__events') return send(res, 200, events);
  if (path === '/__requests') return send(res, 200, requests);
  if (path === '/__reset' && method === 'POST') {
    events.length = 0;
    requests.length = 0;
    failNextMeta = false;
    return send(res, 200, { ok: true });
  }
  if (path === '/__fail' && method === 'POST') {
    failNextMeta = true;
    return send(res, 200, { ok: true });
  }
  if (path.startsWith('/meta/')) return meta(res, method, path.slice(5), url.searchParams, body);
  if (path.startsWith('/tiktok/')) return tiktok(res, method, path.slice(7), req.headers, body);
  if (path.startsWith('/ga4/')) return ga4(res, method, path.slice(4), url.searchParams, body);
  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Ad tracking stand-in on http://${HOST}:${PORT} (NOT Meta, TikTok or Google)`);
  console.log(`  Meta pixel ${KEYS.meta.pixelId}, token ${KEYS.meta.token}`);
  console.log(`  TikTok pixel ${KEYS.tiktok.pixelCode}, token ${KEYS.tiktok.token}`);
  console.log(`  GA4 ${KEYS.ga4.measurementId}, API secret ${KEYS.ga4.secret}`);
});
