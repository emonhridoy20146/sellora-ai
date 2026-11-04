/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through abandoned cart reminders in a real browser, against a running web app, API,
 * worker and storefront whose SMS goes to the SMS stand-in (sellora-api/scripts/
 * sms-stand-in.mjs). It is NOT a test against an SMS gateway: the stand-in answers in
 * BulkSMSBD's shapes and keeps what "arrived" instead of reaching phones.
 *
 * What it checks: Marketing › Abandoned carts starts off; a reminder text without {link} is
 * refused while typing; the business writes its text, turns on a second reminder and switches
 * reminders on; a shopper types a phone number at the store checkout and another on a landing
 * page order form, and both carts are saved ("Still shopping"); the worker sends the first
 * reminder by itself once a cart is old enough, and staff send one by hand; the shopper opens
 * the link from the SMS and finds the same cart with their details, orders, and the cart shows
 * as Recovered with the order; the landing page link brings back the chosen offer; staff stop
 * reminders for the other cart. Fails on console errors, unexpected API errors or a missing
 * result.
 *
 * Waiting 30–60 minutes for a cart to count as left is not practical here, so the flow moves
 * two carts' "last change" back in MongoDB (connection from sellora-api/.env). Everything else
 * goes through the browser and the public API. The minute-by-minute timing rules are covered
 * by the API's tests (test/e2e/carts.e2e.ts) with a controlled clock.
 *
 * Needs: the live store from stores-flow (Nakshi Ghor, shop@demo.sellora.test), Sellora SMS
 * ready for that business (sms-flow leaves it so), the SMS stand-in, and platform admin
 * details (to approve the landing page and top up wallet cash if low).
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/carts-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SMS_STAND_IN_URL (http://127.0.0.1:4060),
 * SELLORA_API_DIR (../sellora-api).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const STAND_IN = (env.SMS_STAND_IN_URL ?? 'http://127.0.0.1:4060').replace(/\/+$/, '');
const API_DIR = resolve(env.SELLORA_API_DIR ?? '../sellora-api');
const OUT = env.SMOKE_OUT ?? 'smoke-output/carts';
mkdirSync(OUT, { recursive: true });

const SLUG = 'cart-check';
const FIRST_TEXT = 'Hi {name}, your {items} is waiting at {shop}. Finish your order: {link}';
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

/** The API's own database, only to move a cart's last change back in time. */
function apiEnv() {
  const out = {};
  for (const line of readFileSync(join(API_DIR, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const { MongoClient, ObjectId } = createRequire(join(API_DIR, 'package.json'))('mongodb');
const dbEnv = apiEnv();
const mongo = await MongoClient.connect(dbEnv.MONGODB_URI);
const carts = mongo.db(dbEnv.MONGODB_DB_NAME).collection('carts');

async function age(cartId, minutesAgo, nextInMinutes) {
  const now = Date.now();
  await carts.updateOne(
    { _id: new ObjectId(cartId) },
    {
      $set: {
        lastActivityAt: new Date(now - minutesAgo * 60_000),
        nextReminderAt: new Date(now + nextInMinutes * 60_000),
      },
    },
  );
}

/** Whether `hour` (0–23) in Dhaka falls in the default quiet hours (10 PM to 9 AM). */
function dhakaHour() {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Dhaka' })
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
let landing;
let storeCart;
let landingCart;
let storeSms;
let landingSms;
const placedOrders = [];

function phoneContext() {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
}

async function cartsPage() {
  await page.goto(`${BASE}${org}/marketing/carts`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Marketing', level: 1 }).waitFor();
  await page.locator('a[aria-current=page]', { hasText: 'Abandoned carts' }).waitFor();
}

async function showView(label) {
  await page
    .getByRole('navigation', { name: 'Cart views' })
    .getByRole('button', { name: label })
    .click();
}

async function findCart(local) {
  const list = await call(page, 'GET', `/orgs/${orgId}/carts?view=all&phone=${local}`);
  return list.items[0] ?? null;
}

try {
  await step('sign in (business and super-admin), start from reminders off', async () => {
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

    // Earlier runs: reminders off with the default texts, no open cart left waiting.
    const s = await call(page, 'GET', `/orgs/${orgId}/carts/settings`);
    check(s.sms.ready, `SMS is not ready for this business (run sms-flow first): ${s.sms.message}`);
    // The stand-in forgets on restart which sender names its "provider" registered.
    const sms = await call(page, 'GET', `/orgs/${orgId}/sms`);
    if (sms.senderName?.status === 'approved')
      await standIn('/__senders', { name: sms.senderName.name });
    await call(page, 'PATCH', `/orgs/${orgId}/carts/settings`, {
      enabled: false,
      language: 'en',
      steps: [
        { enabled: true, delayMinutes: 60, text: s.defaults.en[0] },
        { enabled: false, delayMinutes: 1440, text: s.defaults.en[1] },
      ],
      minTotalMinor: 0,
      quietHours: { enabled: true, startHour: 22, endHour: 9 },
    });
    for (;;) {
      const open = await call(page, 'GET', `/orgs/${orgId}/carts?view=all&limit=100`);
      const left = open.items.filter((c) => c.status === 'open');
      for (const c of left) await call(page, 'POST', `/orgs/${orgId}/carts/${c.id}/dismiss`);
      if (!left.length || !open.nextCursor) break;
    }

    // Sellora SMS is paid from wallet cash.
    const w = await call(page, 'GET', `/orgs/${orgId}/billing/wallet`);
    const wallet = w.wallet ?? w;
    if ((wallet.withdrawableMinor ?? 0) < 10_000)
      await call(admin, 'POST', `/platform/billing/tenants/${orgId}/wallet/adjust`, {
        direction: 'credit',
        type: 'topup',
        amountMinor: 50_000,
        note: 'Cart reminder browser check: bank transfer received',
        idempotencyKey: `carts-flow-topup-${run}`,
      });

    // A landing page for the second shopper.
    const pages = await call(page, 'GET', `/orgs/${orgId}/landing-pages?limit=100`);
    for (const p of pages.items.filter((x) => x.slug === SLUG)) {
      if (p.takedown) await call(admin, 'POST', `/platform/landing-pages/${p.id}/reinstate`);
      await call(page, 'DELETE', `/orgs/${orgId}/landing-pages/${p.id}`);
    }
    const products = await call(page, 'GET', `/orgs/${orgId}/products?q=Gamchha&status=active`);
    const gamchha = products.items.find((x) => x.name === 'Handloom Gamchha');
    check(gamchha, 'the demo gamchha is missing');
    const made = await call(page, 'POST', `/orgs/${orgId}/landing-pages`, {
      storeId: store.id,
      name: 'Gamchha cart check',
      slug: SLUG,
      productId: gamchha.id,
      template: 'quick_order',
      language: 'en',
    });
    const sent = await call(page, 'POST', `/orgs/${orgId}/landing-pages/${made.id}/submit`);
    if (sent.submission?.status === 'pending')
      await call(admin, 'POST', `/platform/landing-pages/${made.id}/approve`, {
        revision: sent.submission.revision,
      });
    landing = made;
  });

  await step('Marketing › Abandoned carts, reminders off', async () => {
    await page.goto(`${BASE}${org}`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Marketing' }).click();
    // Marketing opens on campaigns; cart reminders are the third tab.
    await page.waitForURL('**/marketing/campaigns');
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Abandoned carts' })
      .click();
    await page.waitForURL('**/marketing/carts');
    await page.getByRole('heading', { name: 'Marketing', level: 1 }).waitFor();
    await page.locator('a[aria-current=page]', { hasText: 'Abandoned carts' }).waitFor();
    const sw = page.getByRole('switch', { name: 'Send cart reminders' });
    check((await sw.getAttribute('aria-checked')) === 'false', 'reminders are not off');
    await page.getByText(/Sent with .* per SMS part, from your wallet cash/).waitFor();
    await shot(page, '01-carts-off', true);
  });

  await step('the editor refuses a reminder without {link}, then saves two reminders', async () => {
    const first = page.locator('#cart-step-1');
    await first.fill('Hi {name}, come back to {shop}');
    await page
      .getByText('Put {link} in the message, so the shopper can go back to the cart')
      .waitFor();
    check(
      await page.getByRole('button', { name: 'Save reminders' }).isDisabled(),
      'Save is not disabled for a text without {link}',
    );
    await first.fill(FIRST_TEXT);
    // The preview fills sample values and adds the stop link.
    await page
      .getByText(
        /Hi Rahim, your Red saree and 1 more is waiting at .*\. Finish your order: https?:\/\/.*\/r\/\w+ Stop: /,
      )
      .waitFor();

    const second = page.getByRole('switch', { name: 'Send the second reminder' });
    if ((await second.getAttribute('aria-checked')) !== 'true') await second.click();
    await page.locator('#cart-step-2-delay').selectOption('1440');
    // The default quiet hours are 10 PM to 9 AM in Dhaka; the automatic reminder must go now.
    const h = dhakaHour();
    if (h >= 22 || h < 9) await page.locator('#cart-quiet').click();
    await page.getByRole('button', { name: 'Save reminders' }).click();
    await page.getByText('Reminder settings saved.').waitFor();

    await page.getByRole('switch', { name: 'Send cart reminders' }).click();
    await page.getByText('Reminders are on. Carts left from now on get a text.').waitFor();
    const s = await call(page, 'GET', `/orgs/${orgId}/carts/settings`);
    check(s.enabled && s.steps[0].text === FIRST_TEXT, 'the first text was not saved');
    check(s.steps[1].enabled && s.steps[1].delayMinutes === 1440, 'the second step is not on');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '02-carts-settings', true);
  });

  await step('a shopper types a phone number at the store checkout and leaves', async () => {
    const shopper = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await shopper.newPage();
    watch(p, 'store shopper');
    await p.goto(`${store.url}/products/nakshi-kantha-throw`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Add to cart' }).click();
    await p.goto(`${store.url}/checkout`, { waitUntil: 'networkidle' });
    await p.getByLabel('Full name').fill('Farhana Rahman');
    const [saved] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === '/api/carts', { timeout: 15_000 }),
      p.getByLabel('Mobile number').fill(phone(1)),
    ]);
    check(saved.status() === 200, `saving the cart answered ${saved.status()}`);
    check((await saved.json()).saved === true, 'the cart was not saved');
    await p.waitForLoadState('networkidle');
    await p.getByText(/we may text this number a reminder/).waitFor();
    await shot(p, '03-store-checkout', true);
    await shopper.close();
  });

  await step(
    'another shopper fills the landing page order form on a phone and leaves',
    async () => {
      const c = await phoneContext();
      const p = await c.newPage();
      watch(p, 'landing shopper');
      await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
      await p.locator('#order').scrollIntoViewIfNeeded();
      await p.getByLabel('Full name').fill('Tanvir Ahmed');
      const [saved] = await Promise.all([
        p.waitForResponse((r) => new URL(r.url()).pathname === `/api/landing/${SLUG}/carts`, {
          timeout: 15_000,
        }),
        p.getByLabel('Mobile number').fill(phone(2)),
      ]);
      check(saved.status() === 200, `saving the landing cart answered ${saved.status()}`);
      await p.locator('#order').screenshot({ path: join(OUT, '04-landing-form.png') });
      await c.close();
    },
  );

  await step('both carts are saved and shown as still shopping', async () => {
    storeCart = await until(() => findCart(phone(1)), 'the store cart');
    landingCart = await until(() => findCart(phone(2)), 'the landing cart');
    check(
      storeCart.source === 'store' && storeCart.items[0].name === 'Nakshi Kantha Throw',
      'store cart items',
    );
    check(
      landingCart.source === 'landing_page' && landingCart.landingPage?.slug === SLUG,
      'landing cart',
    );
    await cartsPage();
    await page.getByText('No cart is waiting.', { exact: false }).waitFor();
    await showView('All');
    // Rows by phone: earlier runs left carts with the same names.
    await page
      .getByRole('row')
      .filter({ hasText: phone(1) })
      .getByText('Still shopping', { exact: true })
      .waitFor();
    await page
      .getByRole('row')
      .filter({ hasText: phone(2) })
      .getByText('Still shopping', { exact: true })
      .waitFor();
    await shot(page, '05-carts-shopping', true);
  });

  await step('an hour later the worker sends the first reminder by itself', async () => {
    // The store cart: last changed 65 minutes ago, due now. The landing cart: 35 minutes ago.
    await age(storeCart.id, 65, 0);
    await age(landingCart.id, 35, 25);
    storeSms = await until(
      async () => (await inbox(phone(1)))[0],
      'the automatic reminder',
      100_000,
    );
    check(
      storeSms.text.startsWith('Hi Farhana Rahman, your Nakshi Kantha Throw is waiting at'),
      `reminder text: ${storeSms.text}`,
    );
    check(
      /\/r\/[A-Za-z0-9]{10} Stop: http/.test(storeSms.text),
      `no cart or stop link: ${storeSms.text}`,
    );
    const c = await until(async () => {
      const x = await findCart(phone(1));
      return x.reminders.length ? x : null;
    }, 'the reminder on the cart');
    check(
      c.reminders[0].step === 1 && c.nextReminderAt,
      'step 1 not recorded or step 2 not planned',
    );
  });

  await step('staff send the landing cart its reminder by hand', async () => {
    await cartsPage();
    const row = page.getByRole('row').filter({ hasText: phone(2) });
    await row.getByText(/Next reminder in \d+ minutes/).waitFor();
    await page
      .getByRole('row')
      .filter({ hasText: phone(1) })
      .getByText('Reminded', { exact: true })
      .waitFor();
    await shot(page, '06-carts-left', true);
    await row.getByRole('button', { name: 'Send now' }).click();
    await page.getByText(`Reminder sent to ${phone(2)}.`).waitFor({ timeout: 15_000 });
    landingSms = await until(async () => (await inbox(phone(2)))[0], 'the reminder sent by hand');
    check(landingSms.text.includes(`/r/`), `no link in ${landingSms.text}`);
    await row.getByText('1 sent').waitFor();
  });

  await step('the shopper opens the link from the SMS and orders the same cart', async () => {
    const link = storeSms.text.match(/https?:\/\/\S+\/r\/[A-Za-z0-9]{10}/)[0];
    const shopper = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await shopper.newPage();
    watch(p, 'returning shopper');
    await p.goto(link);
    await p.waitForURL('**/checkout', { timeout: 15_000 });
    await p.getByText('Nakshi Kantha Throw').first().waitFor();
    check((await p.getByLabel('Full name').inputValue()) === 'Farhana Rahman', 'name not filled');
    check((await p.getByLabel('Mobile number').inputValue()) === phone(1), 'phone not filled');
    await shot(p, '07-restored-checkout', true);
    await p.getByLabel('House, road, village').fill('House 12, Road 5, Dhanmondi');
    await p.getByLabel('City').fill('Dhaka');
    await p.getByLabel('Inside Dhaka').check();
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkout'),
      p.getByRole('button', { name: /Place order/ }).click(),
    ]);
    check(placed.status() === 201, `checkout answered ${placed.status()}`);
    check((await placed.json()).orderNumber, 'no order number');
    await p.waitForURL('**/order?**', { timeout: 15_000 });
    await p.getByRole('heading', { name: 'Thank you for your order!' }).waitFor();
    await shopper.close();
  });

  await step('the cart shows as recovered, with its reminders and the order', async () => {
    const c = await until(async () => {
      const x = await findCart(phone(1));
      return x.status === 'ordered' ? x : null;
    }, 'the cart to be ordered');
    check(
      c.recovered && c.order && c.clicks >= 1,
      `not recovered: ${JSON.stringify(c).slice(0, 200)}`,
    );
    placedOrders.push(c.order.id);
    await cartsPage();
    await showView('Recovered');
    const row = page.getByRole('row').filter({ hasText: phone(1) });
    await row.getByText(`Order ${c.order.number}`).waitFor();
    await shot(page, '08-carts-recovered', true);
    await row.getByRole('button', { name: /Farhana Rahman/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Reminder 1').waitFor();
    await dialog.getByText(/came within 7 days of a reminder/).waitFor();
    await dialog.screenshot({ path: join(OUT, '09-cart-details.png') });
    await page.keyboard.press('Escape');
    const sm = await call(page, 'GET', `/orgs/${orgId}/carts/summary`);
    check(
      sm.recovered >= 1 && sm.reminded >= 2 && sm.smsSent >= 2,
      `summary: ${JSON.stringify(sm)}`,
    );
  });

  await step('the landing page link brings back the chosen offer and details', async () => {
    const link = landingSms.text.match(/https?:\/\/\S+\/r\/[A-Za-z0-9]{10}/)[0];
    const c = await phoneContext();
    const p = await c.newPage();
    watch(p, 'returning landing shopper');
    await p.goto(link);
    await p.waitForURL(`**/${SLUG}?cart=1**`, { timeout: 15_000 });
    await p.locator('#order').waitFor();
    await until(
      async () => (await p.getByLabel('Mobile number').inputValue()) === phone(2),
      'the phone filled in',
      10_000,
    );
    check((await p.getByLabel('Full name').inputValue()) === 'Tanvir Ahmed', 'name not filled');
    await p.locator('#order').screenshot({ path: join(OUT, '10-landing-restored.png') });
    await c.close();
  });

  await step('staff stop reminders for the landing cart', async () => {
    await cartsPage();
    const row = page.getByRole('row').filter({ hasText: phone(2) });
    await row.getByRole('button', { name: /More for the cart/ }).click();
    await page.getByRole('menuitem', { name: 'Stop reminders' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop reminders' }).click();
    await page.getByText('Reminders stopped for that cart.').waitFor();
    await showView('Stopped');
    await page
      .getByRole('row')
      .filter({ hasText: phone(2) })
      .getByText('Stopped', { exact: true })
      .waitFor();
    const c = await findCart(phone(2));
    check(c.status === 'dismissed' && c.nextReminderAt === null, 'still waiting for reminders');
    await shot(page, '11-carts-stopped', true);
  });
} catch (err) {
  failed = true;
  console.error(`\nStopped: ${String(err).split('\n')[0]}`);
  await shot(page, 'zz-failure', true).catch(() => {});
} finally {
  // The next run starts the same way: reminders off, the test order cancelled (stock back).
  if (orgId) {
    await call(page, 'PATCH', `/orgs/${orgId}/carts/settings`, { enabled: false }).catch((e) =>
      problems.push(`could not turn reminders off: ${String(e).slice(0, 120)}`),
    );
    for (const id of placedOrders)
      await call(page, 'POST', `/orgs/${orgId}/orders/${id}/cancel`, {
        reason: 'Browser check',
      }).catch((e) => problems.push(`could not cancel the test order: ${String(e).slice(0, 120)}`));
    if (landing)
      await call(page, 'DELETE', `/orgs/${orgId}/landing-pages/${landing.id}`).catch(() => {});
  }
  await browser.close();
  await mongo.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? ` (${s.ms} ms)` : `: ${s.error}`}`);
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`  ${p}`);
}
console.log(`\nScreenshots in ${OUT}/`);
process.exit(failed || problems.length ? 1 : 0);
