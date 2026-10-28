/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through an online store's whole life in a real browser, against a running web app,
 * API, worker and storefront app (sellora-storefront on STOREFRONT_PORT). The merchant
 * account should own one business with active products and delivery zones: `npm run
 * dev:seed` in sellora-api makes one (Nakshi Ghor, shop@demo.sellora.test). Its product
 * pictures are generated patterns, not photos.
 *
 * What it checks: the empty store page; the create wizard (a reserved address refused, the
 * suggested theme, a palette); the draft overview with its checklist; the design editor (a
 * hero picture uploaded, text changed, an announcement, a section hidden and saved); store
 * details (WhatsApp, Facebook link, an invalid link refused); sending for review; the signed
 * preview link opening the draft store; the super-admin's queue, review page and approval;
 * shopping as a visitor on desktop and phone (home, category, product, cart, checkout, the
 * receipt, order tracking); the order arriving in the dashboard as an online-store order;
 * pausing (shoppers see a closed note) and reopening; and the store in Bangla. Fails on
 * console errors, unexpected API errors or a missing result. Deletes the business's
 * existing stores first and leaves one open store behind.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… \
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
 *   node scripts/stores-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SMOKE_OUT (smoke-output/stores),
 * STORE_HANDLE (nakshi-ghor).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/stores';
const HANDLE = env.STORE_HANDLE ?? 'nakshi-ghor';
mkdirSync(OUT, { recursive: true });

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

/** A wide PNG for the hero: a warm gradient with woven stripes, drawn here (no photo needed). */
function heroPng(width = 1600, height = 640) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const t = x / width;
      const stripe = (Math.floor((x + y) / 28) % 5 === 0) * 0.18;
      const r = Math.round(122 + 80 * t + 40 * stripe);
      const g = Math.round(31 + 70 * t * t + 60 * stripe);
      const b = Math.round(43 + 10 * t + 30 * stripe);
      const i = row + 1 + x * 3;
      raw[i] = Math.min(255, r);
      raw[i + 1] = Math.min(255, g);
      raw[i + 2] = Math.min(255, b);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Responses the flow causes on purpose, and the console lines the browser logs for them.
