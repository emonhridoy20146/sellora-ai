/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through SMS in a real browser, against a running web app, API and worker whose SMS
 * addresses point at the SMS stand-in (sellora-api/scripts/sms-stand-in.mjs). It is NOT a
 * test against BulkSMSBD or Alpha SMS: the stand-in answers in their API shapes and keeps
 * what "arrived" in an inbox instead of reaching phones.
 *
 * What it checks: the super-admin connects Sellora's BulkSMSBD account (a wrong key refused
 * first), switches Sellora SMS on, sets prices and costs and sends a platform test; the
 * business chooses Sellora SMS, edits the "Order confirmed" text with its live preview, sends
 * a test and gets the order message for a new order on the order page; a sender name is
 * asked for, approved by the super-admin and used; a lost provider answer shows as Unknown
 * and is not charged; a number is stopped and allowed again; the admin revenue report and
 * per-business daily limit. Fails on console errors, unexpected API errors or a missing
 * result. Needs platform admin details. Creates real data in the signed-in business.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/sms-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SMS_STAND_IN_URL (http://127.0.0.1:4060).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const STAND_IN = (env.SMS_STAND_IN_URL ?? 'http://127.0.0.1:4060').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/sms';
mkdirSync(OUT, { recursive: true });

// The stand-in's demo account.
const BULK_KEY = 'demo-bulksmsbd-key';
const SHARED_SENDER = '8809617000000';
const SENDER_NAME = 'NakshiGhor';

const run = String(Date.now()).slice(-6);
const phone = (n) => `017${run}${String(n).padStart(2, '0')}`;
const msisdn = (local) => `88${local}`;

const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

function totp(secretBase32, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretBase32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// Responses the flow causes on purpose (a refused key), and the console lines for them.
const expected = [];
let consoleAllowance = 0;
function expect422(path) {
  expected.push({ status: 422, path });
  consoleAllowance += 1;
}
function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/status of 422/.test(text) && consoleAllowance > 0) {
      consoleAllowance -= 1;
      return;
    }
    problems.push(`${label} console: ${text.slice(0, 200)}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (!(s >= 500 || (s >= 400 && s !== 401 && r.url().includes('/v1/')))) return;
    const path = new URL(r.url()).pathname;
    const i = expected.findIndex((e) => e.status === s && e.path.test(path));
    if (i >= 0) expected.splice(i, 1);
    else problems.push(`${label} ${s} ${r.request().method()} ${path}`);
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

/** Calls the API from inside a signed-in page (cookies and the realm's CSRF header). */
async function call(page, method, path, body) {
  const r = await page.evaluate(
    async ({ method, path, body }) => {
      const name = location.pathname.startsWith('/admin') ? 'slp_csrf=' : 'sl_csrf=';
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

async function until(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function standIn(path, body) {
  const res = await fetch(`${STAND_IN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stand-in ${path} answered ${res.status}`);
  return res.json();
}

/** Messages the stand-in received for a local number, oldest first. */
async function inbox(local) {
  const all = await standIn('/__messages');
  return all.filter((m) => m.to === msisdn(local)).reverse();
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await actx.newPage();
watch(page, 'merchant');
watch(admin, 'admin');
let failed = false;
let org;
let orgId;
let lastSms;

async function newOrder(name, n) {
  const products = await call(page, 'GET', `/orgs/${orgId}/products?status=active&limit=50`);
  const product = products.items.find((p) => p.variants.length > 0);
  if (!product) throw new Error('the demo business needs an active product');
  const variant =
    product.variants.find((v) => !v.trackStock || v.stock >= 5) ?? product.variants[0];
  if (variant.trackStock && variant.stock < 5)
    await call(page, 'POST', `/orgs/${orgId}/products/${product.id}/stock`, {
      variantId: variant.id,
      mode: 'add',
      quantity: 50,
      reason: 'received',
      note: 'SMS browser check',
    });
  return call(page, 'POST', `/orgs/${orgId}/orders`, {
    customer: { name, phone: phone(n) },
    shippingAddress: { line1: `House ${n}, Road 4`, area: 'Dhanmondi', city: 'Dhaka' },
    items: [{ productId: product.id, variantId: variant.id, quantity: 1 }],
    status: 'confirmed',
  });
}

async function switchOn(sw) {
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
}

async function smsSettings() {
  await page.goto(`${BASE}${org}/settings/sms`, { waitUntil: 'networkidle' });
  await page.getByText('How SMS go out').first().waitFor();
}

try {
  await step('sign in as the super-admin and the business', async () => {
    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    await admin.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
    await admin.click('button[type=submit]');
    await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });

    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();

    // Start from scratch so the run is repeatable: SMS off, no sender name, no platform account.
    const s = await call(page, 'GET', `/orgs/${orgId}/sms`);
    if (s.senderName) await call(page, 'DELETE', `/orgs/${orgId}/sms/sender-name`);
    if (s.mode !== 'off') await call(page, 'PATCH', `/orgs/${orgId}/sms`, { mode: 'off' });
    const o = await call(admin, 'GET', '/platform/sms');
    if (o.platform.provider) await call(admin, 'DELETE', '/platform/sms/gateway');
    await call(admin, 'PATCH', '/platform/sms', { prices: [], costs: [] });
    await standIn('/__reset', {});
  });

  await step('super-admin connects BulkSMSBD after a wrong key is refused', async () => {
    await admin.goto(`${BASE}/admin/sms`, { waitUntil: 'networkidle' });
    await admin.getByText('No SMS account connected').waitFor();
    await shot(admin, '01-admin-sms-empty');
    await admin.getByRole('button', { name: 'Connect an account' }).click();
    const dialog = admin.getByRole('dialog');
    await dialog.locator('#sg-provider').selectOption('bulksmsbd');
    await dialog.locator('#sg-apiKey').fill('wrong-key');
    await dialog.locator('#sg-sender').fill(SHARED_SENDER);
    expect422(/^\/v1\/platform\/sms\/gateway$/);
    await dialog.getByRole('button', { name: 'Check and connect' }).click();
    await dialog
      .getByText(/BulkSMSBD/)
      .nth(1)
      .waitFor();
    await shot(admin, '02-admin-wrong-key');
    await dialog.locator('#sg-apiKey').fill(BULK_KEY);
    await dialog.getByRole('button', { name: 'Check and connect' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 15_000 });
    await admin
      .getByText(/Balance ৳/)
      .first()
      .waitFor();
  });

  await step('super-admin switches Sellora SMS on and sets prices and costs', async () => {
    await admin.getByRole('switch', { name: 'Offer Sellora SMS to businesses' }).click();
    await admin.getByText('Businesses can choose Sellora SMS.', { exact: false }).waitFor();
    await admin.fill('#sp-p-0', '0.50');
    await admin.fill('#sp-c-0', '0.30');
    await admin.fill('#sp-sp-0', '0.70');
    await admin.fill('#sp-sc-0', '0.45');
    await admin.getByText('Shared sender: +৳0.20 per part (40%)').waitFor();
    await admin.getByRole('button', { name: 'Save prices' }).click();
    await admin.getByText('SMS prices saved.').waitFor();
    const o = await call(admin, 'GET', '/platform/sms');
    if (o.platform.prices[0]?.perPartMinor !== 50 || o.platform.costs[0]?.perPartMinor !== 30)
      throw new Error(`prices not saved: ${JSON.stringify(o.platform)}`);
  });

  await step('super-admin sends a platform test', async () => {
    await admin.fill('#pst-to', phone(1));
    await admin.getByRole('button', { name: 'Send test' }).click();
    await admin.getByText(/BulkSMSBD accepted it/).waitFor({ timeout: 15_000 });
    const got = await until(async () => (await inbox(phone(1)))[0], 'the platform test SMS');
    if (got.from !== SHARED_SENDER) throw new Error(`test came from ${got.from}`);
    await shot(admin, '03-admin-sms-connected', true);
  });

  await step('business tops up wallet cash if needed', async () => {
    const w = await call(page, 'GET', `/orgs/${orgId}/billing/wallet`);
    const wallet = w.wallet ?? w;
    if ((wallet.withdrawableMinor ?? 0) < 10_000)
      await call(admin, 'POST', `/platform/billing/tenants/${orgId}/wallet/adjust`, {
        direction: 'credit',
        type: 'topup',
        amountMinor: 50_000,
        note: 'SMS browser check: bank transfer received',
        idempotencyKey: `sms-flow-topup-${run}`,
      });
  });

  await step('business chooses Sellora SMS and writes the "Order confirmed" text', async () => {
    await smsSettings();
    await shot(page, '04-settings-sms-off');
    await page.getByRole('radio', { name: /Sellora SMS/ }).click();
    await page.getByText('Messages now go out through Sellora SMS.').waitFor();
    await page.getByText(/Each SMS part costs ৳0.5/).waitFor();

    await switchOn(page.getByRole('switch', { name: 'Send “Order confirmed”' }));
    const text = page.locator('#sms-t-order_confirmed');
    await text.fill('Hi {name}, your order {order} of {total} is confirmed. Thanks, {shop}!');
    await page
      .getByText(/your order .* is confirmed\. Thanks, /)
      .first()
      .waitFor();
    await switchOn(page.getByRole('switch', { name: 'Send “Order shipped”' }));
    await page.getByRole('button', { name: 'Save messages' }).click();
    await page.getByText('Order messages saved.').waitFor();
    await page.locator('#sms-t-order_confirmed').scrollIntoViewIfNeeded();
    await shot(page, '05-settings-order-texts');
  });

  await step('business sends a test and it arrives, charged from wallet cash', async () => {
    await page.fill('#sms-test-to', phone(2));
    await page.getByRole('button', { name: 'Send test' }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /Sent|Delivered/ })
      .first()
      .waitFor({
        timeout: 15_000,
      });
    const got = await until(async () => (await inbox(phone(2)))[0], 'the business test SMS');
    if (got.from !== SHARED_SENDER) throw new Error(`test came from ${got.from}`);
    const list = await call(page, 'GET', `/orgs/${orgId}/sms/messages?purpose=test&limit=1`);
    if (list.items[0]?.priceMinor !== 50)
      throw new Error(`test charged ${list.items[0]?.priceMinor}`);
    await shot(page, '06-settings-test-sent');
  });

  await step('a new order gets the "Order confirmed" SMS, shown on the order page', async () => {
    const o = await newOrder('Rina Akter', 3);
    const got = await until(async () => (await inbox(phone(3)))[0], 'the order SMS', 30_000);
    if (!got.text.includes(o.number) || !got.text.includes('Rina'))
      throw new Error(`order SMS text: ${got.text}`);
    lastSms = got;
    await page.goto(`${BASE}${org}/orders/${o.id}`, { waitUntil: 'networkidle' });
    const card = page.getByText('SMS to the customer');
    await until(async () => {
      if (await card.isVisible()) return true;
      await page.reload({ waitUntil: 'networkidle' });
      return false;
    }, 'the SMS card on the order page');
    await page.getByText(got.text.slice(0, 30)).first().waitFor();
    await shot(page, '07-order-page-sms');
  });

  await step('a sender name is asked for, approved by the super-admin and used', async () => {
    await smsSettings();
    await page.fill('#sms-sender-name', SENDER_NAME);
    await page.getByRole('button', { name: 'Send for approval' }).click();
    await page.getByText('Waiting for approval').waitFor();

    // The provider registers the name (its paperwork), then the super-admin approves it.
    await standIn('/__senders', { name: SENDER_NAME });
    await admin.goto(`${BASE}/admin/sms`, { waitUntil: 'networkidle' });
    const row = admin.getByRole('row').filter({ hasText: SENDER_NAME });
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    await shot(admin, '08-admin-sender-name-waiting');
    await row.getByRole('button', { name: 'Approve' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await admin.getByText(`${SENDER_NAME} approved.`, { exact: false }).waitFor();

    await smsSettings();
    await page.getByText(`Send from ${SENDER_NAME}`).click();
    await page
      .getByText(new RegExp(`from ${SENDER_NAME}`))
      .first()
      .waitFor();
    await page.fill('#sms-test-to', phone(4));
    await page.getByRole('button', { name: 'Send test' }).click();
    const got = await until(async () => (await inbox(phone(4)))[0], 'the sender-name SMS');
    if (got.from !== SENDER_NAME) throw new Error(`sent from ${got.from}, not ${SENDER_NAME}`);
    const list = await call(page, 'GET', `/orgs/${orgId}/sms/messages?purpose=test&limit=1`);
    if (list.items[0]?.priceMinor !== 70)
      throw new Error(`sender-name test charged ${list.items[0]?.priceMinor}`);
    await page.getByText('Sender name', { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(page, '09-settings-sender-name');
  });

  await step('a lost provider answer shows as Unknown and is not charged', async () => {
    const wallet = async () => {
      const w = await call(page, 'GET', `/orgs/${orgId}/billing/wallet`);
      return w.wallet ?? w;
    };
    const before = await wallet();
    await standIn('/__fail', { fault: 'lose-reply' });
    await page.fill('#sms-test-to', phone(5));
    await page.getByRole('button', { name: 'Send test' }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /Unknown/ })
      .first()
      .waitFor({
        timeout: 20_000,
      });
    // The stand-in did send it before dropping the connection, like a real lost answer.
    await until(async () => (await inbox(phone(5)))[0], 'the message behind the lost answer');
    const list = await call(page, 'GET', `/orgs/${orgId}/sms/messages?purpose=test&limit=1`);
    const m = list.items[0];
    if (m?.status !== 'unknown' || m.failure !== 'uncertain')
      throw new Error(`lost answer recorded as ${m?.status}/${m?.failure}`);
    const after = await wallet();
    if (after.balanceMinor !== before.balanceMinor || after.heldMinor !== before.heldMinor)
      throw new Error(
        `wallet moved: ${before.balanceMinor}/${before.heldMinor} -> ${after.balanceMinor}/${after.heldMinor}`,
      );
    await page
      .getByRole('status')
      .filter({ hasText: /Unknown/ })
      .first()
      .scrollIntoViewIfNeeded();
    await shot(page, '10-settings-lost-answer');
  });

  await step('the message log, and a number stopped and allowed again', async () => {
    await smsSettings();
    await page.getByText('Messages', { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(page, '11-settings-message-log');
    await page.fill('#sms-stop', phone(6));
    await page.getByRole('button', { name: 'Stop marketing SMS' }).click();
    await page.getByText('That number gets no more marketing SMS.').waitFor();
    const local = `0${phone(6).slice(1)}`;
    await page.getByText(local).first().waitFor();
    await page.locator('#sms-stop').scrollIntoViewIfNeeded();
    await shot(page, '12-settings-opt-outs');
    await page.getByRole('button', { name: `Allow marketing SMS to ${local} again` }).click();
    await page.getByText('Marketing SMS allowed again for that number.').waitFor();
  });

  await step('the super-admin sees revenue, businesses and changes a daily limit', async () => {
    await admin.goto(`${BASE}/admin/sms`, { waitUntil: 'networkidle' });
    await admin.getByText('Sellora SMS revenue').scrollIntoViewIfNeeded();
    await admin.getByText('Paid by businesses').waitFor();
    await shot(admin, '13-admin-sms-revenue');
    const row = admin.getByRole('row').filter({ hasText: 'Nakshi Ghor' });
    await row.getByRole('button', { name: 'Change' }).click();
    const dialog = admin.getByRole('dialog');
    await dialog.getByRole('checkbox').click();
    await dialog.locator('#sms-limit').fill('250');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await admin.getByText('Daily limit saved.').waitFor();
    await row.getByText('250').waitFor();
    await row.scrollIntoViewIfNeeded();
    await shot(admin, '14-admin-sms-businesses');
    await row.getByRole('button', { name: 'Change' }).click();
    await dialog.getByRole('checkbox').click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await admin.getByText('Daily limit saved.').last().waitFor();
  });

  await step('stand-in inbox, phone width and dark mode', async () => {
    const inboxPage = await ctx.newPage();
    await inboxPage.goto(`${STAND_IN}/`);
    await inboxPage.getByText(lastSms.text.slice(0, 30)).first().waitFor();
    await shot(inboxPage, '15-stand-in-inbox');
    await inboxPage.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await smsSettings();
    await shot(page, '16-settings-sms-mobile');
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await smsSettings();
    await page.locator('#sms-t-order_confirmed').scrollIntoViewIfNeeded();
    await shot(page, '17-settings-sms-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });
} catch {
  failed = true;
  await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
  await admin.screenshot({ path: join(OUT, 'failure-admin.png'), fullPage: true }).catch(() => {});
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
