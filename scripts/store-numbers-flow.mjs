/* eslint-disable no-console -- a command-line report */
/**
 * Checks store visits and sales numbers (ADR 0027) in real browsers, against a running web
 * app, API and storefront app. The shoppers are this script's own browsers, not real
 * customers, and the order is a test order in the demo business.
 *
 * What it checks: a shopper from a Facebook ad (utm tags and fbclid) visits, looks at a
 * product, adds it to the cart, opens the checkout and orders, and each step is sent once
 * and counted once; the order keeps where the shopper came from; a second shopper from
 * Instagram visits and looks at a product, and their second tab is not counted again; the
 * business's own preview of the store sends nothing; the API's numbers grew by exactly those
 * steps (visitors, product views, cart, checkout, orders, order value, sources, products);
 * MongoDB holds only counts (no browser id or address); the Numbers page shows the API's
 * numbers for 7 days, its funnel, sources and products, a chart's table view, and asks for
 * 90 days when chosen; phone and
 * dark views. Fails on console errors, unexpected API errors or a missing result.
 *
 * Needs the demo business with a live store (shop@demo.sellora.test after stores-flow, which
 * opens Nakshi Ghor), the storefront app running (sellora-storefront, port 3100) and the API's
 * MongoDB (connection from sellora-api/.env, read only).
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/store-numbers-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), STORE_HANDLE (nakshi-ghor),
 * SELLORA_API_DIR (../sellora-api), SMOKE_OUT.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const API_DIR = resolve(env.SELLORA_API_DIR ?? '../sellora-api');
const OUT = env.SMOKE_OUT ?? 'smoke-output/store-numbers';
const HANDLE = env.STORE_HANDLE ?? 'nakshi-ghor';
mkdirSync(OUT, { recursive: true });

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

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label} console: ${m.text().slice(0, 200)}`);
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

/** Calls the API from inside the signed-in dashboard page. */
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

/** Every shopper step a page sends to the storefront app, with the API's answer. */
function stepsSent(page) {
  const sent = [];
  page.on('response', async (r) => {
    if (new URL(r.url()).pathname !== '/api/events') return;
    const body = JSON.parse(r.request().postData() ?? '{}');
    const entry = { type: body.type, body, status: r.status(), counted: undefined };
    sent.push(entry);
    try {
      entry.counted = (await r.json()).counted;
    } catch {
      entry.counted = null;
    }
  });
  return sent;
}

