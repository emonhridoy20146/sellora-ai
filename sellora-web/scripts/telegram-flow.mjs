/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through owner reports and alerts on Telegram (ADR 0022) in a real browser, against
 * a running web app, API, worker and the Telegram stand-in (sellora-api/scripts/
 * telegram-stand-in.mjs, NOT Telegram). The worker sends every message, so it must run.
 *
 * What it checks: Admin › Telegram shows the bot; "Connect" sets the webhook; "Link a chat"
 * makes a code that links the private chat (/start <code>) and the group (/link <code>) when
 * typed in the stand-in, and the bot says hello in each; /status and /today get answers;
 * a chat limited to reports gets the daily report from "Send now", which names no business;
 * three failed sign-ins over a threshold of 3 send a sign-in alert; a chat that blocked the bot
 * shows Unreachable and comes back after a test; "Sent lately" lists the messages. Fails on
 * console errors, unexpected API errors or a missing result.
 *
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
 *   node scripts/telegram-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), TELEGRAM_STAND_IN_URL
 * (http://localhost:4080), REDIS_URL (the API's, redis://127.0.0.1:6379/0). Clears the sign-in
 * alert's counters in that Redis (redis-cli) so it can run again within 30 minutes; puts the
 * sign-in threshold back to what it was.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const TG = (env.TELEGRAM_STAND_IN_URL ?? 'http://localhost:4080').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/telegram';
// The API's Redis (its REDIS_URL), where the alert counters live.
const REDIS_URL = env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
mkdirSync(OUT, { recursive: true });

const OWNER_CHAT = '5001';
const GROUP = '-1009000000001';
const DEMO_NAMES = ['Nakshi Ghor', 'Dhaka Fashion House', 'shop@demo.sellora.test'];

const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function totpAt(secretBase32, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretBase32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text()))
      problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    const path = new URL(r.url()).pathname;
    if (s >= 500 || (s >= 400 && s !== 401 && path.startsWith('/v1/')))
      problems.push(`${label} ${s} ${r.request().method()} ${path}`);
  });
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    steps.push({ name, ok: true, ms: Date.now() - started });
  } catch (err) {
    steps.push({ name, ok: false, error: String(err).split('\n')[0].slice(0, 300) });
    throw err;
  }
}

async function shot(page, name, fullPage = false) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
}

/** Calls the API from inside the signed-in admin page (cookies and the CSRF header). */
async function call(page, method, path, body) {
  const r = await page.evaluate(
    async ({ method, path, body }) => {
      const name = 'slp_csrf=';
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith(name))
        ?.slice(name.length);
      const res = await fetch(`/v1${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { method, path, body },
  );
  if (r.status >= 400)
    throw new Error(
      `${method} ${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  return r.body;
}

async function until(probe, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 750));
  }
}

/** What the bot sent to a chat in the stand-in, oldest first. */
async function botSaid(chatId) {
  const all = await (await fetch(`${TG}/__messages`)).json();
  return all.filter((m) => m.chatId === chatId && m.from === 'bot').map((m) => m.text);
}

/** Types in a stand-in chat, as a person in it would. */
async function say(chatId, text) {
  const r = await fetch(
    `${TG}/__say?chat=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}`,
    {
      method: 'POST',
    },
  );
  const body = await r.json();
  check(r.ok, `the stand-in could not pass "${text}" to the webhook: ${body.error}`);
}

/** Waits for the bot's next message in a chat that matches. */
async function nextFromBot(chatId, before, pattern, what, timeoutMs = 30_000) {
  return until(
    async () => (await botSaid(chatId)).slice(before).find((t) => pattern.test(t)),
    what,
    timeoutMs,
  );
}

const browser = await chromium.launch();
const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await actx.newPage();
const tgPage = await (
  await browser.newContext({ viewport: { width: 1200, height: 900 } })
).newPage();
watch(admin, 'admin');
let failed = false;
let threshold = null;

