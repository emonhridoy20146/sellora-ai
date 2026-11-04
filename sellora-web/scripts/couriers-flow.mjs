/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through courier booking and delivery risk in a real browser, against a running web
 * app, API and worker whose courier addresses point at the courier stand-in
 * (sellora-api/scripts/courier-stand-in.mjs). It is NOT a test against Steadfast, Pathao or
 * RedX: the stand-in answers in their API shapes, and parcel movements are the stand-in's
 * test hooks sending the courier-style webhooks.
 *
 * What it checks: connecting Steadfast (a wrong secret refused first), Pathao and RedX in
 * Settings › Couriers; booking from the order page with each (Pathao city/zone/area, RedX
 * area search); cancel and edit locked while booked; webhooks moving the parcel and the
 * order to shipped and delivered; a courier's refusal shown with its reason, then booked on
 * a second attempt; a lost RedX reply linked by hand; a Pathao return marked returned; the
 * orders list chips, courier filter and bulk sending; delivery risk on orders and customers;
 * and, with platform admin details, the super-admin's delivery-network switch and a
 * business's sharing switch (both left off again). Fails on console errors, unexpected API
 * errors or a missing result. Creates real data in the signed-in business.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/couriers-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), API_DIRECT_URL (http://127.0.0.1:4000),
 * COURIER_STAND_IN_URL (http://127.0.0.1:4030), SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD,
 * SMOKE_ADMIN_TOTP_SECRET.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const API = (env.API_DIRECT_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const STAND_IN = (env.COURIER_STAND_IN_URL ?? 'http://127.0.0.1:4030').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/couriers';
mkdirSync(OUT, { recursive: true });

// The stand-in's demo credentials.
const STEADFAST = { apiKey: 'demo-steadfast-key', secretKey: 'demo-steadfast-secret' };
const PATHAO = {
  clientId: 'demo-pathao-client',
  clientSecret: 'demo-pathao-secret',
  username: 'demo@sellora.test',
  password: 'demo-pathao-password',
};
const REDX = { accessToken: 'demo-redx-token-0000000000' };

const run = String(Date.now()).slice(-6);
// The run in letters, for names: order search also matches digits against phone numbers.
const tag = run.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const phone = (n) => `017${run}${String(n).padStart(2, '0')}`;

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

// Responses the flow causes on purpose (a refused key check, a courier refusal), and the
// console lines the browser logs for them.
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

/** Calls the API from inside the signed-in page (cookies and CSRF header included). */
async function call(page, method, path, body) {
  const r = await page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('sl_csrf='))
        ?.slice('sl_csrf='.length);
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

async function standInParcel(invoice) {
  const { parcels } = await standIn('/__parcels');
  const p = parcels.find((x) => x.invoice === invoice);
  if (!p) throw new Error(`the courier stand-in has no parcel ${invoice}`);
  return p;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
watch(page, 'merchant');
let failed = false;
let org;
let orgId;
const accounts = {};
const orders = {};

/** Moves a parcel at the stand-in and sends the courier's webhook to the API. */
async function advance(provider, invoice, status) {
  const p = await standInParcel(invoice);
  const account = accounts[provider];
  const key = account.webhook.url.split('/').pop();
  const r = await standIn('/__advance', {
    id: p.id,
    status,
    notify: { url: `${API}/v1/webhooks/couriers/${key}`, secret: account.webhook.secret },
  });
  if (!r.webhook || r.webhook.status >= 300)
    throw new Error(`the webhook for ${invoice} was answered ${JSON.stringify(r.webhook)}`);
}

async function newOrder(name, n, extra = {}) {
  const products = await call(page, 'GET', `/orgs/${orgId}/products?status=active&limit=50`);
  const product = products.items.find((p) => p.variants.length > 0);
  if (!product) throw new Error('the demo business needs an active product');
  const variant =
    product.variants.find((v) => !v.trackStock || v.stock >= 5) ?? product.variants[0];
  // Earlier runs use stock up: receive more, recorded in stock history like a delivery.
  if (variant.trackStock && variant.stock < 5)
    await call(page, 'POST', `/orgs/${orgId}/products/${product.id}/stock`, {
      variantId: variant.id,
      mode: 'add',
      quantity: 50,
      reason: 'received',
      note: 'Courier browser check',
    });
  let o = await call(page, 'POST', `/orgs/${orgId}/orders`, {
    customer: { name, phone: phone(n) },
    shippingAddress: {
      line1: `House ${n}, Road 11`,
      area: extra.area ?? 'Dhanmondi',
      city: 'Dhaka',
    },
    items: [{ productId: product.id, variantId: variant.id, quantity: 1 }],
  });
  if (o.status === 'pending')
    o = await call(page, 'POST', `/orgs/${orgId}/orders/${o.id}/status`, {
      status: 'confirmed',
    });
  return o;
}

async function openOrder(o) {
  await page.goto(`${BASE}${org}/orders/${o.id}`, { waitUntil: 'networkidle' });
  await page.getByText(o.number).first().waitFor();
}

async function connect(provider, fields) {
  await page.getByRole('button', { name: provider.name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const [k, v] of Object.entries(fields)) await dialog.locator(`#ca-${k}`).fill(v);
  await dialog.getByRole('button', { name: 'Check and connect' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15_000 });
}

try {
  await step('sign in', async () => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
  });

  await step('connect Steadfast after a wrong secret is refused', async () => {
    await page.goto(`${BASE}${org}/settings/couriers`, { waitUntil: 'networkidle' });
    const have = (await call(page, 'GET', `/orgs/${orgId}/couriers/accounts`)).items;
    if (!have.length) await shot(page, '01-couriers-empty');
    await page.getByRole('button', { name: 'Steadfast', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#ca-apiKey').fill(STEADFAST.apiKey);
    await dialog.locator('#ca-secretKey').fill('not-the-secret');
    expect422(/\/couriers\/accounts$/);
    await dialog.getByRole('button', { name: 'Check and connect' }).click();
    await dialog.getByRole('alert').waitFor();
    await shot(page, '02-steadfast-refused');
    if (have.some((a) => a.provider === 'steadfast')) {
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    } else {
      await dialog.locator('#ca-name').fill('Steadfast main');
      await dialog.locator('#ca-secretKey').fill(STEADFAST.secretKey);
      await dialog.getByRole('button', { name: 'Check and connect' }).click();
      await dialog.waitFor({ state: 'detached', timeout: 15_000 });
      await page.getByText('Steadfast main').first().waitFor();
    }
  });

  await step('connect Pathao and RedX; each picks its only pickup store', async () => {
    const have = (await call(page, 'GET', `/orgs/${orgId}/couriers/accounts`)).items;
    if (!have.some((a) => a.provider === 'pathao')) await connect({ name: 'Pathao' }, PATHAO);
    if (!have.some((a) => a.provider === 'redx')) await connect({ name: 'RedX' }, REDX);
    const list = (await call(page, 'GET', `/orgs/${orgId}/couriers/accounts`)).items;
    for (const p of ['steadfast', 'pathao', 'redx']) {
      accounts[p] = list.find((a) => a.provider === p && a.enabled);
      if (!accounts[p]) throw new Error(`no ${p} account is on`);
    }
    if (accounts.pathao.settings.storeId !== '90001')
      throw new Error(`Pathao store should be 90001, is ${accounts.pathao.settings.storeId}`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('Callback URL').first().waitFor();
    // A check refreshes the pickup store's name from the courier.
    const checks = page.getByRole('button', { name: 'Check connection' });
    for (let i = 0; i < (await checks.count()); i++) {
      await checks.nth(i).click();
    }
    await page.getByText('Sellora Demo Warehouse').waitFor({ timeout: 15_000 });
    await page.getByText('Sellora Demo Pickup').waitFor({ timeout: 15_000 });
    await page.getByText('just now').first().waitFor();
    // Toasts stack; wait until all have closed so the full-page shot is clean.
    await page.waitForFunction(() => !document.querySelector('[data-sonner-toast]'), null, {
      timeout: 15_000,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '03-couriers-connected', true);
  });

  await step('book with Steadfast from the order page', async () => {
    orders.a = await newOrder(`Courier Flow A ${run}`, 1);
    await openOrder(orders.a);
    await page.getByText('Not sent to a courier yet.').waitFor();
    await page.getByRole('button', { name: 'Send to courier' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#bk-account').selectOption(accounts.steadfast.id);
    await dialog.locator('#bk-weight').fill('0.8');
    await dialog.locator('#bk-note').fill('Call before coming');
    await shot(page, '04-book-steadfast');
    await dialog.getByRole('button', { name: 'Book with Steadfast' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20_000 });
    await page.getByText('Booked', { exact: true }).first().waitFor();
    await page.getByRole('link', { name: 'Track' }).waitFor();
    // Cancelling or editing would leave the courier with the wrong parcel.
    if (await page.getByRole('button', { name: 'Cancel order' }).count())
      throw new Error('Cancel order is offered while the parcel is booked');
    if (await page.getByRole('button', { name: 'Edit items' }).count())
      throw new Error('Edit items is offered while the parcel is booked');
    await shot(page, '05-order-booked', true);
  });

  await step('courier webhooks move the parcel and the order to delivered', async () => {
    const order = () => call(page, 'GET', `/orgs/${orgId}/orders/${orders.a.id}`);
    await advance('steadfast', orders.a.number, 'pending');
    // The webhook only nudges Sellora; the worker asks Steadfast for the status.
    await until(async () => (await order()).status === 'shipped', 'the order to ship');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('On the way', { exact: true }).first().waitFor();
    await advance('steadfast', orders.a.number, 'delivered');
    await until(async () => (await order()).status === 'delivered', 'the order to be delivered');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('Delivered', { exact: true }).first().waitFor();
    await shot(page, '06-order-delivered', true);
  });

  await step('a courier refusal shows its reason; the second attempt books', async () => {
    orders.b = await newOrder(`Courier Flow B ${run}`, 2);
    await openOrder(orders.b);
    await standIn('/__fail', { provider: 'steadfast', fault: 422 });
    await page.getByRole('button', { name: 'Send to courier' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#bk-account').selectOption(accounts.steadfast.id);
    expect422(/\/orders\/[a-f0-9]{24}\/parcels$/);
    await dialog.getByRole('button', { name: 'Book with Steadfast' }).click();
    await dialog.getByText('Steadfast refused the booking').waitFor();
    await shot(page, '07-courier-refused');
    await dialog.getByRole('button', { name: 'Book with Steadfast' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20_000 });
    await page.getByText(`${orders.b.number}-2`).first().waitFor();
    await page.getByText('Earlier attempts (1)').waitFor();
  });

  await step('book with Pathao using city, zone and area', async () => {
    orders.c = await newOrder(`Courier Flow C ${run}`, 3, { area: 'Gulshan' });
    await openOrder(orders.c);
    await page.getByRole('button', { name: 'Send to courier' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#bk-account').selectOption(accounts.pathao.id);
    await dialog.locator('#bk-city option', { hasText: 'Dhaka' }).waitFor({ state: 'attached' });
    await dialog.locator('#bk-city').selectOption({ label: 'Dhaka' });
    await dialog.locator('#bk-zone option', { hasText: 'Gulshan' }).waitFor({ state: 'attached' });
    await dialog.locator('#bk-zone').selectOption({ label: 'Gulshan' });
    await dialog
      .locator('#bk-area option', { hasText: 'Gulshan 1' })
      .waitFor({ state: 'attached' });
    await dialog.locator('#bk-area').selectOption({ label: 'Gulshan 1' });
    await dialog.locator('#bk-weight').fill('1');
    await shot(page, '08-book-pathao');
    await dialog.getByRole('button', { name: 'Book with Pathao' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20_000 });
    await page.getByText('Gulshan 1, Gulshan, Dhaka').waitFor();
  });

  await step('a Pathao return asks staff to mark the order returned', async () => {
    const shipment = async () =>
      (await call(page, 'GET', `/orgs/${orgId}/orders/${orders.c.id}`)).shipment?.status;
    await advance('pathao', orders.c.number, 'Picked');
    await until(async () => (await shipment()) === 'picked_up', 'Pathao to pick the parcel up');
    await advance('pathao', orders.c.number, 'Returned');
    await until(async () => (await shipment()) === 'returned', 'Pathao to return the parcel');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('Returned', { exact: true }).first().waitFor({ timeout: 15_000 });
    await page
      .getByRole('status')
      .filter({ hasText: /return/i })
      .first()
      .waitFor();
    await shot(page, '09-pathao-returned', true);
    await page.getByRole('button', { name: 'Mark returned' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark returned' }).click();
    await page.getByText('Order returned.').waitFor();
  });

  await step('a lost RedX reply is linked by hand', async () => {
    orders.d = await newOrder(`Courier Flow D ${run}`, 4);
    await openOrder(orders.d);
    await standIn('/__fail', { provider: 'redx', fault: 'lose-reply' });
    await page.getByRole('button', { name: 'Send to courier' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#bk-account').selectOption(accounts.redx.id);
    await dialog.locator('#bk-area-q').fill('dhanmondi');
    await dialog.getByRole('radio', { name: /Dhanmondi/ }).click();
    await shot(page, '10-book-redx-area');
    await dialog.getByRole('button', { name: 'Book with RedX' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 30_000 });
    await page.getByRole('button', { name: 'It is booked: link it' }).waitFor();
    await shot(page, '11-redx-lost-reply', true);
    const p = await standInParcel(orders.d.number);
    await page.getByRole('button', { name: 'It is booked: link it' }).click();
    await page.getByRole('dialog').locator('#lk-cid').fill(p.id);
    await page.getByRole('dialog').getByRole('button', { name: 'Link booking' }).click();
    await page.getByText('Booked', { exact: true }).first().waitFor({ timeout: 15_000 });
    await page.getByText(p.id).first().waitFor();
  });

  await step('orders list: courier chips, filter and bulk sending', async () => {
    orders.e = await newOrder(`Courier Bulk ${tag}`, 5);
    orders.f = await newOrder(`Courier Bulk ${tag}`, 6);
    // The same number as order A, which was delivered: low risk.
    orders.g = await newOrder(`Courier Flow A ${run}`, 1);
    await page.goto(`${BASE}${org}/orders`, { waitUntil: 'networkidle' });
    await page.fill('#o-search', `Courier Bulk ${tag}`);
    // The search applies after a short pause: wait until only the two bulk orders are listed.
    await until(
      async () => (await page.locator('tbody tr').count()) === 2,
      'the search to leave the two bulk orders',
    );
    await page.getByRole('checkbox', { name: 'Select all orders on this page' }).click();
    await page.getByRole('button', { name: 'Send to courier' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#bb-account').selectOption(accounts.steadfast.id);
    await dialog.getByRole('button', { name: /^Send 2 to Steadfast/ }).click();
    await dialog.getByText('2 sent to').waitFor({ timeout: 15_000 });
    await shot(page, '12-bulk-sent');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page
      .getByRole('row', { name: new RegExp(orders.e.number) })
      .getByText('Booked')
      .waitFor({ timeout: 30_000 });
    await page
      .getByRole('row', { name: new RegExp(orders.f.number) })
      .getByText('Booked')
      .waitFor({ timeout: 30_000 });
    await page.fill('#o-search', '');
    await page.selectOption('#o-ship', '');
    await page.getByText(orders.g.number).waitFor();
    await page
      .getByRole('row', { name: new RegExp(orders.g.number) })
      .getByText(/Low risk/)
      .waitFor();
    await shot(page, '13-orders-list');
    await page.selectOption('#o-ship', 'delivered');
    // The previous list stays on screen until the filtered one arrives.
    await page
      .getByText(orders.e.number)
      .waitFor({ state: 'detached', timeout: 10_000 })
      .catch(() => {
        throw new Error('the Delivered filter shows a booked order');
      });
    await page.getByText(orders.a.number).waitFor();
    await shot(page, '14-orders-filter-delivered');
    await page.selectOption('#o-ship', '');
  });

  await step('the Couriers page: ready to send, with couriers, needs a look', async () => {
    orders.h = await newOrder(`Courier Ready ${run}`, 7);
    await page.goto(`${BASE}${org}/couriers`, { waitUntil: 'networkidle' });
    await page.getByText('Ready to send').first().waitFor();
    await page.getByText(orders.h.number).waitFor();
    await shot(page, '15-couriers-board-ready', true);
    await page.getByRole('button', { name: /^Delivered/ }).click();
    await page.getByText(orders.a.number).waitFor();
    await page.getByRole('button', { name: /^Booked/ }).click();
    await page.getByText(orders.e.number).waitFor();
    await shot(page, '16-couriers-board-booked');
  });

  await step('delivery risk on the order and the customer', async () => {
    await openOrder(orders.g);
    await page.getByText('Delivery risk').waitFor();
    await page
      .getByText(/Low risk · 100%/)
      .first()
      .waitFor();
    await shot(page, '17-order-risk', true);
    const returned = (await call(page, 'GET', `/orgs/${orgId}/orders/${orders.c.id}`)).customerId;
    await page.goto(`${BASE}${org}/customers/${returned}`, { waitUntil: 'networkidle' });
    await page
      .getByText(/Some risk · 0%/)
      .first()
      .waitFor();
    await shot(page, '18-customer-risk', true);
  });

  await step('the order page on a phone, and in dark mode', async () => {
    const phoneCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      storageState: await ctx.storageState(),
    });
    const p = await phoneCtx.newPage();
    watch(p, 'phone');
    await p.goto(`${BASE}${org}/orders/${orders.d.id}`, { waitUntil: 'networkidle' });
    await p.getByText('Courier', { exact: true }).waitFor();
    await shot(p, '19-order-courier-phone', true);
    await phoneCtx.close();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE}${org}/settings/couriers`, { waitUntil: 'networkidle' });
    await page.getByText('Callback URL').first().waitFor();
    await shot(page, '20-couriers-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  if (env.SMOKE_ADMIN_EMAIL) {
    await step(
      'super-admin switches the delivery network; a business opts in and out',
      async () => {
        const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
        const admin = await actx.newPage();
        watch(admin, 'admin');
        await admin.goto(`${BASE}/admin/login`);
        await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
        await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
        await admin.click('button[type=submit]');
        await admin.waitForSelector('#code', { timeout: 15_000 });
        await admin.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
        await admin.click('button[type=submit]');
        await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });
        const toggle = async (on) => {
          await admin.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
          const sw = admin.locator('#st-fraud-net');
          if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
          await admin.getByRole('button', { name: 'Save settings' }).click();
          await admin.getByText('Settings saved.').waitFor();
        };
        await toggle(true);
        await admin.getByText('Delivery network').scrollIntoViewIfNeeded();
        await shot(admin, '21-admin-delivery-network');

        await page.goto(`${BASE}${org}/settings/couriers`, { waitUntil: 'networkidle' });
        const share = page.getByRole('switch', { name: 'Share delivery results with other shops' });
        await share.click();
        await page.getByText(/Sharing on/).waitFor();
        await page.getByText('Delivery risk from other shops').scrollIntoViewIfNeeded();
        await shot(page, '22-business-sharing-on');
        await share.click();
        await page.getByText(/Sharing off/).waitFor();
        await toggle(false);
        await actx.close();
      },
    );
  }
} catch {
  failed = true;
  await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
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
