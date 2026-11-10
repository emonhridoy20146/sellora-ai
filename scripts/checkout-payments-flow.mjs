/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through payments at checkout (ADR 0029) in real browsers, against a running web app,
 * API, worker and storefront whose gateways point at the payment stand-in
 * (sellora-api/scripts/payment-stand-in.mjs). It is NOT a test against bKash, Nagad,
 * SSLCommerz, aamarPay or shurjoPay: the stand-in answers in their published API shapes and
 * shows its own Pay and Cancel page, and no money moves.
 *
 * What it checks: Settings › Payments starts empty; the business connects all five gateways
 * with their keys in test mode (wrong SSLCommerz keys are refused first); asks the delivery
 * charge as an advance on cash on delivery outside Dhaka; a shopper at the store checkout
 * pays that advance with bKash on the gateway's page and comes back to a receipt that says
 * so; a shopper on a phone chooses to pay everything with SSLCommerz, cancels on the
 * gateway's page, and pays from the receipt with shurjoPay instead; a landing page shopper
 * pays the advance with Nagad and lands on the thank-you page; the dashboard shows each
 * order's online payment and every try. Phone and dark screenshots too. Fails on console
 * errors, unexpected API errors or a missing result.
 *
 * Earlier runs can leave tries the stand-in never settled (a gateway with tries still being
 * checked cannot be removed), so the flow closes its own leftover tries in MongoDB
 * (connection from sellora-api/.env) before it removes the gateways.
 *
 * Needs: the live store from stores-flow (Nakshi Ghor, shop@demo.sellora.test) with the
 * Inside and Outside Dhaka delivery areas, the payment stand-in, the API and worker started
 * with PAYMENT_<GATEWAY>_SANDBOX_URL=http://127.0.0.1:4110/<gateway>, and platform admin
 * details (to approve the landing page).
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/checkout-payments-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), PAYMENT_STAND_IN_URL
 * (http://127.0.0.1:4110), SELLORA_API_DIR (../sellora-api).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const STAND_IN = (env.PAYMENT_STAND_IN_URL ?? 'http://127.0.0.1:4110').replace(/\/+$/, '');
const API_DIR = resolve(env.SELLORA_API_DIR ?? '../sellora-api');
const OUT = env.SMOKE_OUT ?? 'smoke-output/payments';
mkdirSync(OUT, { recursive: true });

const SLUG = 'pay-check';
const run = String(Date.now()).slice(-6);
const phone = (n) => `018${run}${String(n).padStart(2, '0')}`;

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

function watch(page, label, expected = []) {
  page.on('console', (m) => {
    // 401: the sign-in pages ask who is signed in before anyone is.
    if (m.type() === 'error' && !/status of 401/.test(m.text()))
      if (!expected.some((e) => m.text().includes(e)))
        problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    const path = new URL(r.url()).pathname;
    if (expected.some((e) => `${s} ${path}`.startsWith(e))) return;
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
async function call(page, method, path, body, { allow = [] } = {}) {
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
  if (r.status >= 400 && !allow.includes(r.status))
    throw new Error(
      `${method} ${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  return allow.length ? r : r.body;
}

/**
 * Keeps the answer to each request to `path` in the tab's session storage as it arrives: the
 * page leaves for the gateway as soon as it has it, too soon to read it from the browser.
 */
async function keepAnswers(p, path) {
  await p.addInitScript((path) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await original(input, init);
      const url = typeof input === 'string' ? input : input.url;
      if (new URL(url, location.href).pathname === path)
        sessionStorage.setItem(
          '__flow_answer',
          JSON.stringify({ status: res.status, body: await res.clone().json() }),
        );
      return res;
    };
  }, path);
}

/** The kept answer, read back once the shopper is on the shop's site again. */
async function keptAnswer(p) {
  const raw = await p.evaluate(() => sessionStorage.getItem('__flow_answer'));
  check(raw, 'no answer was kept');
  return JSON.parse(raw);
}

async function standIn(path) {
  const res = await fetch(`${STAND_IN}${path}`);
  if (!res.ok) throw new Error(`stand-in ${path} answered ${res.status}`);
  return res.json();
}

/** The API's own database, only to close tries earlier runs left unsettled. */
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
const shopPayments = mongo.db(dbEnv.MONGODB_DB_NAME).collection('shoppayments');

const nagadKeys = await standIn('/__nagad-keys');
/** The stand-in's demo keys, typed into Settings › Payments as a business would. */
const KEYS = {
  bkash: {
    'App key': 'demo-bkash-app-key',
    'App secret': 'demo-bkash-app-secret',
    Username: 'demo-bkash-user',
    Password: 'demo-bkash-password',
  },
  nagad: {
    'Merchant ID': '683002007104225',
    'Merchant number': '01711428036',
    'Merchant private key': nagadKeys.merchantPrivateKey,
    'Nagad public key': nagadKeys.nagadPublicKey,
  },
  sslcommerz: { 'Store ID': 'demosellora01', 'Store password': 'demosellora01@ssl' },
  aamarpay: { 'Store ID': 'aamarpaytest', 'Signature key': 'demo-aamarpay-signature-key' },
  shurjopay: {
    Username: 'demo-shurjopay',
    Password: 'demo-shurjopay-password',
    'Order prefix': 'DEMO',
  },
};
const NAMES = {
  bkash: 'bKash',
  nagad: 'Nagad',
  sslcommerz: 'SSLCommerz',
  aamarpay: 'aamarPay',
  shurjopay: 'shurjoPay',
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await actx.newPage();
// The wrong SSLCommerz password is refused on purpose, and removing a gateway with tries
// from an earlier run still being checked is refused before the flow closes them.
watch(page, 'merchant', [
  '422 /v1/orgs',
  '409 /v1/orgs',
  'Failed to load resource: the server responded with a status of 422',
  'Failed to load resource: the server responded with a status of 409',
]);
watch(admin, 'admin');
let failed = false;
let org;
let orgId;
let store;
let landing;
let zones;
const placed = [];

function phoneContext() {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
}

async function paymentsPage() {
  await page.goto(`${BASE}${org}/settings/payments`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  await page.locator('a[aria-current=page]', { hasText: 'Payments' }).waitFor();
}

/** Fills the connect dialog with the gateway's keys and saves (test mode stays on). */
async function connect(gateway, keys = KEYS[gateway]) {
  await page.getByRole('button', { name: NAMES[gateway], exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: `Connect ${NAMES[gateway]}` }).waitFor();
  for (const [label, value] of Object.entries(keys))
    await dialog.getByLabel(label, { exact: true }).fill(value);
  check(
    (await dialog.getByRole('switch', { name: 'Test mode' }).getAttribute('aria-checked')) ===
      'true',
    'test mode is not on for a new gateway',
  );
  return dialog;
}

async function save(dialog) {
  await dialog.getByRole('button', { name: /^(Check and save|Save)$/ }).click();
}

async function orderByNumber(number) {
  const list = await call(page, 'GET', `/orgs/${orgId}/orders?q=${encodeURIComponent(number)}`);
  const o = list.items.find((x) => x.number === number);
  check(o, `order ${number} not found`);
  return o;
}

try {
  await step('sign in (business and super-admin), start with no gateway', async () => {
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

    const o = await call(page, 'GET', `/orgs/${orgId}/shop-payments`);
    zones = Object.fromEntries(o.zones.map((z) => [z.name, z]));
    check(zones['Inside Dhaka'] && zones['Outside Dhaka'], 'the demo delivery areas are missing');
    for (const a of o.accounts) {
      const r = await call(
        page,
        'DELETE',
        `/orgs/${orgId}/shop-payments/accounts/${a.id}`,
        undefined,
        {
          allow: [409],
        },
      );
      if (r.status === 409) {
        // Tries from earlier runs of this check that the stand-in never settled.
        await shopPayments.updateMany(
          { orgId: new ObjectId(orgId), accountId: new ObjectId(a.id), settled: false },
          { $set: { settled: true, status: 'failed', reason: 'Closed by the browser check' } },
        );
        await call(page, 'DELETE', `/orgs/${orgId}/shop-payments/accounts/${a.id}`);
      }
    }
    await call(page, 'PATCH', `/orgs/${orgId}/shop-payments/settings`, {
      cod: true,
      fullOnline: true,
      advance: { mode: 'off', fixedMinor: 0, percent: 0, zoneIds: [], minTotalMinor: 0 },
    });

    // A landing page for the third shopper.
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
      name: 'Gamchha payment check',
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

  await step('Settings › Payments starts empty: shoppers see cash on delivery only', async () => {
    await page.goto(`${BASE}${org}/settings`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Payments', exact: true }).click();
    await page.waitForURL('**/settings/payments');
    await page.getByText('No gateway connected yet').waitFor();
    await page.getByText('No gateway is on, so shoppers only see cash on delivery.').waitFor();
    await shot(page, '01-payments-empty', true);
  });

  await step('wrong SSLCommerz keys are refused, the right ones connect', async () => {
    const dialog = await connect('sslcommerz', {
      'Store ID': 'demosellora01',
      'Store password': 'not-the-password',
    });
    await save(dialog);
    await dialog.getByText(/SSLCommerz did not accept these keys/).waitFor({ timeout: 15_000 });
    await dialog.screenshot({ path: join(OUT, '02-wrong-keys.png') });
    await dialog
      .getByLabel('Store password', { exact: true })
      .fill(KEYS.sslcommerz['Store password']);
    await save(dialog);
    await page
      .getByText(
        'SSLCommerz connected in test mode. SSLCommerz accepted the store ID and password.',
      )
      .waitFor({ timeout: 15_000 });
  });

  await step('bKash, Nagad, aamarPay and shurjoPay connect with their keys', async () => {
    for (const g of ['bkash', 'nagad', 'aamarpay', 'shurjopay']) {
      const dialog = await connect(g);
      if (g === 'nagad') await dialog.screenshot({ path: join(OUT, '03-connect-nagad.png') });
      await save(dialog);
      await page.getByText(`${NAMES[g]} connected in test mode.`).waitFor({ timeout: 15_000 });
      await dialog.waitFor({ state: 'detached' });
    }
    const o = await call(page, 'GET', `/orgs/${orgId}/shop-payments`);
    check(
      o.accounts.length === 5 && o.accounts.every((a) => a.enabled && a.sandbox),
      'not all five on in test mode',
    );
    // Nothing secret comes back: only the masked hint.
    const raw = JSON.stringify(o.accounts);
    check(
      !raw.includes('demo-bkash-app-secret') && !raw.includes('PRIVATE KEY'),
      'a secret came back',
    );
    await page
      .locator('dd', { hasText: 'aamarPay confirms these keys on the first payment.' })
      .waitFor();
  });

  await step('ask the delivery charge as an advance, outside Dhaka only', async () => {
    const card = page.locator('form', { hasText: 'Advance on cash on delivery' });
    await card.getByRole('radio', { name: 'Delivery charge' }).click();
    await card.getByLabel('Outside Dhaka').check();
    await card
      .getByText(/Example: a .*1,500.* order to Outside Dhaka .* asks .*120.* online first/)
      .waitFor();
    await card.getByRole('button', { name: 'Save payment options' }).click();
    await page.getByText('Payment options saved.', { exact: false }).waitFor();
    const s = (await call(page, 'GET', `/orgs/${orgId}/shop-payments`)).settings;
    check(
      s.advance.mode === 'delivery' &&
        s.advance.zoneIds.length === 1 &&
        s.advance.zoneIds[0] === zones['Outside Dhaka'].id,
      `advance not saved: ${JSON.stringify(s.advance)}`,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '04-payments-connected', true);
  });

  await step(
    'a store shopper pays the advance with bKash and comes back to the receipt',
    async () => {
      const shopper = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const p = await shopper.newPage();
      watch(p, 'store shopper');
      await keepAnswers(p, '/api/checkout');
      await p.goto(`${store.url}/products/nakshi-kantha-throw`, { waitUntil: 'networkidle' });
      await p.getByRole('button', { name: 'Add to cart' }).click();
      await p.goto(`${store.url}/checkout`, { waitUntil: 'networkidle' });
      await p.getByLabel('Full name').fill('Farhana Rahman');
      await p.getByLabel('Mobile number').fill(phone(1));
      await p.getByLabel('House, road, village').fill('Holding 7, College Road');
      await p.getByLabel('City').fill('Rajshahi');
      await p.getByLabel('Outside Dhaka').check();
      await p.getByText(/Pay .*120.* online now as an advance/).waitFor({ timeout: 10_000 });
      await p.getByRole('radio', { name: /^bKash/ }).check();
      await p.getByRole('button', { name: /Place order and pay .*120/ }).waitFor();
      await shot(p, '05-checkout-advance', true);
      await p.getByRole('button', { name: /Place order and pay/ }).click();
      await p.waitForURL((u) => u.port === '4110', { timeout: 20_000 });
      await p.getByRole('heading', { name: 'bKash' }).waitFor();
      await shot(p, '06-gateway-page');
      await p.getByRole('button', { name: /^Pay ৳/ }).click();
      await p.waitForURL('**/order?**payment=paid**', { timeout: 20_000 });
      const { status, body } = await keptAnswer(p);
      check(status === 201, `checkout answered ${status}`);
      check(
        body.payment?.gateway === 'bkash' && body.payment.amountMinor === 12_000,
        `payment: ${JSON.stringify(body.payment)}`,
      );
      placed.push(body.orderNumber);
      await p.getByText('Payment received. Thank you!').waitFor();
      await p.getByRole('heading', { name: 'Thank you for your order!' }).waitFor();
      await p.getByText('Cash on delivery · Advance paid with bKash').waitFor();
      await p.getByText('To pay on delivery').waitFor();
      await p
        .getByText('Test mode: the shop is trying payments out.', { exact: false })
        .first()
        .waitFor();
      check(
        (await p.getByRole('heading', { name: 'Pay online' }).count()) === 0,
        'still asks to pay',
      );
      await shot(p, '07-receipt-advance-paid', true);
      await shopper.close();
    },
  );

  await step(
    'a phone shopper cancels SSLCommerz, then pays from the receipt with shurjoPay',
    async () => {
      const c = await phoneContext();
      const p = await c.newPage();
      watch(p, 'phone shopper');
      await keepAnswers(p, '/api/checkout');
      await p.goto(`${store.url}/products/nakshi-kantha-throw`, { waitUntil: 'networkidle' });
      await p.getByRole('button', { name: 'Add to cart' }).click();
      await p.goto(`${store.url}/checkout`, { waitUntil: 'networkidle' });
      await p.getByLabel('Full name').fill('Tanvir Ahmed');
      await p.getByLabel('Mobile number').fill(phone(2));
      await p.getByLabel('House, road, village').fill('House 3, Road 11, Banani');
      await p.getByLabel('City').fill('Dhaka');
      await p.getByLabel('Inside Dhaka').check();
      await p.getByRole('radio', { name: /Pay the whole amount now/ }).check();
      await p.getByRole('radio', { name: /^SSLCommerz/ }).check();
      await p
        .locator('section', { hasText: 'Pay with' })
        .first()
        .screenshot({
          path: join(OUT, '08-phone-pay-online.png'),
        });
      await p.getByRole('button', { name: /Place order and pay/ }).click();
      await p.waitForURL((u) => u.port === '4110', { timeout: 20_000 });
      await p.getByRole('heading', { name: 'SSLCommerz' }).waitFor();
      await p.getByRole('button', { name: 'Cancel' }).click();
      await p.waitForURL('**/order?**payment=cancelled**', { timeout: 20_000 });
      const kept = await keptAnswer(p);
      check(kept.status === 201, `checkout answered ${kept.status}`);
      placed.push(kept.body.orderNumber);
      await p
        .getByText('The payment was cancelled. You can pay below when you are ready.')
        .waitFor();
      await p.getByRole('heading', { name: 'Pay online' }).waitFor();
      await shot(p, '09-phone-cancelled', true);
      await p.getByRole('button', { name: /with shurjoPay/ }).click();
      await p.waitForURL((u) => u.port === '4110', { timeout: 20_000 });
      await p.getByRole('heading', { name: 'shurjoPay' }).waitFor();
      await p.getByRole('button', { name: /^Pay ৳/ }).click();
      await p.waitForURL('**/order?**payment=paid**', { timeout: 20_000 });
      await p.getByText('Payment received. Thank you!').waitFor();
      await p.getByText('Paid online with shurjoPay').waitFor();
      await shot(p, '10-phone-paid', true);
      await c.close();
    },
  );

  await step('a landing page shopper pays the advance with Nagad', async () => {
    const c = await phoneContext();
    const p = await c.newPage();
    watch(p, 'landing shopper');
    await keepAnswers(p, `/api/landing/${SLUG}/order`);
    await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await p.locator('#order').scrollIntoViewIfNeeded();
    await p.getByLabel('Full name').fill('Nusrat Jahan');
    await p.getByLabel('Mobile number').fill(phone(3));
    await p.getByLabel(/Full address/).fill('Ward 4, Station Road, Bogura');
    await p.getByLabel('Outside Dhaka').check();
    await p.getByText(/Pay .*120.* online now as an advance/).waitFor();
    await p.getByRole('radio', { name: /^Nagad/ }).check();
    await p.locator('#order').screenshot({ path: join(OUT, '11-landing-advance.png') });
    await p.getByRole('button', { name: /Place order and pay .*120/ }).click();
    await p.waitForURL((u) => u.port === '4110', { timeout: 20_000 });
    await p.getByRole('heading', { name: 'Nagad' }).waitFor();
    await p.getByRole('button', { name: /^Pay ৳/ }).click();
    await p.waitForURL(`**/${SLUG}/thanks?**payment=paid**`, { timeout: 20_000 });
    const { status, body } = await keptAnswer(p);
    check(status === 201, `landing order answered ${status}`);
    check(body.payment?.gateway === 'nagad', `payment: ${JSON.stringify(body.payment)}`);
    placed.push(body.orderNumber);
    await p.getByText('Payment received. Thank you!').waitFor();
    await p.getByText('Cash on delivery · Advance paid with Nagad').waitFor();
    await shot(p, '12-landing-thanks-paid', true);
    await c.close();
  });

  await step('the dashboard shows each order’s online payment and every try', async () => {
    const [advance, full, landingOrder] = await Promise.all(placed.map(orderByNumber));
    check(
      advance.payment.online?.status === 'paid' &&
        advance.payment.paidMinor === 12_000 &&
        advance.payment.method === 'cod',
      `store advance: ${JSON.stringify(advance.payment)}`,
    );
    check(
      full.payment.status === 'paid' && full.payment.paidMinor === full.totalMinor,
      `full payment: ${JSON.stringify(full.payment)}`,
    );
    check(
      landingOrder.payment.online?.gateway === 'nagad' && landingOrder.payment.paidMinor === 12_000,
      `landing advance: ${JSON.stringify(landingOrder.payment)}`,
    );
    const asked = await standIn('/__payments');
    check(
      asked.filter((x) => x.state === 'paid').length >= 3,
      'the stand-in did not see three payments',
    );

    await page.goto(`${BASE}${org}/orders`, { waitUntil: 'networkidle' });
    await page
      .getByRole('row')
      .filter({ hasText: advance.number })
      .getByText('Advance paid (test)')
      .waitFor();
    await page
      .getByRole('row')
      .filter({ hasText: full.number })
      .getByText('Paid online (test)')
      .waitFor();
    await shot(page, '13-orders-list');
    await page.goto(`${BASE}${org}/orders/${full.id}`, { waitUntil: 'networkidle' });
    const tries = page.getByRole('list', { name: 'Payment tries' });
    await tries.getByText('shurjoPay').waitFor();
    await tries.getByText('SSLCommerz').waitFor();
    await tries.getByText('Cancelled', { exact: true }).waitFor();
    await page.getByText('Test payment through the gateway’s sandbox.', { exact: false }).waitFor();
    await shot(page, '14-order-tries', true);
  });

  await step('turning a gateway off hides it from shoppers; phone and dark layouts', async () => {
    await paymentsPage();
    await page.getByRole('switch', { name: 'bKash on or off' }).click();
    await page.getByText('bKash is off. Shoppers no longer see it.').waitFor();
    // What the store's checkout is offered now, asked the way the checkout page asks.
    const products = await call(page, 'GET', `/orgs/${orgId}/products?q=Nakshi&status=active`);
    const throw_ = products.items.find((x) => x.name === 'Nakshi Kantha Throw');
    const shopper = await browser.newContext();
    const sp = await shopper.newPage();
    await sp.goto(store.url, { waitUntil: 'domcontentloaded' });
    const quote = await sp.evaluate(
      async (item) => {
        const res = await fetch('/api/cart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: [item] }),
        });
        return res.json();
      },
      { productId: throw_.id, variantId: throw_.variants[0].id, quantity: 1 },
    );
    await shopper.close();
    const offered = quote.payments.gateways
      .map((g) => g.key)
      .sort()
      .join(',');
    check(offered === 'aamarpay,nagad,shurjopay,sslcommerz', `offered after bKash off: ${offered}`);
    await page.getByRole('switch', { name: 'bKash on or off' }).click();
    await page.getByText('bKash is on. Shoppers can pay with it.').waitFor();

    const c = await phoneContext();
    const p = await c.newPage();
    watch(p, 'merchant phone');
    await p.goto(`${BASE}/login`);
    await p.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await p.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await p.click('button[type=submit]');
    await p.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    await p.goto(`${BASE}${org}/settings/payments`, { waitUntil: 'networkidle' });
    await p.getByText('How shoppers can pay').waitFor();
    await shot(p, '15-payments-phone', true);
    await c.close();

    await page.emulateMedia({ colorScheme: 'dark' });
    await paymentsPage();
    await shot(page, '16-payments-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });
} catch (err) {
  failed = true;
  console.error(`\nStopped: ${String(err).split('\n')[0]}`);
  await shot(page, 'zz-failure', true).catch(() => {});
} finally {
  // The next run starts the same way: the test orders cancelled (stock back), page removed.
  if (orgId) {
    for (const number of placed)
      await orderByNumber(number)
        .then((o) =>
          call(page, 'POST', `/orgs/${orgId}/orders/${o.id}/cancel`, { reason: 'Browser check' }),
        )
        .catch((e) => problems.push(`could not cancel ${number}: ${String(e).slice(0, 120)}`));
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
