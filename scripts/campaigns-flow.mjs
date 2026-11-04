/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through SMS campaigns and automations in a real browser, against a running web app,
 * API, worker and storefront whose SMS goes to the SMS stand-in (sellora-api/scripts/
 * sms-stand-in.mjs). It is NOT a test against an SMS gateway: the stand-in answers in
 * BulkSMSBD's shapes and keeps what "arrived" instead of reaching phones.
 *
 * What it checks: Marketing › Campaigns; a new campaign to three tagged customers (one asked
 * to stop) shows "2 get the text" while choosing; a placeholder the campaign cannot use is
 * refused while typing; picking a product adds {link}; the preview, length and price show; a
 * test text arrives with a real short link; scheduling for tomorrow, then cancelling; the copy
 * is sent now, the worker sends it in a batch, and only the two reachable numbers get it; a
 * customer opens the short link on a phone, lands on the product and orders; the report counts
 * the click and the order; Automations: the thank-you after delivery gets a store link and is
 * switched on, the language switch swaps the default texts, and delivering the customer's
 * order plans the thank-you. Fails on console errors, unexpected API errors or a missing
 * result.
 *
 * Needs: the live store from stores-flow (Nakshi Ghor, shop@demo.sellora.test), Sellora SMS
 * ready for that business (sms-flow leaves it so), the SMS stand-in, platform admin details
 * (to top up wallet cash if low), and a time between 9 AM and 9 PM in the business's time zone
 * (campaigns only go out then).
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/campaigns-flow.mjs
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
const OUT = env.SMOKE_OUT ?? 'smoke-output/campaigns';
mkdirSync(OUT, { recursive: true });

const run = String(Date.now()).slice(-6);
const TAG = `eid-check-${run}`;
const NAME = `Eid gamchha offer ${run}`;
const phone = (n) => `018${run}${String(n).padStart(2, '0')}`;
const msisdn = (local) => `88${local}`;
const CUSTOMERS = [
  { name: 'Shirin Akter', phone: phone(1) },
  { name: 'Rafiq Islam', phone: phone(2) },
  { name: 'Nusrat Jahan', phone: phone(3), optOut: true },
];

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

