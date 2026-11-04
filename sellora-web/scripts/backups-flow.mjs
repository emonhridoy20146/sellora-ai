/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through backups in a real browser, against a running web app, API and worker (the
 * worker makes the backup files). Files go to the API's configured storage (local disk in
 * development).
 *
 * What it checks: Admin › Backups shows the summary and the list; "Back up now" makes a
 * backup the worker writes, reads back and marks Verified; a test restore passes; downloading
 * asks for a reason and a fresh 2-step code and saves an encrypted .slbk file of the size and
 * checksum the list shows; then the business deletes a product, and on the business's admin
 * page "See what would change" shows it coming back; restoring Products (reason, the name
 * typed, a fresh code) puts it back, and the business sees it again. Fails on console errors,
 * unexpected API errors or a missing result.
 *
 * Needs: the demo business (shop@demo.sellora.test) and platform admin details.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/backups-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000).
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/backups';
mkdirSync(OUT, { recursive: true });

const run = String(Date.now()).slice(-6);
const PRODUCT = `Backup check shawl ${run}`;

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

function totpAt(secretBase32, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretBase32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * A 2-step code the server has not seen: each works once, so each use takes the next
 * 30-second step, waiting until the server accepts it (it allows one step ahead).
 */
let lastStep = 0;
async function freshCode() {
  const step = Math.max(lastStep + 1, Math.floor(Date.now() / 30_000));
  while (Math.floor((Date.now() + 25_000) / 30_000) < step)
    await new Promise((r) => setTimeout(r, 1000));
  lastStep = step;
  return totpAt(need('SMOKE_ADMIN_TOTP_SECRET'), step);
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

async function until(probe, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const actx = await browser.newContext({
  viewport: { width: 1360, height: 900 },
  acceptDownloads: true,
});
const admin = await actx.newPage();
watch(page, 'merchant');
watch(admin, 'admin');
let failed = false;
let orgId;
let business;
let product;
let backup;

try {
  await step('sign in (super-admin and business), add a product to restore later', async () => {
    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    await admin.fill('#code', await freshCode());
    await admin.click('button[type=submit]');
    await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });

    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    orgId = new URL(page.url()).pathname.match(/^\/app\/([a-f0-9]{24})/)[1];
    business = await call(page, 'GET', `/orgs/${orgId}`);
    product = await call(page, 'POST', `/orgs/${orgId}/products`, {
      name: PRODUCT,
      variants: [{ priceMinor: 180_000, stock: 4 }],
    });
  });

  await step('Admin › Backups: back up now; the worker makes and verifies it', async () => {
    await admin.getByRole('link', { name: 'Backups' }).click();
    await admin.waitForURL('**/admin/backups');
    await admin.getByRole('heading', { name: 'Backups', level: 1 }).waitFor();
    await admin.getByTestId('backup-summary').waitFor();
    const before = await call(admin, 'GET', '/platform/backups/runs?scope=platform&limit=5');
    await admin.getByRole('button', { name: 'Back up now' }).click();
    await admin.getByText('Backup started').waitFor();
    backup = await until(async () => {
      const runs = await call(admin, 'GET', '/platform/backups/runs?scope=platform&limit=5');
      const mine = runs.find((r) => !before.some((b) => b.id === r.id));
      return mine && mine.status !== 'running' && mine.status !== 'verifying' ? mine : null;
    }, 'the new backup to be checked');
    check(backup.status === 'verified', `the backup ${backup.status}: ${backup.error}`);
    const row = admin.getByTestId(`backup-run-${backup.id}`);
    await row.getByText('Verified').waitFor();
    check((await row.textContent()).includes('Asked for'), 'the row names who asked');
  });

  await step('a test restore into a temporary database passes', async () => {
    const row = admin.getByTestId(`backup-run-${backup.id}`);
    await row.getByRole('button', { name: 'Test restore' }).click();
    await admin.getByText('Test restore started').waitFor();
    await row.getByText(/passed in/).waitFor({ timeout: 60_000 });
    await shot(admin, '01-admin-backups', true);
  });

  await step('download: a reason and a fresh 2-step code, then the encrypted file', async () => {
    const row = admin.getByTestId(`backup-run-${backup.id}`);
    await row.getByRole('button', { name: 'Download' }).click();
    const dialog = admin.getByRole('dialog');
    await dialog.getByText('Download this backup?').waitFor();
    const submit = dialog.getByRole('button', { name: 'Download' });
    check(await submit.isDisabled(), 'Download waits for a reason and a code');
    await dialog.locator('#download-reason').fill('Keeping a copy before the server move');
    await dialog.locator('#download-code').fill(await freshCode());
    await shot(admin, '02-download-dialog');
    const [download] = await Promise.all([admin.waitForEvent('download'), submit.click()]);
    const saved = join(OUT, 'downloaded.slbk');
    await download.saveAs(saved);
    const bytes = readFileSync(saved);
    check(bytes.subarray(0, 8).toString() === 'SLBK0001', 'the file is a Sellora backup');
    check(bytes.length === backup.size, `size ${bytes.length}, the list says ${backup.size}`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    check(sha === backup.sha256, 'the checksum matches');
    check(!bytes.includes(Buffer.from(PRODUCT)), 'the file is encrypted');
    check(download.suggestedFilename().endsWith('.slbk'), 'named .slbk');
  });

  await step('the business deletes the product; the admin previews the restore', async () => {
    const res = await call(page, 'DELETE', `/orgs/${orgId}/products/${product.id}`);
    check(res.deleted, 'the product was deleted');
    await admin.goto(`${BASE}/admin/tenants/${orgId}`);
    const card = admin.getByTestId('tenant-backups');
    await card.waitFor();
    await card.locator('#restore-point').selectOption(backup.id);
    await card.getByRole('button', { name: 'See what would change' }).click();
    const preview = card.getByTestId('restore-preview');
    await preview.waitFor();
    const products = preview.getByRole('row').filter({ hasText: 'Products' });
    // In the backup, Now, Comes back, Replaced, Removed.
    const cells = await products.getByRole('cell').allTextContents();
    check(Number(cells[4]) >= 1, `at least one product comes back (${cells.join(' | ')})`);
    await card.scrollIntoViewIfNeeded();
    await admin.waitForTimeout(300);
    await card.screenshot({ path: join(OUT, '03-restore-preview.png') });
  });

  await step('restore Products: reason, the name typed, a fresh code; it is restored', async () => {
    const card = admin.getByTestId('tenant-backups');
    await card.getByRole('checkbox', { name: 'Restore Products' }).click();
    await card.getByRole('button', { name: /Restore Products/ }).click();
    const dialog = admin.getByRole('dialog');
    await dialog.getByText('Restore Products?').waitFor();
    await dialog.locator('#restore-reason').fill('The owner deleted a product by mistake');
    await dialog.locator('#restore-name').fill(business.name);
    await dialog.locator('#restore-code').fill(await freshCode());
    await shot(admin, '04-restore-dialog');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await admin.getByText('Restore started').waitFor();
    const restores = card.getByTestId('tenant-restores');
    await restores.getByText('Restored').first().waitFor({ timeout: 60_000 });
    await restores
      .getByText(/records put back/)
      .first()
      .waitFor();
    await card.scrollIntoViewIfNeeded();
    await admin.waitForTimeout(300);
    await card.screenshot({ path: join(OUT, '05-restored.png') });
  });

  await step('the business sees the product again', async () => {
    await page.goto(`${BASE}/app/${orgId}/products`);
    await page.getByText(PRODUCT).first().waitFor({ timeout: 15_000 });
    await shot(page, '06-merchant-products');
    const back = await call(page, 'GET', `/orgs/${orgId}/products/${product.id}`);
    check(back.name === PRODUCT, 'the same product, same id');
  });
} catch (err) {
  failed = true;
  console.error(String(err));
  await shot(admin, 'zz-failure-admin', true).catch(() => undefined);
} finally {
  // Leave the demo as it was: the product this flow added goes again.
  if (orgId && product)
    await call(page, 'DELETE', `/orgs/${orgId}/products/${product.id}`).catch(() => undefined);
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
