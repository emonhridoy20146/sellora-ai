/* eslint-disable no-console -- a command-line report */
/**
 * Checks Products › Import and sync in a real browser, against a running web app, API and
 * worker and the shop stand-in (sellora-api/scripts/shop-stand-in.mjs, with
 * SYNC_ALLOW_PRIVATE_NETWORK=true in the API's .env). It is NOT a test against Shopify,
 * WooCommerce or Google: the stand-in answers in their shapes from demo products in memory.
 *
 * What it checks: a wrong Shopify key is explained; the check shows what will be imported;
 * adding a source imports it in the worker; synced products are marked and say what a sync
 * replaces; a price and stock change at the shop arrives with Sync now and is written to stock
 * history; WooCommerce, a sheet (with a bad row reported) and a CSV upload with a second
 * version; history; an outage fails the sync and says why; pausing; removing a source keeps
 * its products. It removes the sources and products it made, before and after.
 * Fails on console errors, unexpected API errors or a missing result.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/catalog-sync-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SHOP_STAND_IN_URL (http://localhost:4090).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SHOP = (env.SHOP_STAND_IN_URL ?? 'http://localhost:4090').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/catalog-sync';
mkdirSync(OUT, { recursive: true });

// The stand-in's demo keys (fake, printed on its own page).
const SHOPIFY_TOKEN = 'shpat_standin0000000000000000000000001';
const WOO_KEY = 'ck_standin00000000000000000000000000000001';
const WOO_SECRET = 'cs_standin00000000000000000000000000000001';
const CSV_V1 = 'Name,Price,SKU,Stock\nBamboo Tray,650,FLOW-TRAY,5\nJute Bag,300,FLOW-JUTE,8\n';
const CSV_V2 = 'Name,Price,SKU,Stock\nBamboo Tray,700,FLOW-TRAY,5\n';

const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

function watch(page, label, allowed = []) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !allowed.some((a) => m.text().includes(a)))
      problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    const path = new URL(r.url()).pathname;
    // The wrong key on purpose: the check answers 422.
    if (s === 422 && path.endsWith('/catalog-sources/check')) return;
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
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
}

async function shop(path) {
  const res = await fetch(`${SHOP}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`stand-in ${path} answered ${res.status}`);
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

const FLOW_SKUS = new Set([
  'JAM-RED',
  'JAM-BLUE',
  'KAN-CUSH',
  'PJ-M',
  'PJ-L',
  'PJ-XL',
  'SHAWL-1',
  'POT-1',
  'LG-GREEN',
  'LG-BLUE',
  'TP-M',
  'TP-L',
  'TP-XL',
  'GM-1',
  'BB-1',
  'FLOW-TRAY',
  'FLOW-JUTE',
]);

/** Removes every source and the products this flow imports (from this run or an earlier one). */
async function cleanUp(page, orgPath) {
  const orgId = orgPath.split('/').pop();
  const { items: sources } = await call(page, 'GET', `/orgs/${orgId}/catalog-sources`);
  for (const s of sources) await call(page, 'DELETE', `/orgs/${orgId}/catalog-sources/${s.id}`);
  let cursor;
  const doomed = [];
  do {
    const q = `?status=all&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const pageOf = await call(page, 'GET', `/orgs/${orgId}/products${q}`);
    for (const p of pageOf.items)
      if (p.variants.some((v) => v.sku && FLOW_SKUS.has(v.sku))) doomed.push(p.id);
    cursor = pageOf.nextCursor;
  } while (cursor);
  for (const id of doomed) await call(page, 'DELETE', `/orgs/${orgId}/products/${id}`);
  return { sources: sources.length, products: doomed.length };
}

const browser = await chromium.launch();
let failed = false;
let staff;

try {
  await shop('/__reset');
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  staff = await ctx.newPage();
  // The wrong key is refused on purpose; the browser logs that 422.
  watch(staff, 'staff', ['422']);
  let org;

  await step('sign in', async () => {
    await staff.goto(`${BASE}/login`);
    await staff.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await staff.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await staff.click('button[type=submit]');
    await staff.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(staff.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    const left = await cleanUp(staff, org);
    if (left.sources || left.products)
      console.log(
        `removed ${left.sources} sources and ${left.products} products from an earlier run`,
      );
  });

  const card = (name) => staff.locator('[data-testid^="source-"]').filter({ hasText: name });
  const dialog = () => staff.getByRole('dialog');
  /** Waits for the toast that ends a sync, and returns its text. */
  const toastWith = async (re, timeout = 30_000) => {
    const t = staff.locator('[data-sonner-toast]').filter({ hasText: re }).first();
    await t.waitFor({ timeout });
    return t.innerText();
  };

  await step('the empty page offers five kinds of source', async () => {
    await staff.goto(`${BASE}${org}/products/sync`);
    await staff.getByText('Already sell somewhere else?').waitFor();
    for (const k of ['Shopify', 'WooCommerce', 'Google Sheet', 'CSV file', 'Your website'])
      await staff.getByRole('button', { name: new RegExp(`^${k}`) }).waitFor();
    await staff.getByRole('link', { name: 'Import and sync' }).waitFor();
    await shot(staff, '01-empty');
  });

  await step(
    'Shopify: a wrong key is explained, the right one shows what will be imported',
    async () => {
      await staff.getByRole('button', { name: /^Shopify/ }).click();
      await dialog().getByRole('heading', { name: 'Add Shopify' }).waitFor();
      await staff.getByLabel('Shop address').fill(`${SHOP}/shopify`);
      await staff.getByLabel('Admin API access token').fill('shpat_wrongwrongwrongwrongwrong01');
      await dialog().getByRole('button', { name: 'Check' }).click();
      await dialog().getByText('Shopify refused the key. Check it and its permissions.').waitFor();
      await shot(staff, '02-shopify-wrong-key');
      await staff.getByLabel('Admin API access token').fill(SHOPIFY_TOKEN);
      await dialog().getByRole('button', { name: 'Check' }).click();
      await dialog().getByText('Nakshi Ghor on Shopify (stand-in)').waitFor();
      await dialog().getByText('4 products').waitFor();
      for (const n of ['Jamdani Saree', 'Nakshi Kantha Cushion Cover', 'Eid Panjabi'])
        await dialog()
          .getByRole('cell', { name: new RegExp(n) })
          .waitFor();
      await dialog().getByText('not active at the source').waitFor();
      await staff.getByLabel('Sync', { exact: true }).selectOption('60');
      await shot(staff, '03-shopify-check');
    },
  );

  await step('adding Shopify imports its active products in the worker', async () => {
    await dialog().getByRole('button', { name: 'Add and import' }).click();
    const text = await toastWith(/Shopify \(stand-in\): |Shopify.*failed/);
    if (!/3 added/.test(text)) throw new Error(`import said: ${text}`);
    await card('Nakshi Ghor on Shopify').getByText('Up to date').waitFor({ timeout: 10_000 });
    await card('Nakshi Ghor on Shopify').getByText('3', { exact: true }).waitFor();
    await card('Nakshi Ghor on Shopify')
      .getByText(/in 1 hour|in 60 minutes/)
      .waitFor();
    await shot(staff, '04-shopify-imported');
  });

  await step('a synced product is marked and says what a sync replaces', async () => {
    await staff.goto(`${BASE}${org}/products`);
    const row = staff
      .getByRole('row')
      .filter({ hasText: 'Jamdani Saree', has: staff.getByLabel('Synced from a source') });
    await row.waitFor();
    await row.getByLabel('Synced from a source').waitFor();
    if (!(await row.innerText()).includes('3,200')) throw new Error('price range missing');
    await row.getByRole('link', { name: /Jamdani Saree/ }).click();
    await staff.getByText('Synced from Nakshi Ghor on Shopify (stand-in)').waitFor();
    await staff
      .getByText(/name, description, prices, options, photos and stock are replaced/)
      .waitFor();
    const desc = await staff.locator('textarea').first().inputValue();
    if (!desc.startsWith('Hand-woven Dhakai jamdani from Rupganj.\n\n• 6 yards'))
      throw new Error(`description: ${desc.slice(0, 80)}`);
    await shot(staff, '05-product-synced', true);
  });

  await step('a price and stock change at the shop arrives with Sync now', async () => {
    await shop('/__price?sku=JAM-RED&price=2950');
    await shop('/__stock?sku=JAM-RED&qty=4');
    await staff.goto(`${BASE}${org}/products/sync`);
    await card('Nakshi Ghor on Shopify').getByRole('button', { name: 'Sync now' }).click();
    const text = await toastWith(/Shopify \(stand-in\): |had a problem/);
    if (!/1 updated/.test(text)) throw new Error(`sync said: ${text}`);
    await staff.goto(`${BASE}${org}/products`);
    const row = staff
      .getByRole('row')
      .filter({ hasText: 'Jamdani Saree', has: staff.getByLabel('Synced from a source') });
    await row.waitFor();
    if (!(await row.innerText()).includes('2,950')) throw new Error('new price not in the list');
    await row.getByRole('link', { name: /Jamdani Saree/ }).click();
    await staff.getByText('Synced from source').first().waitFor();
    await shot(staff, '06-after-sync', true);
  });

  await step('WooCommerce imports simple and variable products', async () => {
    await staff.goto(`${BASE}${org}/products/sync`);
    await staff.getByRole('button', { name: 'Add source' }).click();
    await dialog()
      .getByRole('button', { name: /^WooCommerce/ })
      .click();
    await staff.getByLabel('Shop address').fill(`${SHOP}/woo/wp-admin/`);
    await staff.getByLabel('Consumer key').fill(WOO_KEY);
    await staff.getByLabel('Consumer secret').fill(WOO_SECRET);
    await dialog().getByRole('button', { name: 'Check' }).click();
    await dialog()
      .getByRole('cell', { name: /Cotton Lungi/ })
      .waitFor();
    await dialog().getByText('2 variants (Colour)').waitFor();
    await dialog().getByRole('button', { name: 'Add and import' }).click();
    const text = await toastWith(/Nakshi Ghor on WooCommerce \(stand-in\): |WooCommerce.*failed/);
    if (!/2 added/.test(text)) throw new Error(`import said: ${text}`);
    await card('Nakshi Ghor on WooCommerce').getByText('Up to date').waitFor();
  });

  await step('a sheet: the columns used and a bad row are shown before importing', async () => {
    await staff.getByRole('button', { name: 'Add source' }).click();
    await dialog()
      .getByRole('button', { name: /^Google Sheet/ })
      .click();
    await staff.getByLabel('Link to the sheet').fill(`${SHOP}/sheet.csv`);
    await dialog().getByRole('button', { name: 'Check' }).click();
    await dialog().getByText('Columns used').waitFor();
    await dialog().getByText('Old price → Old price').waitFor();
    await dialog().getByText('Size → Option').waitFor();
    await dialog().getByText('The price "abc" is not a number.').waitFor();
    await dialog().getByText('Row 6 (Bamboo Basket):').waitFor();
    await dialog()
      .getByRole('cell', { name: /Lawn Three-Piece/ })
      .waitFor();
    await shot(staff, '07-sheet-check');
    await dialog().getByRole('button', { name: 'Add and import' }).click();
    const text = await toastWith(/Sheet1: |Sheet1.*failed/);
    if (!/2 added, 1 skipped/.test(text)) throw new Error(`import said: ${text}`);
    await card('Sheet1').getByText('Done with problems').waitFor();
  });

  await step(
    'a CSV file, then a new version that updates one product and archives the other',
    async () => {
      await staff.getByRole('button', { name: 'Add source' }).click();
      await dialog()
        .getByRole('button', { name: /^CSV file/ })
        .click();
      await staff.getByLabel('CSV file', { exact: true }).setInputFiles({
        name: 'flow-catalog.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(CSV_V1),
      });
      await dialog().getByText('flow-catalog.csv chosen').waitFor();
      await dialog().getByRole('button', { name: 'Check' }).click();
      await dialog()
        .getByRole('cell', { name: /Bamboo Tray/ })
        .waitFor();
      await dialog().getByRole('button', { name: 'Add and import' }).click();
      let text = await toastWith(/flow-catalog\.csv: |flow-catalog\.csv.*failed/);
      if (!/2 added/.test(text)) throw new Error(`import said: ${text}`);
      await card('flow-catalog.csv').getByText('When you upload a new version').waitFor();
      await card('flow-catalog.csv')
        .getByLabel('New version of flow-catalog.csv')
        .setInputFiles({
          name: 'flow-catalog-v2.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(CSV_V2),
        });
      text = await toastWith(/flow-catalog\.csv: .*(updated|archived)|flow-catalog\.csv.*failed/);
      if (!/1 updated/.test(text) || !/1 archived/.test(text))
        throw new Error(`upload said: ${text}`);
      await shot(staff, '08-sources');
    },
  );

  await step('history lists each sync with what it did', async () => {
    await card('Nakshi Ghor on Shopify').getByRole('button', { name: 'History' }).click();
    await dialog().getByText('First import').waitFor();
    await dialog().getByText('Sync now').first().waitFor();
    await dialog()
      .getByText(/1 updated, 3 unchanged/)
      .waitFor();
    await shot(staff, '09-history');
    await staff.keyboard.press('Escape');
  });

  await step('an outage fails the sync and says why; the next sync recovers', async () => {
    await shop('/__fail?shop=shopify&status=500');
    await card('Nakshi Ghor on Shopify').getByRole('button', { name: 'Sync now' }).click();
    await toastWith(/Shopify had a problem \(HTTP 500\)\./);
    await card('Nakshi Ghor on Shopify').getByText('Failed').first().waitFor();
    await shot(staff, '10-failed');
    await shop('/__fail?shop=shopify&status=0');
    await card('Nakshi Ghor on Shopify').getByRole('button', { name: 'Sync now' }).click();
    await toastWith(/Nakshi Ghor on Shopify.*unchanged/);
    await card('Nakshi Ghor on Shopify').getByText('Up to date').waitFor();
  });

  await step('pausing a source stops its schedule', async () => {
    await card('Nakshi Ghor on Shopify')
      .getByRole('button', { name: /^Settings for/ })
      .click();
    await dialog()
      .getByRole('switch', { name: /Pause syncing/ })
      .click();
    await shot(staff, '11-settings');
    await dialog().getByRole('button', { name: 'Save' }).click();
    await card('Nakshi Ghor on Shopify').getByText('Paused').first().waitFor();
    await card('Nakshi Ghor on Shopify')
      .getByRole('button', { name: /^Settings for/ })
      .click();
    await dialog()
      .getByRole('switch', { name: /Pause syncing/ })
      .click();
    await dialog().getByRole('button', { name: 'Save' }).click();
    await card('Nakshi Ghor on Shopify').getByText('Up to date').waitFor();
  });

  await step('dark mode and a phone', async () => {
    await staff.emulateMedia({ colorScheme: 'dark' });
    await shot(staff, '12-dark', true);
    await staff.emulateMedia({ colorScheme: 'light' });
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    await phone.context().addCookies(await ctx.cookies());
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/products/sync`);
    await phone.locator('[data-testid^="source-"]').first().waitFor();
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 1) throw new Error(`the page scrolls sideways by ${overflow}px on a phone`);
    await shot(phone, '13-phone', true);
    await phone.close();
  });

  await step('removing a source keeps its products as ordinary products', async () => {
    await card('Nakshi Ghor on WooCommerce')
      .getByRole('button', { name: /^Remove/ })
      .click();
    await dialog().getByRole('button', { name: 'Remove source' }).click();
    await toastWith(/Its 2 products stay as ordinary products/);
    await staff.goto(`${BASE}${org}/products`);
    const row = staff.getByRole('row').filter({ hasText: 'Clay Pot' });
    await row.waitFor();
    if (await row.getByLabel('Synced from a source').count())
      throw new Error('still marked as synced');
  });

  await step('clean up', async () => {
    await cleanUp(staff, org);
    await shop('/__reset');
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
