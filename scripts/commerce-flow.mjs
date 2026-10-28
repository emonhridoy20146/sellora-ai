/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through the selling flow in a real browser against a running web app and API:
 * delivery zones, a product with sizes, a simple product, a manual order with discount and
 * part payment, packing, payment, stock check, invoice and packing slip, a pending order
 * that is cancelled, the customer page, phone and dark-mode views. Fails on console
 * errors, unexpected API errors or a step that does not show the expected result.
 * Creates real data in the signed-in business (names carry a timestamp).
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/commerce-flow.mjs
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/commerce';
mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36).slice(-5);
const phone = `0171${String(Date.now()).slice(-7)}`;
const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
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

async function shot(page, name, fullPage = true) {
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

const browser = await chromium.launch();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  const org = await login(page);
  let kurtiUrl = '';
  let orderUrl = '';

  await step('set delivery zones', async () => {
    await page.goto(`${BASE}${org}/settings/selling`, { waitUntil: 'networkidle' });
    if ((await page.locator('#z0-name').count()) === 0) {
      await page.getByRole('button', { name: 'Add zone' }).click();
      await page.fill('#z0-name', 'Inside Dhaka');
      await page.fill('#z0-charge', '60');
      await page.getByRole('button', { name: 'Add zone' }).click();
      await page.fill('#z1-name', 'Outside Dhaka');
      await page.fill('#z1-charge', '120');
    }
    await page.fill('#invoice-note', 'Thank you for shopping with us. Exchange within 3 days.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved.').waitFor();
    await shot(page, '01-settings-selling');
  });

  await step('add a product with sizes', async () => {
    await page.goto(`${BASE}${org}/products/new`, { waitUntil: 'networkidle' });
    await page.fill('#p-name', `Flow Kurti ${stamp}`);
    await page.fill('#p-desc', 'Cotton kurti. Size chart: S 36", M 38".');
    await page.fill('#p-tags', 'eid, cotton');
    await page.getByText('This product comes in sizes').click();
    await page.fill('#o0-values', 'S, M');
    await page.locator('#v1-price').waitFor();
    await page.fill('#v0-price', '1200');
    await page.fill('#v1-price', '1250');
    await page.fill('#v0-stock', '5');
    await page.fill('#v1-stock', '3');
    await page.fill('#v0-sku', `FK-${stamp}-S`);
    await page.fill('#v1-sku', `FK-${stamp}-M`);
    await shot(page, '02-product-new-variants');
    await page.getByRole('button', { name: 'Add product' }).click();
    await page.waitForURL(/\/products\/[a-f0-9]{24}$/, { timeout: 15_000 });
    kurtiUrl = new URL(page.url()).pathname;
    await page.getByText('Stock history').waitFor();
    await page.getByText('Opening stock').first().waitFor();
    await shot(page, '03-product-page');
  });

  await step('upload photos to the product', async () => {
    await page.goto(`${BASE}${kurtiUrl}`, { waitUntil: 'networkidle' });
    // Two large phone-sized photos, drawn in the page so no image files are needed.
    const photos = await page.evaluate(() =>
      [20, 200].map((hue) => {
        const c = document.createElement('canvas');
        c.width = 2400;
        c.height = 1800;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 2400, 1800);
        grad.addColorStop(0, `hsl(${hue} 70% 55%)`);
        grad.addColorStop(1, `hsl(${hue + 60} 70% 35%)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 2400, 1800);
        g.fillStyle = 'white';
        g.font = 'bold 220px sans-serif';
        g.fillText(hue === 20 ? 'Front' : 'Back', 200, 400);
        return c.toDataURL('image/png').split(',')[1];
      }),
    );
    const input = page.locator('input[type=file]');
    await input.setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a photo'),
    });
    await page.getByText('Only photos can be added here.').waitFor();
    await input.setInputFiles([
      { name: 'front.png', mimeType: 'image/png', buffer: Buffer.from(photos[0], 'base64') },
      { name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(photos[1], 'base64') },
    ]);
    const stored = page.locator('ul[aria-label="Product photos"] img[src*="/v1/storage/"]');
    await stored.nth(1).waitFor({ timeout: 30_000 });
    // Shrunk before upload: 2400 px wide becomes 1600.
    const width = await stored
      .first()
      .evaluate((img) =>
        img.complete && img.naturalWidth
          ? img.naturalWidth
          : new Promise((r) => (img.onload = () => r(img.naturalWidth))),
      );
    if (width !== 1600) throw new Error(`uploaded photo is ${width}px wide, expected 1600`);
    const backSrc = await stored.nth(1).getAttribute('src');
    await page.getByRole('button', { name: 'Make main' }).first().click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('Saved.').waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    const main = await page
      .locator('ul[aria-label="Product photos"] img')
      .first()
      .getAttribute('src');
    if (main !== backSrc) throw new Error('the chosen main photo was not saved first');
    await shot(page, '03b-product-photos');
  });

  await step('add a simple product', async () => {
    await page.goto(`${BASE}${org}/products/new`, { waitUntil: 'networkidle' });
    await page.fill('#p-name', `Flow Scarf ${stamp}`);
    await page.fill('#v0-price', '450');
    await page.fill('#v0-stock', '10');
    await page.getByRole('button', { name: 'Add product' }).click();
    await page.waitForURL(/\/products\/[a-f0-9]{24}$/, { timeout: 15_000 });
    await page.goto(`${BASE}${org}/products`, { waitUntil: 'networkidle' });
    await page.getByText(`Flow Scarf ${stamp}`).waitFor();
    await shot(page, '04-products-list');
  });

  await step('create a manual order', async () => {
    await page.goto(`${BASE}${org}/orders/new`, { waitUntil: 'networkidle' });
    await page.fill('#picker', `Flow Kurti ${stamp}`);
    await page.getByRole('button', { name: /^S\s/ }).click();
    await page.fill('#picker', `Flow Scarf ${stamp}`);
    await page.getByRole('button', { name: /^Add\s/ }).click();
    await page.getByRole('button', { name: `One more Flow Scarf ${stamp}` }).click();
    await page.fill('#o-name', 'Flow Customer');
    await page.fill('#o-phone', phone);
    await page.fill('#o-addr-line1', 'House 1, Road 2');
    await page.fill('#o-addr-area', 'Mirpur');
    await page.fill('#o-addr-city', 'Dhaka');
    await page.fill('#o-discount', '50');
    await page.selectOption('#o-method', 'bkash');
    await page.fill('#o-paid', '200');
    await page.fill('#o-ref', `BK${stamp}`);
    // 1200 + 2 x 450 - 50 + 60 delivery = 2110
    await page.getByText('2,110').first().waitFor();
    await shot(page, '05-order-new');
    await page.getByRole('button', { name: 'Create order' }).click();
    await page.waitForURL(/\/orders\/[a-f0-9]{24}$/, { timeout: 15_000 });
    orderUrl = new URL(page.url()).pathname;
    await page.getByText('Confirmed', { exact: true }).first().waitFor();
    await page.getByText('Part paid').first().waitFor();
    await shot(page, '06-order-detail');
  });

  await step('stock was taken for the order', async () => {
    await page.goto(`${BASE}${kurtiUrl}`, { waitUntil: 'networkidle' });
    await page
      .getByRole('link', { name: /^SL-\d+/ })
      .first()
      .waitFor();
    const stockCard = page.locator('li', { hasText: /^S/ }).filter({ hasText: 'Change' }).first();
    const text = await stockCard.innerText();
    if (!/\b4\b/.test(text)) throw new Error(`Size S should show 4 in stock, saw: ${text}`);
    await shot(page, '07-product-after-order');
  });

  await step('pack the order and take full payment', async () => {
    await page.goto(`${BASE}${orderUrl}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Mark packed' }).click();
    await page.getByText('Packed', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Update' }).click();
    await page.getByRole('button', { name: 'Paid in full' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByText('Paid', { exact: true }).first().waitFor();
    await shot(page, '08-order-packed-paid');
  });

  await step('edit items on the packed order', async () => {
    await page.getByRole('button', { name: 'Edit items' }).click();
    await page.getByRole('button', { name: `One less Flow Scarf ${stamp}` }).click();
    await page.getByRole('button', { name: 'Save items' }).click();
    await page.getByText('Items and stock updated.').waitFor();
    // It was paid in full before one scarf (450) was removed: 450 is owed back.
    await page.getByText(/paid .450 more than the order now costs/).waitFor();
    await shot(page, '09-order-items-edited');
    await page.getByRole('button', { name: 'I refunded it' }).click();
    await page.getByText('Refund recorded.').waitFor();
  });

  await step('print the invoice and packing slip', async () => {
    const id = orderUrl.split('/').pop();
    await page.goto(`${BASE}${org}/orders/print?doc=invoice&ids=${id}`, {
      waitUntil: 'networkidle',
    });
    await page.getByText('Invoice', { exact: true }).first().waitFor();
    await page.getByText('Exchange within 3 days').waitFor();
    await shot(page, '10-invoice');
    await page.emulateMedia({ media: 'print' });
    await shot(page, '11-invoice-print-media');
    await page.emulateMedia({ media: 'screen' });
    await page.goto(`${BASE}${org}/orders/print?doc=slip&ids=${id}`, {
      waitUntil: 'networkidle',
    });
    await page.getByText('Collect on delivery').waitFor();
    await shot(page, '12-packing-slip');
  });

  await step('a pending order can be cancelled with a reason', async () => {
    await page.goto(`${BASE}${org}/orders/new`, { waitUntil: 'networkidle' });
    await page.fill('#picker', `Flow Scarf ${stamp}`);
    await page.getByRole('button', { name: /^Add\s/ }).click();
    await page.fill('#cust-search', phone.slice(0, 8));
    await page.getByRole('button', { name: /Flow Customer/ }).click();
    await page.getByText('Confirm now').click();
    await page.getByRole('button', { name: 'Create order' }).click();
    await page.waitForURL(/\/orders\/[a-f0-9]{24}$/, { timeout: 15_000 });
    await page.getByText('Pending orders do not hold stock').waitFor();
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await page.fill('#confirm-reason', 'Customer did not answer the phone');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
    await page.getByText('Cancelled: Customer did not answer the phone').waitFor();
    await shot(page, '13-order-cancelled');
  });

  await step('customer page shows both orders', async () => {
    await page.goto(`${BASE}${org}/customers`, { waitUntil: 'networkidle' });
    await page.fill('#c-search', phone);
    await page.getByRole('link', { name: 'Flow Customer' }).first().click();
    await page.waitForURL(/\/customers\/[a-f0-9]{24}$/);
    // Exact: the delivery risk card's reasons also mention cancelled orders.
    await page.getByText('1 cancelled', { exact: true }).waitFor();
    await shot(page, '14-customer');
  });

  await step('orders list with selection', async () => {
    await page.goto(`${BASE}${org}/orders`, { waitUntil: 'networkidle' });
    await page
      .getByRole('checkbox', { name: /Select order/ })
      .first()
      .click();
    await page.getByText('1 selected').waitFor();
    await shot(page, '15-orders-list');
  });

  await ctx.close();

  await step('phone layout', async () => {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const m = await mobile.newPage();
    watch(m, 'mobile');
    await login(m);
    await m.goto(`${BASE}${orderUrl}`, { waitUntil: 'networkidle' });
    await m.getByText('Deliver to').first().waitFor();
    await shot(m, '16-mobile-order');
    await m.goto(`${BASE}${org}/orders/new`, { waitUntil: 'networkidle' });
    await shot(m, '17-mobile-order-new');
    const width = await m.evaluate(() => document.documentElement.scrollWidth);
    if (width > 390) throw new Error(`New order page scrolls sideways on a phone (${width}px)`);
    await mobile.close();
  });

  await step('dark mode', async () => {
    const dark = await browser.newContext({
      viewport: { width: 1360, height: 900 },
      colorScheme: 'dark',
    });
    const d = await dark.newPage();
    watch(d, 'dark');
    await login(d);
    await d.goto(`${BASE}${org}/orders`, { waitUntil: 'networkidle' });
    await shot(d, '18-dark-orders');
    await d.goto(`${BASE}${kurtiUrl}`, { waitUntil: 'networkidle' });
    await shot(d, '19-dark-product');
    await dark.close();
  });
} catch {
  failed = true;
} finally {
  await browser.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.error ? `\n     ${s.error}` : ''}`);
if (problems.length) {
  console.log('\nProblems seen while running:');
  for (const p of problems) console.log(`  - ${p}`);
}
console.log(`\nScreenshots in ${OUT}`);
process.exit(failed || problems.length ? 1 : 0);