/** Waits for the `n`th step of a type (1 = first) to be answered. */
async function answered(sent, type, n = 1, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const e = sent.filter((x) => x.type === type)[n - 1];
    if (e && e.counted !== undefined) return e;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no answered "${type}" step (number ${n}) within ${timeout} ms`);
}

const formatNumber = (n) => new Intl.NumberFormat('en').format(n);
const minorDigits = (currency) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
// The same as src/lib/format.ts formatMoney.
function money(minor, currency) {
  const digits = minorDigits(currency);
  const major = minor / 10 ** digits;
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(major) ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(major);
}

/** The API's own database, read only, to see what is stored. */
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
const db = mongo.db(dbEnv.MONGODB_DB_NAME);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
watch(page, 'merchant');
let failed = false;
let org;
let orgId;
let store;
let before;
let after;
let orderNumber;
let orderTotal;
const visitorIds = [];
const shopperPhone = `017${String(Date.now()).slice(-8)}`;
const stats = () => call(page, 'GET', `/orgs/${orgId}/stores/${store.id}/stats?days=7`);

try {
  await step('sign in and find the live store', async () => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    const { items } = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = items.find((s) => s.handle === HANDLE);
    check(store, `no store ${HANDLE} in this business (run stores-flow first)`);
    check(store.status === 'live', `${HANDLE} is ${store.status}, not live`);
    before = await stats();
  });

  await step('a shopper from a Facebook ad visits, looks, adds to cart and orders', async () => {
    const shopper = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await shopper.newPage();
    watch(p, 'facebook shopper');
    const sent = stepsSent(p);
    await p.goto(`${store.url}/?utm_source=facebook&utm_campaign=eid-flow&fbclid=IwAR0flow`, {
      waitUntil: 'networkidle',
    });
    const visit = await answered(sent, 'visit');
    check(visit.status === 200 && visit.counted === true, `visit: ${JSON.stringify(visit)}`);
    check(visit.body.attribution?.utmSource === 'facebook', 'the visit lost its utm_source');
    visitorIds.push(visit.body.visitorId);

    await p.goto(`${store.url}/products/cotton-panjabi`, { waitUntil: 'networkidle' });
    const view = await answered(sent, 'product_view');
    check(view.counted === true && view.body.productId, `product view: ${JSON.stringify(view)}`);
    // The same shopper looking again the same day is not a new look.
    await p.reload({ waitUntil: 'networkidle' });
    check((await answered(sent, 'product_view', 2)).counted === false, 'a second look counted');

    await p.getByRole('button', { name: 'L', exact: true }).click();
    await p.getByRole('button', { name: 'Add to cart' }).click();
    check((await answered(sent, 'cart_add')).counted === true, 'add to cart not counted');

    await p.goto(`${store.url}/cart`, { waitUntil: 'networkidle' });
    await p.getByRole('link', { name: 'Checkout' }).first().click();
    await p.waitForURL('**/checkout');
    check((await answered(sent, 'checkout')).counted === true, 'checkout not counted');
    await p.getByLabel('Full name').fill('Sumaiya Islam');
    await p.getByLabel('Mobile number').fill(shopperPhone);
    await p.getByLabel('House, road, village').fill('House 3, Road 9, Mirpur');
    await p.getByLabel('City').fill('Dhaka');
    await p.getByLabel('Inside Dhaka').check();
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkout'),
      p.getByRole('button', { name: /Place order/ }).click(),
    ]);
    check(placed.status() === 201, `checkout answered ${placed.status()}`);
    const sentOrder = JSON.parse(placed.request().postData());
    check(sentOrder.attribution?.fbclid === 'IwAR0flow', 'the order was sent without its ad');
    ({ orderNumber, totalMinor: orderTotal } = await placed.json());
    await p.getByRole('heading', { name: 'Thank you for your order!' }).waitFor({
      timeout: 15_000,
    });
    // Every step was sent once: the visit is not sent again on later pages of the tab.
    check(sent.filter((x) => x.type === 'visit').length === 1, 'the visit was sent twice');
    await shopper.close();
  });

  await step(
    'a shopper from Instagram visits and looks; their second tab adds nothing',
    async () => {
      const shopper = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const p = await shopper.newPage();
      watch(p, 'instagram shopper');
      const sent = stepsSent(p);
      await p.goto(store.url, { waitUntil: 'networkidle', referer: 'https://l.instagram.com/' });
      const visit = await answered(sent, 'visit');
      check(visit.counted === true, `visit: ${JSON.stringify(visit)}`);
      check(visit.body.attribution?.referrer?.includes('instagram'), 'the referrer was not kept');
      visitorIds.push(visit.body.visitorId);
      await p.goto(`${store.url}/products/dhakai-jamdani-saree`, { waitUntil: 'networkidle' });
      check((await answered(sent, 'product_view')).counted === true, 'product view not counted');

      const second = await shopper.newPage();
      watch(second, 'instagram second tab');
      const sent2 = stepsSent(second);
      await second.goto(store.url, { waitUntil: 'networkidle' });
      const again = await answered(sent2, 'visit');
      check(again.counted === false, 'the same shopper was counted twice in a day');
      await shopper.close();
    },
  );

  await step('the business previewing its own store sends nothing', async () => {
    await page.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    const [preview] = await Promise.all([
      ctx.waitForEvent('page'),
      page.getByRole('button', { name: 'Preview' }).first().click(),
    ]);
    watch(preview, 'preview');
    const sent = stepsSent(preview);
    await preview.waitForURL((u) => u.hostname.startsWith(`${HANDLE}.`), { timeout: 15_000 });
    await preview.waitForLoadState('networkidle');
    await preview.goto(new URL('/products/cotton-panjabi', preview.url()).href, {
      waitUntil: 'networkidle',
    });
    await preview.waitForTimeout(1_000);
    check(sent.length === 0, `the preview sent ${sent.map((s) => s.type).join(', ')}`);
    await preview.close();
  });

  await step('the API counted exactly those steps', async () => {
    after = await stats();
    const d = (k) => after.total[k] - before.total[k];
    const want = {
      visitors: 2,
      productViewers: 2,
      cartVisitors: 1,
      checkoutVisitors: 1,
      orders: 1,
      revenueMinor: orderTotal,
    };
    for (const [k, v] of Object.entries(want))
      check(d(k) === v, `${k} grew by ${d(k)}, expected ${v}`);
    const src = (s, name) => s.sources.find((x) => x.source === name) ?? { visitors: 0, orders: 0 };
    check(
      src(after, 'facebook').visitors - src(before, 'facebook').visitors === 1 &&
        src(after, 'facebook').orders - src(before, 'facebook').orders === 1,
      'Facebook did not get the visit and the order',
    );
    check(
      src(after, 'instagram').visitors - src(before, 'instagram').visitors === 1,
      'Instagram did not get the visit',
    );
    const prod = (s, name) => s.products.find((x) => x.name === name);
    check(
      (prod(after, 'Cotton Panjabi')?.viewers ?? 0) -
        (prod(before, 'Cotton Panjabi')?.viewers ?? 0) ===
        1,
      'Cotton Panjabi looks did not grow by one',
    );
    check(
      (prod(after, 'Cotton Panjabi')?.orders ?? 0) -
        (prod(before, 'Cotton Panjabi')?.orders ?? 0) ===
        1,
      'Cotton Panjabi orders did not grow by one',
    );
    check(
      after.funnel.map((f) => f.step).join() ===
        'visited,viewed_product,added_to_cart,started_checkout,ordered',
      'the funnel steps changed',
    );
    const order = (await call(page, 'GET', `/orgs/${orgId}/orders?q=${orderNumber}`)).items[0];
    check(order.attribution?.utmSource === 'facebook', 'the order lost where it came from');
    check(order.attribution?.utmCampaign === 'eid-flow', 'the order lost its campaign');
  });

  await step('only counts are stored, never a browser id or address', async () => {
    const rows = await db
      .collection('store_stats')
      .find({ storeId: new ObjectId(store.id) })
      .toArray();
    const product = await db
      .collection('store_product_stats')
      .find({ storeId: new ObjectId(store.id) })
      .toArray();
    const text = JSON.stringify([rows, product]);
    for (const id of visitorIds) check(!text.includes(id), 'a browser id reached the database');
    check(!/203\.0\.|127\.0\.0\.1|::1/.test(text), 'an address reached the database');
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    const allowed = [
      '_id',
      'orgId',
      'storeId',
      'day',
      'visitors',
      'productViewers',
      'cartVisitors',
      'checkoutVisitors',
      'orders',
      'revenueMinor',
      'sources',
      'orderSources',
      'createdAt',
      'updatedAt',
      '__v',
    ];
    const extra = [...keys].filter((k) => !allowed.includes(k));
    check(extra.length === 0, `unexpected stored fields: ${extra.join(', ')}`);
  });

  await step('the Numbers page shows the same numbers', async () => {
    await page.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Numbers', exact: true }).click();
    await page.waitForURL(/\/numbers$/);
    await page.getByRole('radio', { name: '7 days' }).click();
    await page.getByText('How far shoppers got').waitFor({ timeout: 15_000 });
    const tile = (label) =>
      page.locator('div.rounded-lg', { has: page.getByText(label, { exact: true }) }).first();
    await tile('Visitors').getByText(formatNumber(after.total.visitors), { exact: true }).waitFor();
    await tile('Orders').getByText(formatNumber(after.total.orders), { exact: true }).waitFor();
    await tile('Order value')
      .getByText(money(after.total.revenueMinor, after.currency), { exact: true })
      .waitFor();
    const funnel = page.getByRole('list', { name: 'Shopper steps' });
    check((await funnel.getByRole('listitem').count()) === 5, 'the funnel does not have 5 steps');
    const ordered = funnel.getByRole('listitem').filter({ hasText: 'Ordered' });
    check(
      (await ordered.innerText()).includes(formatNumber(after.total.orders)),
      'the funnel does not show the orders',
    );
    const fb = page.getByRole('row').filter({ hasText: 'Facebook' });
    const fbApi = after.sources.find((x) => x.source === 'facebook');
    const fbCells = await fb.getByRole('cell').allInnerTexts();
    check(
      fbCells[1] === formatNumber(fbApi.visitors) && fbCells[2] === formatNumber(fbApi.orders),
      `the Facebook row shows ${fbCells.join(' | ')}`,
    );
    await page.getByRole('row').filter({ hasText: 'Instagram' }).waitFor();
    const panjabi = after.products.find((x) => x.name === 'Cotton Panjabi');
    const pCells = await page
      .getByRole('row')
      .filter({ hasText: 'Cotton Panjabi' })
      .getByRole('cell')
      .allInnerTexts();
    check(
      pCells[1] === formatNumber(panjabi.viewers) &&
        pCells[2] === formatNumber(panjabi.orders) &&
        pCells[3] === money(panjabi.revenueMinor, after.currency),
      `the Cotton Panjabi row shows ${pCells.join(' | ')}`,
    );
    await shot(page, '01-numbers-7-days', true);
  });

  await step("a chart's table view lists every day", async () => {
    await page.getByRole('button', { name: 'Show table' }).first().click();
    const table = page.locator('table').first();
    await table.waitFor();
    const rows = await table.locator('tbody tr').count();
    check(rows === 7, `the table lists ${rows} days, not 7`);
    await shot(page, '02-numbers-table');
    await page.getByRole('button', { name: 'Show chart' }).first().click();
  });

  await step('90 days asks the API for 90 days', async () => {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/stats?days=90')),
      page.getByRole('radio', { name: '90 days' }).click(),
    ]);
    check(res.status() === 200, `90 days answered ${res.status()}`);
    const body = await res.json();
    check(body.days.length === 90, 'the API did not send 90 days');
    await page
      .getByText(/than the 90 days before|in the 90 days before/)
      .first()
      .waitFor();
  });

  await step('the Numbers page on a phone, and in dark mode', async () => {
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      storageState: await ctx.storageState(),
    });
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/store/${store.id}/numbers`);
    await phone.getByText('How far shoppers got').waitFor({ timeout: 15_000 });
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    check(!overflow, 'the phone view scrolls sideways');
    await shot(phone, '03-numbers-phone', true);
    await phone.close();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await page.getByText('How far shoppers got').waitFor();
    await shot(page, '04-numbers-dark', true);
    await page.emulateMedia({ colorScheme: 'light' });
  });
} catch {
  failed = true;
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
  await mongo.close();
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
