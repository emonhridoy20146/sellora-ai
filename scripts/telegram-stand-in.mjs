/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for the Telegram Bot API, for trying owner reports and alerts locally
 * (ADR 0022). It is NOT Telegram: it keeps chats and messages in memory, shows them on its
 * own page, and plays the people in those chats by sending updates to the API's webhook. It
 * speaks just enough of the Bot API for Sellora's client.
 *
 *   node scripts/telegram-stand-in.mjs     # on http://localhost:4080
 *
 * Point the API at it (.env), then restart the API and the worker:
 *
 *   TELEGRAM_BOT_TOKEN=7000000001:stand-in-token-not-telegram-0001
 *   TELEGRAM_API_URL=http://localhost:4080
 *
 *   open http://localhost:4080                   # the chats, what the bot sent, and a box to type
 *   curl localhost:4080/__messages               # every message the bot sent (JSON)
 *   curl -X POST 'localhost:4080/__say?chat=5001&text=/status'   # as if you wrote to the bot
 *   curl -X POST 'localhost:4080/__block?chat=5001'              # as if you blocked the bot
 *   curl -X POST 'localhost:4080/__rate-limit?times=2&after=3'   # the next 2 sends get a 429
 *
 * In Admin › Telegram press "Connect" so the stand-in knows where the API's webhook is.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4080);
const BOT = {
  id: 7000000001,
  is_bot: true,
  first_name: 'Sellora (stand-in)',
  username: 'sellora_standin_bot',
};

const chats = new Map([
  [
    '5001',
    {
      id: 5001,
      type: 'private',
      first_name: 'You',
      last_name: '(stand-in)',
      username: 'you_standin',
    },
  ],
  [
    '-1009000000001',
    { id: -1009000000001, type: 'supergroup', title: 'Sellora owners (stand-in)' },
  ],
]);
const messages = []; // { chatId, from: 'bot' | 'you', text, at, id }
const blocked = new Set();
let rateLimit = null; // { times, after }
let webhook = null; // { url, secret }
let tokenSeen = null;
let nextMessageId = 1;
let nextUpdateId = 1;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Telegram HTML as the bot sent it: only its bare tags are kept, anything else is escaped. */
const safeHtml = (s) => String(s).replace(/<(?!\/?(?:b|i|u|s|code|pre)>)/g, '&lt;');

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function bodyOf(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const fail = (res, code, description, extra = {}) =>
  send(res, code, { ok: false, error_code: code, description, ...extra });

/** Sends what "you" typed in a chat to the API's webhook, as Telegram would. */
async function say(chatId, text) {
  const chat = chats.get(String(chatId));
  if (!chat) return { ok: false, error: 'No such chat in the stand-in' };
  messages.push({
    chatId: String(chatId),
    from: 'you',
    text,
    at: new Date().toISOString(),
    id: nextMessageId++,
  });
  if (!webhook)
    return { ok: false, error: 'No webhook yet: press "Connect" in Admin › Telegram first' };
  const update = {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: 5001, is_bot: false, first_name: 'You', username: 'you_standin' },
      text,
    },
  };
  try {
    const r = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': webhook.secret,
      },
      body: JSON.stringify(update),
    });
    return r.ok ? { ok: true } : { ok: false, error: `The webhook answered ${r.status}` };
  } catch (err) {
    return { ok: false, error: `The webhook could not be reached: ${err.message}` };
  }
}

function botApi(method, params, res) {
  switch (method) {
    case 'getMe':
      return send(res, 200, { ok: true, result: BOT });
    case 'getChat': {
      const chat = chats.get(String(params.chat_id));
      return chat
        ? send(res, 200, { ok: true, result: chat })
        : fail(res, 400, 'Bad Request: chat not found');
    }
    case 'sendMessage': {
      if (rateLimit && rateLimit.times > 0) {
        rateLimit.times -= 1;
        return fail(res, 429, `Too Many Requests: retry after ${rateLimit.after}`, {
          parameters: { retry_after: rateLimit.after },
        });
      }
      const chatId = String(params.chat_id);
      if (blocked.has(chatId)) return fail(res, 403, 'Forbidden: bot was blocked by the user');
      const chat = chats.get(chatId);
      if (!chat) return fail(res, 400, 'Bad Request: chat not found');
      const text = String(params.text ?? '');
      if (!text) return fail(res, 400, 'Bad Request: message text is empty');
      if (text.length > 4096) return fail(res, 400, 'Bad Request: message is too long');
      const id = nextMessageId++;
      messages.push({
        chatId,
        from: 'bot',
        text,
        at: new Date().toISOString(),
        id,
        parseMode: params.parse_mode ?? null,
      });
      console.log(`→ ${chatId}: ${text.split('\n')[0]}`);
      return send(res, 200, {
        ok: true,
        result: { message_id: id, date: Math.floor(Date.now() / 1000), chat, text },
      });
    }
    case 'setWebhook':
      webhook = { url: String(params.url), secret: String(params.secret_token ?? '') };
      console.log(`webhook set: ${webhook.url}`);
      return send(res, 200, { ok: true, result: true, description: 'Webhook was set' });
    case 'deleteWebhook':
      webhook = null;
      return send(res, 200, { ok: true, result: true, description: 'Webhook was deleted' });
    case 'getWebhookInfo':
      return send(res, 200, {
        ok: true,
        result: { url: webhook?.url ?? '', has_custom_certificate: false, pending_update_count: 0 },
      });
    default:
      return fail(res, 404, 'Not Found: method not found');
  }
}

