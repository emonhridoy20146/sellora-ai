/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through Messenger, Instagram and WhatsApp in a real browser against a running web
 * app and API whose Meta settings point at the Graph API stand-in
 * (sellora-api/scripts/graph-stand-in.mjs). It is NOT a test against Meta: Facebook's login
 * page is replaced by an instant redirect back to Sellora, and customers' messages are
 * webhooks this script signs with the app secret, exactly as Meta would send them.
 *
 * What it checks: connecting a Facebook page with its Instagram account and a WhatsApp
 * number in Settings › Channels; customers' messages arriving live in the inbox; replies,
 * the AI agent's included, reaching the Graph API; "Seen" from read receipts; replies sent
 * from the Facebook or Instagram apps showing in the thread and pausing the AI; a refused
 * message with Retry; the 24-hour reply window; and a revoked token asking for a reconnect.
 * Fails on console errors, unexpected API errors or a missing result. Creates real data in
 * the signed-in business and leaves the channels connected.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… META_APP_SECRET=… node scripts/meta-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), META_WEBHOOK_URL
 * (http://127.0.0.1:4000/v1/webhooks/meta), GRAPH_STAND_IN_URL (http://127.0.0.1:4020).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const WEBHOOK = env.META_WEBHOOK_URL ?? 'http://127.0.0.1:4000/v1/webhooks/meta';
const GRAPH = (env.GRAPH_STAND_IN_URL ?? 'http://127.0.0.1:4020').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/meta';
mkdirSync(OUT, { recursive: true });

// The stand-in's demo accounts.
const PAGE = { id: '100000000000001', name: 'Sellora Demo Page' };
const IG = { id: '17841400000000777', username: 'sellora.demo' };
const WA = { phoneNumberId: '200000000000001', wabaId: '300000000000001' };

// Customer ids unique to this run, so a second run starts new conversations. Customers are
// named after the last 4 digits of their id, kept distinct so an older chat is never opened.
const run = String(Date.now()).slice(-6);
const tails = new Set();
const uniqueTail = () => {
  for (;;) {
    const t = String(1000 + Math.floor(Math.random() * 9000));
    if (!tails.has(t)) return tails.add(t) && t;
  }
};
const PSID = `7101${run}${uniqueTail()}`;
const PSID_OLD = `7102${run}${uniqueTail()}`;
const IGSID = `7201${run}${uniqueTail()}`;
const WA_FROM = `8801${run}${uniqueTail()}`;
const tail = (id) => id.slice(-4);
const WA_NAME = `Karim Uddin ${tail(WA_FROM)}`;

const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}
const SECRET = need('META_APP_SECRET');

function watch(page, label, allow = []) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (allow.some((re) => re.test(text))) return;
    problems.push(`${label} console: ${text.slice(0, 200)}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 500 || (s >= 400 && s !== 401 && r.url().includes('/v1/')))
      problems.push(`${label} ${s} ${r.request().method()} ${new URL(r.url()).pathname}`);
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
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
  await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
  await page.click('button[type=submit]');
  await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
  return new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
}

/** Posts a webhook signed like Meta signs it; returns the HTTP status. */
async function webhook(body, secret = SECRET) {
  const raw = JSON.stringify(body);
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  return res.status;
}

async function deliver(body) {
  const status = await webhook(body);
  if (status !== 200) throw new Error(`webhook answered ${status}`);
}

const messaging = (object, accountId, event) => ({
  object,
  entry: [{ id: accountId, time: Date.now(), messaging: [event] }],
});
const hooks = {
  message: (object, accountId, from, text, at = Date.now()) =>
    messaging(object, accountId, {
      sender: { id: from },
      recipient: { id: accountId },
      timestamp: at,
      message: { mid: `m_${object}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text },
    }),
  echo: (object, accountId, to, text) =>
    messaging(object, accountId, {
      sender: { id: accountId },
      recipient: { id: to },
      timestamp: Date.now(),
      // No app_id: sent from Facebook's or Instagram's own apps, not through Sellora.
      message: { mid: `m_echo_${Date.now()}`, text, is_echo: true },
    }),
  read: (accountId, from) =>
    messaging('page', accountId, {
      sender: { id: from },
      recipient: { id: accountId },
      timestamp: Date.now(),
      read: { watermark: Date.now() },
    }),
  whatsapp: (value) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WA.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '8801711000000',
                phone_number_id: WA.phoneNumberId,
              },
              ...value,
            },
          },
        ],
      },
    ],
  }),
};