const expected = [];
let consoleAllowance = 0;
function expectError(status, path) {
  expected.push({ status, path });
  consoleAllowance += 1;
}
function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/status of 4\d\d/.test(text) && consoleAllowance > 0) {
      consoleAllowance -= 1;
      return;
    }
    problems.push(`${label} console: ${text.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    const url = r.url();
    const ours = url.includes('/v1/') || url.includes('/api/');
    if (!(s >= 500 || (s >= 400 && s !== 401 && ours))) return;
    const path = new URL(url).pathname;
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

/** A tab of the store editor (the sidebar has links with the same names). */
const tab = (name) =>
  page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name, exact: true });

function check(cond, message) {
  if (!cond) throw new Error(message);
}

const heroFile = join(OUT, 'hero-input.png');
writeFileSync(heroFile, heroPng());

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
watch(page, 'merchant');
let failed = false;
let org;
let orgId;
let store;
let orderNumber;
const shopperPhone = `018${String(Date.now()).slice(-8)}`;

try {
  await step('sign in and clear earlier stores', async () => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    const { items } = await call(page, 'GET', `/orgs/${orgId}/stores`);
    for (const s of items) {
      check(s.status !== 'suspended', `${s.name} is suspended; reinstate it before this check`);
      await call(page, 'DELETE', `/orgs/${orgId}/stores/${s.id}`);
    }
    const products = await call(page, 'GET', `/orgs/${orgId}/products?status=active&limit=5`);
    check(products.items.length > 0, 'the business needs active products (run npm run dev:seed)');
  });

  await step('online store page, empty', async () => {
    await page.goto(`${BASE}${org}/store`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Open your online store' }).waitFor();
    await shot(page, '01-store-empty');
  });

  await step('wizard: name and address, a reserved address refused', async () => {
    await page.getByRole('link', { name: 'Create store' }).click();
    await page.waitForURL(/\/store\/new$/);
    await page.fill('#store-name', 'Nakshi Ghor');
    await page.fill('#store-handle', 'checkout');
    await page.getByText('This address is kept for Sellora').waitFor({ timeout: 10_000 });
    await shot(page, '02-wizard-reserved');
    await page.fill('#store-handle', HANDLE);
    await page.getByLabel('Available').waitFor({ timeout: 10_000 });
    await page.getByText(`${HANDLE}.`).first().waitFor();
    await shot(page, '03-wizard-name');
    await page.getByRole('button', { name: 'Next' }).click();
  });

  await step('wizard: theme and palette, create', async () => {
    await page.getByRole('radiogroup', { name: 'Theme' }).waitFor();
    const nakshi = page.getByRole('radio', { name: /^Nakshi/ });
    check(
      (await nakshi.getAttribute('aria-checked')) === 'true',
      'the Nakshi theme should be suggested and picked for a handicrafts shop',
    );
    await page.getByRole('button', { name: 'Nakshi: Maroon and gold' }).click();
    await shot(page, '04-wizard-theme', true);
    await page.getByRole('button', { name: 'Create store' }).click();
    await page.waitForURL(/\/store\/[a-f0-9]{24}$/, { timeout: 15_000 });
    await page.getByText('Draft', { exact: true }).first().waitFor();
    const id = page.url().split('/').pop();
    store = await call(page, 'GET', `/orgs/${orgId}/stores/${id}`);
    check(store.handle === HANDLE, `the store address is ${store.handle}`);
    check(store.readiness.ready, 'the new store should be ready (products and the org phone)');
    await shot(page, '05-store-draft');
  });

  await step('design: hero picture, text, announcement, hide a section', async () => {
    await tab('Design').click();
    await page.getByRole('heading', { name: 'Home page' }).waitFor();
    await page.getByRole('button', { name: 'Edit Hero' }).click();
    const heading = page.locator('[id$="-heading"]').first();
    await heading.fill('Handwoven in Bangladesh');
    await page.locator('[id$="-sub"]').first().fill('Jamdani, kantha and jute, made by hand.');
    await page.locator('input[type=file]').last().setInputFiles(heroFile);
    await page.getByRole('button', { name: 'Change' }).last().waitFor({ timeout: 20_000 });
    await page.fill('#announcement', 'Free delivery inside Dhaka this week');
    await page.getByRole('switch', { name: 'Show Product row section' }).last().click();
    await shot(page, '06-design-editing', true);
    await page.getByRole('button', { name: 'Save design' }).click();
    await page.getByText('All changes saved.').waitFor({ timeout: 15_000 });
    store = await call(page, 'GET', `/orgs/${orgId}/stores/${store.id}`);
    const hero = store.theme.sections.find((s) => s.type === 'hero');
    check(hero.image?.fileId, 'the hero picture was not saved');
    check(hero.heading === 'Handwoven in Bangladesh', 'the hero heading was not saved');
    check(
      store.theme.sections.filter((s) => !s.enabled).length === 1,
      'one section should be hidden',
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '07-design-saved');
  });

  await step('details: WhatsApp and Facebook, a bad link refused', async () => {
    await tab('Details').click();
    await page.fill('#d-whatsapp', '01711000111');
    await page.fill('#d-facebook', 'facebook.com/nakshighor');
    expectError(422, /\/stores\/[a-f0-9]{24}$/);
    await page.getByRole('button', { name: 'Save details' }).click();
    await page.getByText('Use a full https:// link').waitFor({ timeout: 10_000 });
    await page.fill('#d-facebook', 'https://facebook.com/nakshighor');
    await page.getByRole('button', { name: 'Save details' }).click();
    await page.getByText('Saved.').first().waitFor({ timeout: 10_000 });
    store = await call(page, 'GET', `/orgs/${orgId}/stores/${store.id}`);
    check(store.social.facebook === 'https://facebook.com/nakshighor', 'Facebook not saved');
    await shot(page, '08-details', true);
  });

  await step('send for review', async () => {
    await tab('Overview').click();
    await page.getByRole('button', { name: 'Send for review' }).click();
    await page.getByText('In review').first().waitFor({ timeout: 10_000 });
    await shot(page, '09-in-review');
  });

  await step('preview link opens the draft store', async () => {
    const [previewTab] = await Promise.all([
      ctx.waitForEvent('page'),
      page.getByRole('button', { name: 'Preview' }).first().click(),
    ]);
    watch(previewTab, 'preview');
    await previewTab.waitForURL((u) => u.hostname.startsWith(`${HANDLE}.`), { timeout: 15_000 });
    await previewTab.waitForLoadState('networkidle');
    await previewTab.getByText('Preview: shoppers cannot see this store yet.').waitFor();
    await previewTab.getByRole('heading', { name: 'Handwoven in Bangladesh' }).waitFor();
    await shot(previewTab, '10-preview', true);
    await previewTab.close();
  });

  await step('a shopper sees "opening soon" before approval', async () => {
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await visitor.newPage();
    watch(p, 'visitor');
    await p.goto(store.url, { waitUntil: 'networkidle' });
    await p.getByText('Opening soon').waitFor();
    await shot(p, '11-coming-soon');
    await visitor.close();
  });

  await step('super-admin approves it from the queue', async () => {
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
    await admin.goto(`${BASE}/admin/stores`, { waitUntil: 'networkidle' });
    await admin.getByRole('link', { name: 'Nakshi Ghor' }).first().waitFor();
    await shot(admin, '12-admin-queue');
    await admin.getByRole('link', { name: 'Nakshi Ghor' }).first().click();
    await admin.getByRole('heading', { name: 'Decision' }).waitFor();
    await shot(admin, '13-admin-review', true);
    await admin.getByRole('button', { name: 'Approve and open' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Approve and open' }).click();
    await admin.getByText('Store approved.').waitFor({ timeout: 10_000 });
    await admin.getByText('Open', { exact: true }).first().waitFor();
    await shot(admin, '14-admin-approved');
    await actx.close();
  });

  await step('shopper: home, category and product on a phone', async () => {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const p = await phone.newPage();
    watch(p, 'phone');
    await p.goto(store.url, { waitUntil: 'networkidle' });
    await p.getByRole('heading', { name: 'Handwoven in Bangladesh' }).waitFor();
    await p.getByText('Free delivery inside Dhaka this week').waitFor();
    await shot(p, '15-phone-home', true);
    await p.goto(`${store.url}/products?category=sarees`, { waitUntil: 'networkidle' });
    await shot(p, '16-phone-category', true);
    await p.goto(`${store.url}/products/dhakai-jamdani-saree`, { waitUntil: 'networkidle' });
    await shot(p, '17-phone-product', true);
    await phone.close();
  });

  await step('shopper: cart, checkout, receipt and tracking', async () => {
    const shopper = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await shopper.newPage();
    watch(p, 'shopper');
    await p.goto(store.url, { waitUntil: 'networkidle' });
    await shot(p, '18-desktop-home', true);
    await p.goto(`${store.url}/products/cotton-panjabi`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'L', exact: true }).click();
    await p.getByRole('button', { name: 'Add to cart' }).click();
    await p.goto(`${store.url}/products/nakshi-kantha-throw`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Add to cart' }).click();
    await p.goto(`${store.url}/cart`, { waitUntil: 'networkidle' });
    await p.getByText('Nakshi Kantha Throw').first().waitFor();
    await shot(p, '19-cart', true);
    await p.getByRole('link', { name: 'Checkout' }).first().click();
    await p.waitForURL('**/checkout');
    await p.getByLabel('Full name').fill('Farhana Rahman');
    await p.getByLabel('Mobile number').fill(shopperPhone);
    await p.getByLabel('House, road, village').fill('House 12, Road 5, Dhanmondi');
    await p.getByLabel('City').fill('Dhaka');
    await p.getByLabel('Inside Dhaka').check();
    await shot(p, '20-checkout', true);
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkout'),
      p.getByRole('button', { name: /Place order/ }).click(),
    ]);
    check(placed.status() === 201, `checkout answered ${placed.status()}`);
    orderNumber = (await placed.json()).orderNumber;
    await p.waitForURL('**/order?**', { timeout: 15_000 });
    await p.getByRole('heading', { name: 'Thank you for your order!' }).waitFor();
    await p.getByText(orderNumber).first().waitFor();
    await shot(p, '21-receipt', true);
    await p.goto(`${store.url}/track`, { waitUntil: 'networkidle' });
    await p.fill('#track-number', orderNumber);
    await p.fill('#track-phone', shopperPhone);
    await p.getByRole('button', { name: 'Track', exact: true }).click();
    await p.getByText('Waiting for confirmation').first().waitFor({ timeout: 10_000 });
    await shot(p, '22-track', true);
    await shopper.close();
  });

  await step('the order arrives in the dashboard', async () => {
    await page.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    await page.getByText(orderNumber).first().waitFor({ timeout: 10_000 });
    await shot(page, '23-store-open-with-order', true);
    await page.getByText(orderNumber).first().click();
    await page.getByText(/· Online store/).waitFor({ timeout: 10_000 });
    await shot(page, '24-order-from-store');
  });

  await step('pause shows shoppers a closed note; reopen', async () => {
    await page.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Pause store' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pause store' }).click();
    await page.getByText('Store paused.').waitFor({ timeout: 10_000 });
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const v = await visitor.newPage();
    watch(v, 'visitor');
    await v.goto(store.url, { waitUntil: 'networkidle' });
    await v.getByText('Taking a short break').waitFor();
    await shot(v, '25-paused');
    await page.getByRole('button', { name: 'Reopen store' }).click();
    await page.getByText('Store reopened.').waitFor({ timeout: 10_000 });
    await v.goto(store.url, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: 'Handwoven in Bangladesh' }).waitFor();
    await visitor.close();
  });

  await step('the store in Bangla', async () => {
    await call(page, 'PATCH', `/orgs/${orgId}/stores/${store.id}`, { language: 'bn' });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await phone.newPage();
    watch(p, 'bangla');
    await p.goto(`${store.url}/products/dhakai-jamdani-saree`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'কার্টে যোগ করুন' }).waitFor();
    await shot(p, '26-bangla-product', true);
    await phone.close();
    await call(page, 'PATCH', `/orgs/${orgId}/stores/${store.id}`, { language: 'en' });
  });
} catch (err) {
  failed = true;
  console.error(`\nStopped: ${String(err).split('\n')[0]}`);
  await shot(page, 'zz-failure', true).catch(() => {});
} finally {
  await browser.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? ` (${s.ms} ms)` : `: ${s.error}`}`);
if (expected.length)
  problems.push(`expected errors that did not happen: ${expected.map((e) => e.path).join(', ')}`);
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`  ${p}`);
}
console.log(`\nScreenshots in ${OUT}/`);
process.exit(failed || problems.length ? 1 : 0);
