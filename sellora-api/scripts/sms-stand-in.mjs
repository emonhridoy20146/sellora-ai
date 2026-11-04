/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for the BulkSMSBD and Alpha SMS (sms.net.bd) APIs, for local demos and browser
 * checks when no real SMS account is available. It is NOT an SMS gateway: no phone receives
 * anything. It answers in the request and response shapes of the providers' published HTTP
 * APIs, so Sellora's checks, sends, charges and failures run as they would for real, and it
 * shows what "arrived" on an inbox page.
 *
 *   node scripts/sms-stand-in.mjs        # listens on 127.0.0.1:4060
 *   SMS_BULKSMSBD_BASE_URL=http://127.0.0.1:4060/bulksmsbd \
 *   SMS_ALPHA_BASE_URL=http://127.0.0.1:4060/alpha  npm run dev   # and dev:worker
 *   open http://127.0.0.1:4060/            # the inbox: every message, newest first
 *
 * Demo accounts (anything else is refused, like a real provider would):
 *   BulkSMSBD  API key demo-bulksmsbd-key, sender ids 8809617000000 and those registered below
 *   Alpha SMS  API key demo-alpha-key (any sender id; Alpha uses its default without one)
 *
 * Test hooks (not part of any provider API):
 *   GET  /__messages                      messages so far (JSON)
 *   POST /__senders {"name"}              register a sender name with the BulkSMSBD account,
 *                                         as the provider does after its paperwork
 *   POST /__fail {"fault"}                the next send fails: "lose-reply" (the message goes
 *                                         out, then the connection drops) or an HTTP status
 *   POST /__balance {"provider","balance"} set an account's balance (0 shows "out of balance")
 *   POST /__reset                         forget messages and faults
 *
 * Never point a production deployment at it.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4060);
const BULK = {
  key: 'demo-bulksmsbd-key',
  balance: 5000,
  senders: new Set(['8809617000000', 'SelloraDemo']),
};
const ALPHA = { key: 'demo-alpha-key', balance: 2500 };
const BD_MOBILE = /^8801[3-9]\d{8}$/;

/** @type {{ id: string, provider: string, to: string, from: string, text: string, at: string }[]} */
const messages = [];
/** @type {(string | number)[]} */
const faults = [];
let seq = 0;

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/** Applies the next fault, if any. Returns true when the request was answered by it. */
function fault(res, send) {
  const f = faults.shift();
  if (f === undefined) return false;
  if (f === 'lose-reply') {
    send();
    res.socket?.destroy();
    return true;
  }
  json(res, { message: `stand-in fault ${f}` }, Number(f));
  return true;
}

function record(provider, to, from, text) {
  seq += 1;
  const id = `${provider === 'bulksmsbd' ? 'B' : ''}${String(seq).padStart(6, '0')}`;
  messages.unshift({ id, provider, to, from, text, at: new Date().toISOString() });
  if (messages.length > 500) messages.length = 500;
  console.log(`[sms] ${provider} → +${to} from ${from || '(default)'}: ${text.slice(0, 80)}`);
  return id;
}

function bulksmsbd(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const known = q.api_key === BULK.key;
  if (url.pathname === '/bulksmsbd/api/getBalanceApi') {
    if (!known) return json(res, { response_code: 1011, error_message: 'User Id not found' });
    return json(res, { response_code: 202, balance: BULK.balance });
  }
  if (url.pathname !== '/bulksmsbd/api/smsapi') return json(res, { error: 'not found' }, 404);
  if (!known) return json(res, { response_code: 1011, error_message: 'User Id not found' });
  if (!q.senderid || !BULK.senders.has(q.senderid))
    return json(res, { response_code: 1005, error_message: 'Sender Id not found' });
  if (!BD_MOBILE.test(q.number ?? ''))
    return json(res, { response_code: 1001, error_message: 'Invalid Number' });
  if (BULK.balance < 1)
    return json(res, { response_code: 1007, error_message: 'Balance Insufficient' });
  let id = '';
  const send = () => {
    BULK.balance -= 1;
    id = record('bulksmsbd', q.number, q.senderid, q.message ?? '');
  };
  if (fault(res, send)) return;
  send();
  return json(res, {
    response_code: 202,
    message_id: id,
    success_message: 'SMS Submitted Successfully',
  });
}

async function alpha(req, res, url) {
  if (url.pathname === '/alpha/user/balance/') {
    if (url.searchParams.get('api_key') !== ALPHA.key)
      return json(res, { error: 405, msg: 'Authorization Required' });
    return json(res, { error: 0, msg: 'Success', data: { balance: ALPHA.balance.toFixed(4) } });
  }
  if (url.pathname !== '/alpha/sendsms' || req.method !== 'POST')
    return json(res, { error: 404, msg: 'Not found' });
  const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
  if (form.api_key !== ALPHA.key) return json(res, { error: 405, msg: 'Authorization Required' });
  if (!form.msg) return json(res, { error: 414, msg: 'Empty message' });
  if (!BD_MOBILE.test(form.to ?? ''))
    return json(res, { error: 416, msg: 'No valid number found' });
  if (ALPHA.balance < 1) return json(res, { error: 417, msg: 'Insufficient balance' });
  let id = '';
  const send = () => {
    ALPHA.balance -= 1;
    id = record('alpha_sms', form.to, form.sender_id ?? '', form.msg);
  };
  if (fault(res, send)) return;
  send();
  return json(res, {
    error: 0,
    msg: 'Request successfully submitted',
    data: { request_id: Number(id) },
  });
}