function watch(page, label) {
  page.on('console', (m) => {
    // 401: the sign-in pages ask who is signed in before anyone is.
    if (m.type() === 'error' && !/status of 401/.test(m.text()))
      problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    const path = new URL(r.url()).pathname;
    if (
      s >= 500 ||
      (s >= 400 && s !== 401 && (path.startsWith('/v1/') || path.startsWith('/api/')))
    )
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

async function until(probe, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
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

function hourIn(timeZone) {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone })
        .formatToParts(new Date())
        .find((p) => p.type === 'hour').value,
    ) % 24
  );
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
let store;
let options;
let first;
let copy;
let campaignSms;
let order;

const campaignsUrl = () => `${BASE}${org}/marketing/campaigns`;

try {
  await step('sign in (business and super-admin), add three tagged customers', async () => {
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

    const stores = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = stores.items.find((s) => s.status === 'live');
    check(store, 'the business needs a live store (run stores-flow first)');
    options = await call(page, 'GET', `/orgs/${orgId}/campaigns/options`);
    check(options.sms.ready, `SMS is not ready (run sms-flow first): ${options.sms.message}`);
    const hour = hourIn(options.timezone);
    check(
      hour >= options.sendWindow.startHour && hour < options.sendWindow.endHour - 1,
      `campaigns go out ${options.sendWindow.startHour}:00–${options.sendWindow.endHour}:00 in ${options.timezone}; it is ${hour}:00 there now`,
    );
    // The stand-in forgets on restart which sender names its "provider" registered.
    const sms = await call(page, 'GET', `/orgs/${orgId}/sms`);
    if (sms.senderName?.status === 'approved')
      await standIn('/__senders', { name: sms.senderName.name });

    // Earlier runs: automations off with the default English texts and no link.
    await call(page, 'PATCH', `/orgs/${orgId}/automations`, { language: 'en' });
    const a = await call(page, 'GET', `/orgs/${orgId}/automations`);
    await call(page, 'PATCH', `/orgs/${orgId}/automations`, {
      after_delivery: {
        enabled: false,
        days: 3,
        link: { kind: 'none' },
        text: a.after_delivery.defaultText,
      },
      win_back: { enabled: false, link: { kind: 'none' }, text: a.win_back.defaultText },
    });
    check(a.included, 'automations are not in the plan');

    // Sellora SMS is paid from wallet cash.
    const w = await call(page, 'GET', `/orgs/${orgId}/billing/wallet`);
    const wallet = w.wallet ?? w;
    if ((wallet.withdrawableMinor ?? 0) < 10_000)
      await call(admin, 'POST', `/platform/billing/tenants/${orgId}/wallet/adjust`, {
        direction: 'credit',
        type: 'topup',
        amountMinor: 50_000,
        note: 'Campaign browser check: bank transfer received',
        idempotencyKey: `campaigns-flow-topup-${run}`,
      });

    for (const c of CUSTOMERS) {
      await call(page, 'POST', `/orgs/${orgId}/customers`, {
        name: c.name,
        phone: c.phone,
        tags: [TAG],
      });
      if (c.optOut) await call(page, 'POST', `/orgs/${orgId}/sms/opt-outs`, { phone: c.phone });
    }
  });

  await step('Marketing › Campaigns, a new campaign with "2 get the text"', async () => {
    await page.goto(campaignsUrl(), { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Marketing', level: 1 }).waitFor();
    await page.locator('a[aria-current=page]', { hasText: 'Campaigns' }).waitFor();
    await shot(page, '01-campaigns');
    await page.getByRole('link', { name: 'New campaign' }).first().click();
    await page.getByRole('heading', { name: 'New campaign', level: 1 }).waitFor();
    await page.fill('#campaign-name', NAME);
    await page
      .getByRole('radiogroup', { name: 'Which customers' })
      .getByRole('radio', { name: 'Everyone with a phone' })
      .click();
    await page
      .getByRole('group', { name: 'Customer tags' })
      .getByRole('button', { name: TAG })
      .click();
    const count = page.getByTestId('audience-count');
    await count.getByText('2', { exact: true }).waitFor({ timeout: 15_000 });
    await count.getByText(/3 customers match · 1 asked to stop/).waitFor();
  });

  await step(
    'the text: a wrong placeholder is refused, picking a product adds {link}',
    async () => {
      const text = page.locator('#campaign-text');
      await text.fill('Hi {name}, {price} off at {shop} this Eid.');
      await page.getByText('This message cannot use {price}').first().waitFor();
      await text.fill('Hi {name}, Eid offer at {shop}: handloom gamchha, 10% off this week.');
      await page
        .getByRole('radiogroup', { name: 'Where the link goes' })
        .getByRole('radio', { name: 'Product' })
        .click();
      await page.fill('#campaign-link-product', 'Gamchha');
      await page.getByRole('button', { name: 'Handloom Gamchha' }).click();
      await page.getByText('Goes to').getByText('Handloom Gamchha').waitFor();
      const value = await text.inputValue();
      check(value.endsWith(' {link}'), `{link} was not added: ${value}`);
      const preview = page.getByTestId('campaign-text-preview');
      await preview.getByText(/^Hi Rahim, Eid offer at /).waitFor();
      const shown = await preview.innerText();
      check(shown.includes('/c/Ab12Cd34'), `no sample short link in ${shown}`);
      check(/Stop: |বন্ধ/.test(shown), `no stop link in ${shown}`);
      await page
        .getByTestId('campaign-estimate')
        .getByText(/^About /)
        .waitFor();
      await shot(page, '02-new-campaign', true);
    },
  );

  await step('a test text arrives with the real short link', async () => {
    await page.fill('#campaign-test-to', phone(9));
    await page.getByRole('button', { name: 'Send test' }).click();
    await page.waitForURL(/\/marketing\/campaigns\/[a-f0-9]{24}$/, { timeout: 15_000 });
    const sms = await until(async () => (await inbox(phone(9)))[0], 'the test text', 30_000);
    check(/\/c\/[A-Za-z0-9]{8}/.test(sms.text), `no short link in ${sms.text}`);
    check(sms.text.startsWith('Hi '), `unexpected test text ${sms.text}`);
    first = new URL(page.url()).pathname.split('/').pop();
    await page.getByText(`${options.maxTests - 1} of ${options.maxTests} tests left`).waitFor();
  });

  await step('schedule it for tomorrow at 10 AM, then cancel it', async () => {
    await page
      .getByRole('radiogroup', { name: 'When to send' })
      .getByRole('radio', { name: 'Schedule' })
      .click();
    await page.selectOption('#campaign-time', '10:00');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(/Send to 2 customers on /).waitFor();
    await dialog.getByRole('button', { name: 'Schedule' }).click();
    await page
      .getByText(/^Scheduled for /)
      .first()
      .waitFor({ timeout: 15_000 });
    const c = await call(page, 'GET', `/orgs/${orgId}/campaigns/${first}`);
    check(c.status === 'scheduled', `status is ${c.status}`);
    await shot(page, '03-scheduled');
    await page.getByRole('button', { name: 'Cancel campaign' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel campaign' }).click();
    await page
      .getByRole('heading', { level: 1 })
      .getByText('Cancelled')
      .waitFor({ timeout: 15_000 });
  });

  await step('the copy is sent now, and only the two reachable numbers get it', async () => {
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.waitForURL((u) => u.pathname.split('/').pop() !== first, { timeout: 15_000 });
    await page.getByRole('heading', { level: 1 }).getByText(`${NAME} (copy)`).waitFor();
    copy = new URL(page.url()).pathname.split('/').pop();
    await page.getByTestId('audience-count').getByText('2', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send now' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Send to 2 customers now?').waitFor();
    await dialog.getByRole('button', { name: 'Send now' }).click();
    await page
      .getByRole('heading', { level: 1 })
      .getByText(/Sending|Sent/)
      .waitFor({
        timeout: 15_000,
      });
    campaignSms = await until(
      async () => (await inbox(phone(1)))[0],
      'the campaign text for the first customer',
      90_000,
    );
    await until(async () => (await inbox(phone(2)))[0], 'the campaign text for the second', 30_000);
    check((await inbox(phone(3))).length === 0, 'the number that asked to stop got the text');
    check(campaignSms.text.startsWith('Hi Shirin Akter, Eid offer'), campaignSms.text);
    await until(
      async () => (await call(page, 'GET', `/orgs/${orgId}/campaigns/${copy}`)).status === 'sent',
      'the campaign to finish',
      90_000,
    );
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1 }).getByText('Sent').waitFor();
    const stats = page.getByTestId('campaign-stats');
    await stats.getByText('1 asked to stop').waitFor();
    const recipients = page.getByTestId('campaign-recipients');
    await recipients.getByText('Skipped: Asked to stop').waitFor();
    await shot(page, '04-report-sent', true);
  });

  await step('a customer opens the short link on a phone and orders the product', async () => {
    const link = campaignSms.text.match(/https?:\/\/\S+\/c\/[A-Za-z0-9]{8}/)[0];
    const shopper = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const p = await shopper.newPage();
    watch(p, 'customer');
    await p.goto(link, { waitUntil: 'networkidle' });
    check(/\/products\//.test(new URL(p.url()).pathname), `the link went to ${p.url()}`);
    check(
      new URL(p.url()).searchParams.get('utm_source') === 'sms',
      `no campaign tag in ${p.url()}`,
    );
    await p.getByRole('heading', { name: 'Handloom Gamchha' }).waitFor();
    await shot(p, '05-phone-product');
    await p.getByRole('button', { name: 'Add to cart' }).click();
    await p.goto(`${store.url}/checkout`, { waitUntil: 'networkidle' });
    await p.getByLabel('Full name').fill('Shirin Akter');
    await p.getByLabel('Mobile number').fill(phone(1));
    await p.getByLabel('House, road, village').fill('House 4, Road 2, Mirpur 10');
    await p.getByLabel('City').fill('Dhaka');
    await p.getByLabel('Inside Dhaka').check();
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkout'),
      p.getByRole('button', { name: /Place order/ }).click(),
    ]);
    check(placed.status() === 201, `checkout answered ${placed.status()}`);
    order = await placed.json();
    check(order.orderNumber, 'no order number');
    await p.getByRole('heading', { name: 'Thank you for your order!' }).waitFor();
    await shopper.close();
  });

  await step('the report counts the click and the order', async () => {
    await until(
      async () => {
        const c = await call(page, 'GET', `/orgs/${orgId}/campaigns/${copy}`);
        return c.link.clicks >= 1 && c.orders.count === 1;
      },
      'the click and the order on the campaign',
      30_000,
    );
    await page.reload({ waitUntil: 'networkidle' });
    const stats = page.getByTestId('campaign-stats');
    await stats.getByText('Orders after').waitFor();
    await page.getByTestId('campaign-recipients').getByText(order.orderNumber).waitFor();
    await page.goto(campaignsUrl(), { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: `${NAME} (copy)` }).waitFor();
    await shot(page, '06-campaigns-list');
  });

  await step('Automations: a store link for the thank-you, switched on', async () => {
    await page.getByRole('link', { name: 'Automations' }).click();
    await page.locator('a[aria-current=page]', { hasText: 'Automations' }).waitFor();
    const card = page.getByTestId('automation-after-delivery');
    await card.getByText('Thank you after delivery').waitFor();
    await page.selectOption('#after-delivery-days', '5');
    await card
      .getByRole('radiogroup', { name: 'Where the link goes' })
      .getByRole('radio', { name: 'Store' })
      .click();
    const text = await page.locator('#after-delivery-text').inputValue();
    check(text.endsWith('{link}'), `{link} was not added: ${text}`);
    await card
      .getByTestId('after-delivery-text-preview')
      .getByText(/\/c\/Ab12Cd34/)
      .waitFor();
    await card.getByRole('button', { name: 'Save' }).click();
    await card.getByText('Unsaved changes').waitFor({ state: 'detached' });
    await card.getByRole('switch').click();
    await card.getByText('On', { exact: true }).waitFor();
    const a = await call(page, 'GET', `/orgs/${orgId}/automations`);
    check(a.after_delivery.enabled && a.after_delivery.days === 5, 'not saved as on, 5 days');
    check(a.after_delivery.link.kind === 'store', `link is ${a.after_delivery.link.kind}`);
  });

  await step('the language switch swaps the default texts, not the business’s own', async () => {
    await page
      .getByRole('radiogroup', { name: 'Language of the default texts' })
      .getByRole('radio', { name: 'বাংলা' })
      .click();
    const winBack = page.locator('#win-back-text');
    await until(async () => /[ঀ-৿]/.test(await winBack.inputValue()), 'a Bangla win-back text');
    const after = await page.locator('#after-delivery-text').inputValue();
    check(after.endsWith('{link}') && !/[ঀ-৿]/.test(after), `own text changed: ${after}`);
    await shot(page, '07-automations-bangla', true);
    await page
      .getByRole('radiogroup', { name: 'Language of the default texts' })
      .getByRole('radio', { name: 'English' })
      .click();
    await until(async () => !/[ঀ-৿]/.test(await winBack.inputValue()), 'English again');
  });

  await step('delivering the customer’s order plans the thank-you', async () => {
    // Search treats digits as a phone number, so look the order up in the newest ones.
    const orders = await call(page, 'GET', `/orgs/${orgId}/orders?limit=50`);
    const o = orders.items.find((x) => x.number === order.orderNumber);
    check(o, `order ${order.orderNumber} not found`);
    for (const status of ['confirmed', 'shipped', 'delivered'])
      await call(page, 'POST', `/orgs/${orgId}/orders/${o.id}/status`, { status });
    await until(
      async () => {
        const s = await call(page, 'GET', `/orgs/${orgId}/automations/sends?kind=after_delivery`);
        return s.items.find((x) => x.orderNumber === order.orderNumber && x.status === 'pending');
      },
      'the planned thank-you',
      20_000,
    );
    await page.reload({ waitUntil: 'networkidle' });
    const sends = page.getByTestId('automation-sends');
    const row = sends.getByRole('row').filter({ hasText: order.orderNumber });
    await row.getByText('Planned').waitFor();
    await shot(page, '08-automations', true);
  });
} catch (err) {
  failed = true;
  console.error(String(err));
  await shot(page, 'zz-failure', true).catch(() => undefined);
} finally {
  // Leave the automations off, so other flows and the demo start quiet.
  if (orgId)
    await call(page, 'PATCH', `/orgs/${orgId}/automations`, {
      after_delivery: { enabled: false },
      win_back: { enabled: false },
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