function page() {
  const rows = [...chats.values()]
    .map((c) => {
      const id = String(c.id);
      const name = c.title ?? [c.first_name, c.last_name].filter(Boolean).join(' ');
      const thread = messages
        .filter((m) => m.chatId === id)
        .slice(-40)
        .map(
          (m) =>
            `<div class="msg ${m.from}" data-testid="msg-${esc(id)}"><div class="text">${m.from === 'bot' ? safeHtml(m.text) : esc(m.text)}</div><div class="at">${esc(m.at.slice(11, 19))}</div></div>`,
        )
        .join('');
      return `<section data-chat="${esc(id)}"><h2>${esc(name)} <small>${esc(c.type)} · ${esc(id)}${blocked.has(id) ? ' · <b>bot blocked</b>' : ''}</small></h2>
<div class="thread">${thread || '<p class="none">No messages yet.</p>'}</div>
<form method="post" action="/__say"><input type="hidden" name="chat" value="${esc(id)}"><input name="text" placeholder="${c.type === 'private' ? '/start <code>, /status, /help' : '/link <code>, /today'}" aria-label="Message to the bot in ${esc(name)}"><button>Send</button></form></section>`;
    })
    .join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Telegram stand-in</title>
<style>body{font:15px system-ui;max-width:980px;margin:24px auto;padding:0 16px;color:#1c1c1e;background:#f4f4f5}
.warn{background:#fff4ce;border:1px solid #e0c060;padding:8px 12px;border-radius:8px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
section{background:#fff;border-radius:12px;padding:12px;box-shadow:0 1px 2px #0002}
h2{font-size:16px;margin:0 0 8px}small{color:#666;font-weight:400}
.thread{max-height:520px;overflow:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.msg{padding:6px 10px;border-radius:10px;max-width:92%;white-space:pre-wrap;word-break:break-word}
.bot{background:#eef4ff;align-self:flex-start}.you{background:#dcf8c6;align-self:flex-end}
.at{font-size:11px;color:#888;text-align:right}.none{color:#888}
form{display:flex;gap:6px}input{flex:1;padding:6px 8px;font:inherit}button{font:inherit}</style>
<p class="warn">This is a <b>stand-in</b> for Telegram, not Telegram. Bot: @${esc(BOT.username)} · webhook: ${webhook ? esc(webhook.url) : 'not set (press Connect in Admin › Telegram)'}${tokenSeen ? '' : ' · no API call yet'}</p>
<main>${rows}</main>
<script>setTimeout(()=>{if(!document.activeElement||document.activeElement.tagName!=='INPUT')location.reload()},4000)</script>`;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    const bot = /^\/bot(\d+:[A-Za-z0-9_-]{20,})\/(\w+)$/.exec(url.pathname);
    if (bot) {
      tokenSeen = bot[1];
      const params =
        req.method === 'GET' ? Object.fromEntries(url.searchParams) : await bodyOf(req);
      return botApi(bot[2], params, res);
    }
    if (req.method === 'GET' && url.pathname === '/')
      return send(res, 200, page(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/__messages') return send(res, 200, messages);
    if (req.method === 'POST' && url.pathname === '/__say') {
      const form = await bodyOf(req);
      const chat = url.searchParams.get('chat') ?? form.chat;
      const text = url.searchParams.get('text') ?? form.text;
      const result = await say(chat, String(text ?? '').trim());
      if ((req.headers.accept ?? '').includes('text/html')) {
        res.writeHead(303, { location: '/' });
        return res.end();
      }
      return send(res, result.ok ? 200 : 409, result);
    }
    if (req.method === 'POST' && url.pathname === '/__block') {
      const chat = String(url.searchParams.get('chat'));
      if (blocked.has(chat)) blocked.delete(chat);
      else blocked.add(chat);
      return send(res, 200, { blocked: [...blocked] });
    }
    if (req.method === 'POST' && url.pathname === '/__rate-limit') {
      rateLimit = {
        times: Number(url.searchParams.get('times') ?? 1),
        after: Number(url.searchParams.get('after') ?? 3),
      };
      return send(res, 200, rateLimit);
    }
    if (req.method === 'POST' && url.pathname === '/__reset') {
      messages.length = 0;
      blocked.clear();
      rateLimit = null;
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String(err) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Telegram stand-in (NOT Telegram) on http://localhost:${PORT}`);
});