const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Every message grouped by phone, like a row of phones on a desk. */
function inbox(res) {
  const byPhone = new Map();
  for (const m of messages) {
    if (!byPhone.has(m.to)) byPhone.set(m.to, []);
    byPhone.get(m.to).push(m);
  }
  const phones = [...byPhone.entries()]
    .map(
      ([to, list]) => `
      <section class="phone" aria-label="Messages to 0${escape(to.slice(3))}">
        <header><strong>0${escape(to.slice(3))}</strong><span>${list.length} message${list.length === 1 ? '' : 's'}</span></header>
        <ol>${[...list]
          .reverse()
          .map(
            (m) => `
          <li>
            <p class="from">${escape(m.from || 'Alpha SMS default')} · ${m.provider === 'bulksmsbd' ? 'BulkSMSBD' : 'Alpha SMS'}</p>
            <p class="bubble">${escape(m.text).replace(/\n/g, '<br>')}</p>
            <time datetime="${m.at}">${new Date(m.at).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</time>
          </li>`,
          )
          .join('')}</ol>
      </section>`,
    )
    .join('');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="4">
<title>SMS stand-in inbox</title>
<style>
  :root { color-scheme: light; --bg:#f4f5f7; --card:#fff; --ink:#1d2330; --muted:#667085; --line:#e4e7ec; --bubble:#e9eef8; }
  body { margin:0; font:14px/1.45 system-ui, 'Noto Sans Bengali', sans-serif; background:var(--bg); color:var(--ink); }
  .top { padding:16px; border-bottom:1px solid var(--line); background:var(--card); }
  .top h1 { margin:0 0 4px; font-size:17px; }
  .top p { margin:0; color:var(--muted); font-size:13px; }
  .grid { display:grid; gap:16px; padding:16px; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); }
  .phone { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:14px; }
  .phone header { display:flex; justify-content:space-between; align-items:baseline; padding:0 4px 10px; border-bottom:1px solid var(--line); }
  .phone header span { color:var(--muted); font-size:12px; }
  ol { list-style:none; margin:0; padding:10px 0 0; display:grid; gap:12px; }
  .from { margin:0 4px 3px; color:var(--muted); font-size:12px; }
  .bubble { margin:0; background:var(--bubble); border-radius:14px 14px 14px 4px; padding:9px 12px; white-space:normal; overflow-wrap:anywhere; }
  time { display:block; margin:3px 4px 0; color:var(--muted); font-size:11px; }
  .empty { padding:48px 16px; text-align:center; color:var(--muted); }
</style></head>
<body>
  <div class="top">
    <h1>SMS stand-in inbox</h1>
    <p>Local demo only: these messages reached this stand-in, not real phones. BulkSMSBD balance ${BULK.balance} · Alpha SMS balance ${ALPHA.balance}. Refreshes every few seconds.</p>
  </div>
  ${phones ? `<div class="grid">${phones}</div>` : '<p class="empty">No messages yet.</p>'}
</body></html>`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = async () => {
    if (url.pathname === '/' && req.method === 'GET') return inbox(res);
    if (url.pathname === '/__messages') return json(res, messages);
    if (url.pathname === '/__reset' && req.method === 'POST') {
      messages.length = 0;
      faults.length = 0;
      return json(res, { ok: true });
    }
    if (url.pathname === '/__senders' && req.method === 'POST') {
      const { name } = JSON.parse((await readBody(req)) || '{}');
      if (typeof name !== 'string' || !name) return json(res, { error: 'name' }, 400);
      BULK.senders.add(name);
      return json(res, { senders: [...BULK.senders] });
    }
    if (url.pathname === '/__fail' && req.method === 'POST') {
      const { fault: f } = JSON.parse((await readBody(req)) || '{}');
      if (f !== 'lose-reply' && !(Number(f) >= 400 && Number(f) < 600))
        return json(res, { error: 'fault' }, 400);
      faults.push(f);
      return json(res, { faults });
    }
    if (url.pathname === '/__balance' && req.method === 'POST') {
      const { provider, balance } = JSON.parse((await readBody(req)) || '{}');
      const target = provider === 'alpha_sms' ? ALPHA : BULK;
      target.balance = Number(balance) || 0;
      return json(res, { balance: target.balance });
    }
    if (url.pathname.startsWith('/bulksmsbd/')) return bulksmsbd(req, res, url);
    if (url.pathname.startsWith('/alpha/')) return alpha(req, res, url);
    return json(res, { error: 'not found' }, 404);
  };
  route().catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, { error: 'stand-in error' }, 500);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SMS stand-in on http://127.0.0.1:${PORT} (inbox at /). Not a real gateway.`);
});
