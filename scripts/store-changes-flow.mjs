/* eslint-disable no-console -- a command-line report */
/**
 * Checks the review of changes made after a store was approved (ADR 0028) in real browsers,
 * against a running web app, API and storefront app (sellora-storefront on port 3100).
 *
 * What it checks: the business changes the About page of its open store and shoppers see the
 * new words at once; the store shows up in the super-admin's "Changed since approval" queue
 * with the words before and now and the automatic warning; the super-admin asks for a fix,
 * the owner gets the request by email (the dev outbox in MongoDB, from sellora-api/.env)
 * and sees it on the store page while the store stays open; the business fixes the text; the
 * super-admin sees that it changed after the request, has no warnings left and marks it fine,
 * and the queue is empty; phone and dark views. Puts the About page back as it was and leaves
 * nothing in the queue. Fails on console errors, unexpected API errors or a missing result.
 *
 * Needs the demo business with a live store (shop@demo.sellora.test after stores-flow) and
 * platform admin details.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/store-changes-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), STORE_HANDLE (nakshi-ghor),
 * SELLORA_API_DIR (../sellora-api), SMOKE_OUT.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const API_DIR = resolve(env.SELLORA_API_DIR ?? '../sellora-api');
const OUT = env.SMOKE_OUT ?? 'smoke-output/store-changes';
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
    if (m.type() === 'error') problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message.slice(0, 200)}`));
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

/** The API's own database, read only, for the email the owner was sent. */
function apiEnv() {
  const out = {};
  for (const line of readFileSync(join(API_DIR, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const { MongoClient } = createRequire(join(API_DIR, 'package.json'))('mongodb');
const dbEnv = apiEnv();
const mongo = await MongoClient.connect(dbEnv.MONGODB_URI);
const db = mongo.db(dbEnv.MONGODB_DB_NAME);

const FLAGGED = 'Handwoven sarees and panjabis. We now also sell master copy designer bags.';
const FIXED = 'Handwoven sarees and panjabis from weavers in Tangail and Narayanganj.';
const REASON = 'Please remove the "master copy designer bags": copies of brands are not allowed.';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
watch(page, 'merchant');
const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await actx.newPage();
watch(admin, 'admin');
let failed = false;
let org;
let orgId;
let store;
let originalAbout = '';
let started;

/** Accepts whatever is waiting for this store, so the run starts and ends with nothing. */
const acceptAll = async () => {
  const detail = await call(admin, 'GET', `/platform/stores/${store.id}`);
  if (detail.changes)
    await call(admin, 'POST', `/platform/stores/${store.id}/changes/accept`, {
      lastChangeAt: detail.changes.lastAt,
    });
};

const saveAbout = async (text) => {
  await page.goto(`${BASE}${org}/store/${store.id}/pages`, { waitUntil: 'networkidle' });
  await page.fill('#page-about', text);
  await page.getByRole('button', { name: 'Save pages' }).click();
  await page.getByText('Saved.').first().waitFor({ timeout: 10_000 });
};

try {
  await step('sign in as the business and as the super-admin', async () => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    const { items } = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = items.find((s) => s.handle === HANDLE);
    check(store?.status === 'live', `${HANDLE} must be an open store (run stores-flow first)`);
    originalAbout = store.pages.about;

    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    await admin.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
    await admin.click('button[type=submit]');
    await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });
    // Start from an empty queue and a kept copy of the store's words: a store approved before
    // copies were kept has none until its first accepted change, so touch the search title
    // and accept it (twice, to put the title back).
    const title = store.seo.title;
    for (const next of [`${title || store.name} ·`, title]) {
      await call(page, 'PATCH', `/orgs/${orgId}/stores/${store.id}`, { seo: { title: next } });
      await acceptAll();
    }
    started = new Date();
  });

  await step('the business changes its About page; shoppers see it at once', async () => {
    await saveAbout(FLAGGED);
    const shopper = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await shopper.newPage();
    watch(p, 'shopper');
    await p.goto(`${store.url}/pages/about`, { waitUntil: 'networkidle' });
    await p.getByText('master copy designer bags', { exact: false }).first().waitFor();
    await shopper.close();
  });

  await step('the super-admin finds it under "Changed since approval"', async () => {
    await admin.goto(`${BASE}/admin/stores`, { waitUntil: 'networkidle' });
    await admin.getByRole('radio', { name: /^Changed since approval \(\d+\)$/ }).click();
    const row = admin.getByRole('row').filter({ hasText: 'Nakshi Ghor' });
    await row.waitFor({ timeout: 10_000 });
    check((await row.innerText()).includes('Pages'), 'the row does not say the pages changed');
    check((await row.innerText()).includes('1 warning'), 'the row does not show the warning');
    await shot(admin, '01-admin-changed-queue');
    await row.getByRole('link', { name: 'Nakshi Ghor' }).first().click();
    await admin.getByText('Changed since approval', { exact: true }).waitFor();
    const words = admin.getByRole('list', { name: 'Words changed' });
    await words.getByText(FLAGGED).waitFor();
    if (originalAbout) await words.getByText(originalAbout.split('\n')[0]).first().waitFor();
    await admin.getByText('master copy', { exact: true }).first().waitFor();
    await shot(admin, '02-admin-changes', true);
  });

  await step('the super-admin asks for a fix; the store stays open', async () => {
    await admin.getByRole('button', { name: 'Ask for a fix' }).click();
    const dialog = admin.getByRole('dialog');
    await dialog.locator('#confirm-reason').fill(REASON);
    await dialog.getByRole('button', { name: 'Ask for a fix' }).click();
    await admin.getByText('The owner has been asked').waitFor({ timeout: 10_000 });
    await admin.getByText(/You asked for a fix/).waitFor();
    await admin.getByText('Nothing has changed since.').waitFor();
    // MAIL_TRANSPORT=log keeps emails in the mail_outbox collection.
    const sent = await db
      .collection('mail_outbox')
      .findOne({ category: 'store.changes_asked', createdAt: { $gte: started } });
    check(sent, 'no email to the owner was recorded');
    check(sent.to === need('SMOKE_MERCHANT_EMAIL'), `the email went to ${sent.to}`);
    check(JSON.stringify(sent).includes('master copy designer bags'), 'the email lacks the note');
  });

  await step('the business sees the request on its store page', async () => {
    await page.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    await page.getByText('Sellora asked you to fix something').waitFor();
    await page.getByText(REASON).waitFor();
    await page.getByText('Your store stays open.', { exact: false }).waitFor();
    await shot(page, '03-merchant-fix-asked');
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      storageState: await ctx.storageState(),
    });
    watch(phone, 'merchant phone');
    await phone.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    await phone.getByText('Sellora asked you to fix something').waitFor();
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    check(!overflow, 'the phone view scrolls sideways');
    await shot(phone, '04-merchant-fix-asked-phone', true);
    await phone.close();
  });

  await step('the business fixes it; the super-admin marks it fine', async () => {
    await saveAbout(FIXED);
    await page.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    await page.getByText('You saved changes since then', { exact: false }).waitFor();
    await admin.reload({ waitUntil: 'networkidle' });
    await admin.getByText('The business saved the store after that.').waitFor();
    await admin.getByText('No warnings in what changed.').waitFor();
    await admin.emulateMedia({ colorScheme: 'dark' });
    await shot(admin, '05-admin-after-fix-dark', true);
    await admin.emulateMedia({ colorScheme: 'light' });
    await admin.getByRole('button', { name: 'Looks fine' }).click();
    await admin.getByText('Marked as looked at.').waitFor({ timeout: 10_000 });
    check(
      (await admin.getByText('Changed since approval', { exact: true }).count()) === 0,
      'the changes card is still there',
    );
    await admin.goto(`${BASE}/admin/stores`, { waitUntil: 'networkidle' });
    await admin.getByRole('radio', { name: /^Changed since approval/ }).click();
    await admin.getByText('Nothing waiting for review').waitFor({ timeout: 10_000 });
    await page.reload({ waitUntil: 'networkidle' });
    check(
      (await page.getByText('Sellora asked you to fix something').count()) === 0,
      'the business still sees the request',
    );
  });

  await step('put the About page back and leave the queue empty', async () => {
    await saveAbout(originalAbout);
    await acceptAll();
  });
} catch {
  failed = true;
  await page.screenshot({ path: join(OUT, 'failure-merchant.png') }).catch(() => {});
  await admin.screenshot({ path: join(OUT, 'failure-admin.png') }).catch(() => {});
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