async function graphSent() {
  const res = await fetch(`${GRAPH}/__sent`);
  return (await res.json()).sent;
}

/** Waits until the stand-in has received a message matching `match`, and returns it. */
async function waitSent(match, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await graphSent()).find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the Graph API never received ${what}`);
}

async function failNextSend(code) {
  await fetch(`${GRAPH}/__fail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

const browser = await chromium.launch();
let failed = false;
let staff;

try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // Facebook Login, replaced: straight back to Sellora with a code, as after "Continue".
  await ctx.route('https://www.facebook.com/**', async (route) => {
    const u = new URL(route.request().url());
    const back = new URL(u.searchParams.get('redirect_uri') ?? `${BASE}/app/connect/meta`);
    back.searchParams.set('code', `stand-in-code-${Date.now()}`);
    back.searchParams.set('state', u.searchParams.get('state') ?? '');
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  staff = await ctx.newPage();
  watch(staff, 'staff');
  let org;

  await step('sign in', async () => {
    org = await login(staff);
  });

  const connectPage = async ({ shotName, via } = {}) => {
    await (via ?? staff.getByRole('button', { name: 'Facebook page & Instagram' })).click();
    await staff.waitForURL(/\/app\/connect\/meta\?org=[a-f0-9]{24}&session=/, { timeout: 15_000 });
    const pages = staff.getByRole('list', { name: 'Facebook pages' });
    const row = pages.getByRole('listitem').filter({ hasText: PAGE.name });
    await row.getByText(`Instagram: @${IG.username}`).waitFor();
    await pages.getByRole('listitem').filter({ hasText: 'Sellora Demo Outlet' }).waitFor();
    for (const which of ['Messenger', 'Instagram']) {
      const box = row.getByRole('checkbox', { name: `${which} for ${PAGE.name}` });
      if ((await box.getAttribute('aria-checked')) !== 'true') await box.click();
    }
    if (shotName) await shot(staff, shotName, true);
    await row.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    await row.getByText(`Connected: ${PAGE.name} and @${IG.username}`).waitFor();
  };

  await step('connect a Facebook page and its Instagram account', async () => {
    await staff.goto(`${BASE}${org}/settings/channels`);
    const fb = staff.getByRole('button', { name: 'Facebook page & Instagram' });
    await fb.waitFor();
    // Enabled once the platform's Meta settings have loaded.
    for (let i = 0; i < 50 && (await fb.isDisabled()); i++) await staff.waitForTimeout(200);
    if (await fb.isDisabled()) throw new Error('Meta channels are switched off on this platform');
    await shot(staff, '01-channels-before');
    await connectPage({ shotName: '02-page-chooser' });
    await shot(staff, '03-page-connected');
    await staff.getByRole('link', { name: 'Done' }).click();
    await staff.waitForURL(/\/settings\/channels$/);
    await staff.getByText(`Messenger · Facebook page · ${PAGE.name}`).first().waitFor();
    await staff
      .getByText(`Instagram · @${IG.username}`)
      .or(staff.getByText(`@${IG.username}`))
      .first()
      .waitFor();
  });

  await step('connect WhatsApp with a system user token', async () => {
    await staff.getByRole('button', { name: 'WhatsApp', exact: true }).click();
    const dialog = staff.getByRole('dialog');
    await dialog.locator('#wa-phone').fill(WA.phoneNumberId);
    await dialog.locator('#wa-waba').fill(WA.wabaId);
    await dialog.locator('#wa-token').fill('stand-in-wa-system-user-token-0001');
    await shot(staff, '04-whatsapp-dialog');
    await dialog.getByRole('button', { name: 'Connect WhatsApp' }).click();
    await staff.getByText('Sellora Demo · +880 1711-000000 connected').waitFor();
    await dialog.waitFor({ state: 'hidden' });
    await shot(staff, '05-channels-connected', true);
  });

  await step('a webhook with the wrong signature is refused', async () => {
    const status = await webhook(hooks.message('page', PAGE.id, PSID, 'forged'), 'not-the-secret');
    if (status !== 401) throw new Error(`forged webhook answered ${status}, expected 401`);
  });

  await step('turn the AI sales agent on', async () => {
    await staff.goto(`${BASE}${org}/ai-agent`);
    const toggle = staff.getByRole('switch', { name: 'AI sales agent on' });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click();
      await staff.getByText('The AI sales agent is on.').waitFor();
    }
  });

  const list = staff.getByRole('list', { name: 'Conversations' });
  const thread = staff.getByRole('list', { name: 'Messages' });
  const open = async (name) => {
    await list
      .getByRole('button', { name: new RegExp(name) })
      .first()
      .click();
    await staff.getByRole('heading', { name }).first().waitFor();
  };
  const reply = async (text) => {
    await staff.fill('#composer', text);
    await staff.press('#composer', 'Enter');
    await thread.getByText(text).waitFor();
  };

  await step('a Messenger message arrives live, and the AI answers through Meta', async () => {
    await staff.goto(`${BASE}${org}/inbox`);
    await staff.getByRole('status').filter({ hasText: 'Live' }).waitFor({ timeout: 10_000 });
    await deliver(hooks.message('page', PAGE.id, PSID, 'Red kurti ache? M size'));
    const name = `Demo Customer ${tail(PSID)}`;
    await list.getByText(name).waitFor({ timeout: 10_000 });
    await open(name);
    await thread.getByText('Red kurti ache? M size').waitFor();
    const ai = await waitSent((m) => m.to === PSID, 'the AI reply on Messenger', 30_000);
    await thread.getByText(ai.text.split('\n')[0].slice(0, 40)).first().waitFor();
    await shot(staff, '06-messenger-ai-reply');
  });

  await step(
    'a staff reply reaches Messenger and shows “Seen” after the read receipt',
    async () => {
      await reply('Ji apu, M size ache. ৳1,200, delivery ৳60.');
      await waitSent((m) => m.to === PSID && m.text.startsWith('Ji apu'), 'the staff reply');
      await deliver(hooks.read(PAGE.id, PSID));
      await thread.getByText('Seen').last().waitFor({ timeout: 10_000 });
      await shot(staff, '07-messenger-seen');
    },
  );

  await step('a refused message says so, and Retry sends it', async () => {
    await failNextSend(100);
    await reply('Order confirm korben?');
    await thread.getByText(/Not delivered: Meta refused the message/).waitFor({ timeout: 15_000 });
    await shot(staff, '08-not-delivered');
    await thread.getByRole('button', { name: 'Retry' }).click();
    await waitSent((m) => m.to === PSID && m.text === 'Order confirm korben?', 'the retried reply');
    await thread.getByText(/Not delivered/).waitFor({ state: 'detached', timeout: 10_000 });
  });

  await step(
    'Instagram: a message, the AI’s answer, and a reply from the app pausing the AI',
    async () => {
      await deliver(hooks.message('instagram', IG.id, IGSID, 'Price koto?'));
      const name = `Insta Customer ${tail(IGSID)}`;
      await list.getByText(name).waitFor({ timeout: 10_000 });
      await open(name);
      await waitSent((m) => m.to === IGSID, 'the AI reply on Instagram', 30_000);
      await deliver(hooks.echo('instagram', IG.id, IGSID, 'Inbox e price dilam apu'));
      await thread.getByText('Inbox e price dilam apu').waitFor({ timeout: 10_000 });
      await thread.getByText('Sent from Instagram').first().waitFor();
      await thread
        .getByText('Someone replied from Instagram outside Sellora, so the AI paused.')
        .waitFor();
      const ai = staff.getByRole('switch', { name: 'AI replies in this conversation' });
      if ((await ai.getAttribute('aria-checked')) !== 'false') throw new Error('AI still on');
      await shot(staff, '09-instagram-echo');
    },
  );

  await step('WhatsApp: a message, a reply, and “Seen” from the status update', async () => {
    await deliver(
      hooks.whatsapp({
        contacts: [{ profile: { name: WA_NAME }, wa_id: WA_FROM }],
        messages: [
          {
            from: WA_FROM,
            id: `wamid.IN${run}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: 'Saree er chobi den' },
          },
        ],
      }),
    );
    await list.getByText(WA_NAME).first().waitFor({ timeout: 10_000 });
    await open(WA_NAME);
    // The AI answers first; the staff reply joins after it.
    await waitSent((m) => m.to === WA_FROM, 'the AI reply on WhatsApp', 30_000);
    await reply('Chobi pathacchi, ektu oppekkha korun.');
    const sent = await waitSent(
      (m) => m.to === WA_FROM && m.text.startsWith('Chobi pathacchi'),
      'the WhatsApp reply',
    );
    for (const status of ['delivered', 'read'])
      await deliver(
        hooks.whatsapp({
          statuses: [
            {
              id: sent.id,
              status,
              timestamp: String(Math.floor(Date.now() / 1000)),
              recipient_id: WA_FROM,
            },
          ],
        }),
      );
    await thread.getByText('Seen').last().waitFor({ timeout: 10_000 });
    await shot(staff, '10-whatsapp-seen');
  });

  await step('after 24 hours only notes are possible', async () => {
    const dayAgo = Date.now() - 25 * 3600_000;
    await deliver(hooks.message('page', PAGE.id, PSID_OLD, 'Gotokal message dilam', dayAgo));
    const name = `Demo Customer ${tail(PSID_OLD)}`;
    // Its last message is a day old, so it sorts below today's chats: find it by name.
    await staff.fill('#inbox-search', name);
    await list.getByText(name).waitFor({ timeout: 10_000 });
    await open(name);
    await staff.getByText('More than 24 hours have passed since').waitFor();
    await staff.fill('#inbox-search', '');
    if ((await staff.getByRole('radio', { name: 'Reply' }).count()) > 0)
      throw new Error('Reply still offered outside the 24-hour window');
    await staff.getByRole('radio', { name: 'Note' }).waitFor();
    await shot(staff, '11-reply-window-closed');
  });

  await step('a revoked token stops replies and asks for a reconnect', async () => {
    await open(`Demo Customer ${tail(PSID)}`);
    await failNextSend(190);
    await reply('Address ta den please');
    await staff
      .getByText(/Meta stopped accepting messages from this Messenger channel/)
      .waitFor({ timeout: 15_000 });
    await shot(staff, '12-needs-reconnect');
    await staff.getByRole('link', { name: 'Reconnect it' }).click();
    await staff.waitForURL(/\/settings\/channels$/);
    const stopped = staff.getByRole('alert').filter({ hasText: 'Replies are stopped' });
    await stopped.waitFor();
    await staff.getByText('Needs attention').first().waitFor();
    await shot(staff, '13-channel-needs-attention');
    await connectPage({ via: stopped.getByRole('button', { name: 'Reconnect' }) });
    await staff.getByRole('link', { name: 'Done' }).click();
    await staff.waitForURL(/\/settings\/channels$/);
    await staff.getByText('Replies are stopped').waitFor({ state: 'detached', timeout: 10_000 });
  });

  await step('after reconnecting, Retry sends the stopped reply', async () => {
    await staff.goto(`${BASE}${org}/inbox`);
    await open(`Demo Customer ${tail(PSID)}`);
    await thread.getByRole('button', { name: 'Retry' }).click();
    await waitSent((m) => m.to === PSID && m.text === 'Address ta den please', 'the retried reply');
    await thread.getByText(/Not delivered/).waitFor({ state: 'detached', timeout: 10_000 });
  });

  await step('channels on a phone, and in dark mode', async () => {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      storageState: await ctx.storageState(),
    });
    const p = await phone.newPage();
    watch(p, 'phone');
    await p.goto(`${BASE}${org}/settings/channels`);
    await p.getByText(PAGE.name).first().waitFor();
    await shot(p, '14-channels-phone', true);
    await phone.close();
    await staff.emulateMedia({ colorScheme: 'dark' });
    await staff.goto(`${BASE}${org}/settings/channels`);
    await staff.getByText(PAGE.name).first().waitFor();
    await shot(staff, '15-channels-dark');
    await staff.emulateMedia({ colorScheme: 'light' });
  });

  await step('turn the AI sales agent off again', async () => {
    await staff.goto(`${BASE}${org}/ai-agent`);
    await staff.getByRole('switch', { name: 'AI sales agent on' }).click();
    await staff.getByText('The AI sales agent is off.').waitFor();
  });
} catch {
  failed = true;
  await staff?.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? ` (${s.ms} ms)` : `: ${s.error}`}`);
if (problems.length) {
  console.log('\nProblems seen:');
  for (const p of problems) console.log(`  - ${p}`);
}
const passed = steps.filter((s) => s.ok).length;
console.log(
  `\n${passed}/${steps.length} steps passed${problems.length ? `, ${problems.length} problems` : ''}`,
);
process.exit(failed || problems.length ? 1 : 0);