try {
  await step('the stand-in is up; sign in as super-admin', async () => {
    const r = await fetch(`${TG}/__messages`).catch(() => null);
    check(r?.ok, `the Telegram stand-in is not running at ${TG}`);
    await fetch(`${TG}/__reset`, { method: 'POST' });
    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    await admin.fill(
      '#code',
      totpAt(need('SMOKE_ADMIN_TOTP_SECRET'), Math.floor(Date.now() / 30_000)),
    );
    await admin.click('button[type=submit]');
    await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });
  });

  await step('Admin › Telegram shows the bot; Connect sets the webhook', async () => {
    await admin.getByRole('link', { name: 'Telegram' }).click();
    await admin.waitForURL('**/admin/telegram');
    await admin.getByRole('heading', { name: 'Telegram', level: 1 }).waitFor();
    const bot = admin.getByTestId('telegram-bot');
    await bot.getByTestId('telegram-bot-name').getByText('@sellora_standin_bot').waitFor();
    // Start from no chats, so the run shows linking from the beginning.
    const before = await call(admin, 'GET', '/platform/telegram');
    threshold = before.alerts.loginFailures;
    for (const c of before.chats)
      await call(admin, 'DELETE', `/platform/telegram/chats/${encodeURIComponent(c.chatId)}`);
    await admin.reload();
    await bot.getByRole('button', { name: /^Connect/ }).click();
    await admin.getByText('Telegram now sends commands').waitFor();
    await bot.getByTestId('telegram-webhook-on').waitFor();
    await shot(admin, '01-bot-connected');
  });

  await step('link the private chat: the code typed as /start in the stand-in', async () => {
    const chats = admin.getByTestId('telegram-chats');
    await chats.getByRole('button', { name: 'Link a chat' }).click();
    const code = (await chats.getByTestId('telegram-link-code').textContent()).trim();
    check(/^[a-f0-9]{12}$/.test(code), `a link code (${code})`);
    await chats.getByRole('link', { name: /open @sellora_standin_bot/ }).waitFor();
    await shot(admin, '02-link-code');
    await say(OWNER_CHAT, `/start ${code}`);
    await chats.getByText('Chat linked').waitFor({ timeout: 20_000 });
    await chats.getByTestId(`telegram-chat-${OWNER_CHAT}`).waitFor();
    await nextFromBot(OWNER_CHAT, 0, /Connected to Sellora/, 'the hello in the private chat');
    await chats.getByRole('button', { name: 'Done' }).click();
  });

  await step('link the group with /link <code>; the code works only once', async () => {
    const chats = admin.getByTestId('telegram-chats');
    await chats.getByRole('button', { name: 'Link a chat' }).click();
    const code = (await chats.getByTestId('telegram-link-code').textContent()).trim();
    await say(GROUP, `/link ${code}`);
    await chats.getByText('Chat linked').waitFor({ timeout: 20_000 });
    await chats.getByRole('button', { name: 'Done' }).click();
    await chats.getByTestId(`telegram-chat-${GROUP}`).waitFor();
    await nextFromBot(GROUP, 0, /Connected to Sellora/, 'the hello in the group');
    const n = (await botSaid(GROUP)).length;
    await say(GROUP, `/link ${code}`);
    await nextFromBot(GROUP, n, /expired or was used/, 'the answer to a used code');
  });

  await step('the bot answers /status and /today in the private chat', async () => {
    let n = (await botSaid(OWNER_CHAT)).length;
    await say(OWNER_CHAT, '/status');
    await nextFromBot(OWNER_CHAT, n, /Sellora status[\s\S]*Queues:/, 'the /status answer');
    n = (await botSaid(OWNER_CHAT)).length;
    await say(OWNER_CHAT, '/today');
    const today = await nextFromBot(
      OWNER_CHAT,
      n,
      /today so far[\s\S]*Sign-ups:/,
      'the /today answer',
    );
    for (const name of DEMO_NAMES)
      check(!today.includes(name), `/today names no business (${name})`);
    await tgPage.goto(TG);
    await tgPage
      .locator(`section[data-chat="${OWNER_CHAT}"]`)
      .getByText('Sellora today so far')
      .waitFor();
    await tgPage.screenshot({ path: join(OUT, '03-stand-in-commands.png') });
  });

  await step(
    'the group gets only reports: Save, then Send now sends the daily report',
    async () => {
      const group = admin.getByTestId(`telegram-chat-${GROUP}`);
      for (const label of [
        'Backup alerts',
        'Payment alerts',
        'AI provider and spend alerts',
        'Sign-in failure spikes',
        'Queue backlog and server status',
      ])
        await group.getByRole('checkbox', { name: label }).click();
      await group.getByRole('button', { name: 'Save' }).click();
      await admin.getByText(/Saved what .* gets/).waitFor();
      const saved = await call(admin, 'GET', '/platform/telegram');
      const topics = saved.chats.find((c) => c.chatId === GROUP).topics;
      check(
        topics.length === 1 && topics[0] === 'reports',
        `the group takes only reports (${topics})`,
      );

      const n = (await botSaid(GROUP)).length;
      const reports = admin.getByTestId('telegram-reports');
      await reports.getByRole('button', { name: 'Send now' }).first().click();
      await admin.getByText('Report on its way to 2 chats.').waitFor();
      const report = await nextFromBot(
        GROUP,
        n,
        /Sellora daily report/,
        'the daily report in the group',
      );
      for (const part of [
        'Sign-ups:',
        'MRR:',
        'Real cost:',
        'Orders:',
        'Last platform backup:',
        'Worker host: load',
      ])
        check(report.includes(part), `the report has "${part}"`);
      for (const name of DEMO_NAMES)
        check(!report.includes(name), `the report names no business (${name})`);
      await tgPage.goto(TG);
      await tgPage
        .locator(`section[data-chat="${GROUP}"]`)
        .getByText('Sellora daily report')
        .waitFor();
      await tgPage.screenshot({ path: join(OUT, '04-stand-in-report.png') });
    },
  );

  await step('three failed sign-ins over a threshold of 3 send a sign-in alert', async () => {
    // The alert's counters live in Redis; cleared so this can run again within 30 minutes.
    try {
      for (const pattern of [
        '*tg-count:login_failure:*',
        '*tg-count-d:login_failure:*',
        '*tg-alert:spike-login-failure',
        '*tg-alert-n:spike-login-failure',
      ]) {
        const keys = execFileSync('redis-cli', ['-u', REDIS_URL, '--scan', '--pattern', pattern])
          .toString()
          .split('\n')
          .filter(Boolean);
        if (keys.length) execFileSync('redis-cli', ['-u', REDIS_URL, 'del', ...keys]);
      }
    } catch {
      console.log(
        '(could not clear the counters with redis-cli: a second run within 30 minutes is grouped with the first)',
      );
    }
    const alerts = admin.getByTestId('telegram-alerts');
    await alerts.locator('#alert-loginFailures').fill('3');
    await alerts.getByRole('button', { name: 'Save' }).click();
    await admin.getByText('Alert settings saved.').waitFor();
    // The API reads alert settings at most every 15 seconds.
    await admin.waitForTimeout(16_000);
    const n = (await botSaid(OWNER_CHAT)).length;
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${BASE}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sellora-client': 'api' },
        body: JSON.stringify({
          email: `nobody.${Date.now()}@example.test`,
          password: 'wrong password here',
        }),
      });
      check(r.status === 401, `a wrong sign-in is refused (${r.status})`);
    }
    const alert = await nextFromBot(
      OWNER_CHAT,
      n,
      /3 failed sign-ins in 15 minutes/,
      'the sign-in alert',
    );
    check(/Business sign-ins: 3/.test(alert), 'the alert says where');
    check(!/nobody\./.test(alert), 'the alert names no account');
    const group = await botSaid(GROUP);
    check(!group.some((t) => /failed sign-ins/.test(t)), 'the group (reports only) did not get it');
  });

  await step('a chat that blocked the bot is Unreachable, and a test brings it back', async () => {
    await fetch(`${TG}/__block?chat=${OWNER_CHAT}`, { method: 'POST' });
    const row = admin.getByTestId(`telegram-chat-${OWNER_CHAT}`);
    await row.getByRole('button', { name: 'Send a test' }).click();
    await admin
      .getByText(/Test message on its way/)
      .first()
      .waitFor();
    await until(async () => {
      const o = await call(admin, 'GET', '/platform/telegram');
      return o.chats.find((c) => c.chatId === OWNER_CHAT)?.status === 'unreachable';
    }, 'the chat to be marked unreachable');
    await admin.reload();
    await row.getByTestId('telegram-chat-unreachable').waitFor();
    await row.getByText(/blocked by the user/).waitFor();
    await shot(admin, '05-unreachable');
    await fetch(`${TG}/__block?chat=${OWNER_CHAT}`, { method: 'POST' });
    const n = (await botSaid(OWNER_CHAT)).length;
    await row.getByRole('button', { name: 'Send a test' }).click();
    await nextFromBot(OWNER_CHAT, n, /Test from Sellora/, 'the test message');
    await admin.reload();
    await row.getByText('Active').waitFor();
  });

  await step('Sent lately lists the messages and the failure', async () => {
    const card = admin.getByTestId('telegram-messages');
    await card.scrollIntoViewIfNeeded();
    await card.getByText('Sent', { exact: true }).first().waitFor();
    await card.getByText('Failed', { exact: true }).first().waitFor();
    await card.getByText('Report', { exact: true }).first().waitFor();
    await card.getByText('Alert', { exact: true }).first().waitFor();
    await admin.waitForTimeout(300);
    await card.screenshot({ path: join(OUT, '06-sent-lately.png') });
    await shot(admin, '07-page', true);
  });
} catch (err) {
  failed = true;
  console.error(String(err));
  await shot(admin, 'zz-failure-admin', true).catch(() => undefined);
} finally {
  if (threshold !== null)
    await call(admin, 'PATCH', '/platform/telegram/settings', {
      alerts: { loginFailures: threshold },
    }).catch(() => undefined);
  await browser.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? ` (${s.ms} ms)` : `: ${s.error}`}`);
if (problems.length) {
  console.log('\nProblems seen in the browser:');
  for (const p of problems) console.log(`  ${p}`);
}
const ok = !failed && problems.length === 0;
console.log(
  `\n${steps.filter((s) => s.ok).length}/${steps.length} steps passed${problems.length ? `, ${problems.length} problems` : ''}`,
);
process.exit(ok ? 0 : 1);
