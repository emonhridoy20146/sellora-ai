/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through Settings › Backups as the business's owner, against a running web app, API,
 * worker and the Google stand-in (scripts/google-stand-in.mjs in sellora-api, NOT Google).
 *
 * What it checks: the Backups tab shows the three cards; "Prepare a download" makes a ZIP the
 * worker writes, and "Download" saves it: products.csv holds the product this flow added, the
 * JSON files hold no password hashes or encrypted keys. "Connect Google Drive" goes to the
 * stand-in's consent page; Allow comes back connected, the worker saves the first copy to the
 * stand-in's Drive, "Copy now" saves another, and the copies kept can be changed. Then a
 * restore point is made, the product is deleted, the preview shows it coming back, a wrong
 * password is refused, and restoring Products with the right one puts it back. Finally Drive is
 * disconnected. Fails on console errors, unexpected API errors or a missing result.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/merchant-backups-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), GOOGLE_STAND_IN_URL (http://localhost:4060).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const GOOGLE = (env.GOOGLE_STAND_IN_URL ?? 'http://localhost:4060').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/merchant-backups';
mkdirSync(OUT, { recursive: true });

const run = String(Date.now()).slice(-6);
const PRODUCT = `Drive check scarf ${run}`;

const problems = [];
const steps = [];
/** API answers the flow causes on purpose (a wrong password), each allowed once. */
const expected = [];
const expectedConsole = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

/** Reads a ZIP with Python's zipfile (an independent reader). */
function unzip(file) {
  const script = [
    'import json, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'print(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-I', '-c', script, file], {
      maxBuffer: 256 * 1024 * 1024,
    }).toString(),
  );
}

async function stand(path, method = 'GET') {
  const res = await fetch(`${GOOGLE}${path}`, { method });
  return res.json();
}

function watch(page, label) {
  page.on('console', (m) => {
    // 401: the sign-in pages ask who is signed in before anyone is.
    // The browser also logs the API answers the flow causes on purpose.
    const planned = expectedConsole.findIndex((re) => re.test(m.text()));
    if (m.type() === 'error' && planned >= 0) {
      expectedConsole.splice(planned, 1);
      return;
    }
    if (m.type() === 'error' && !/status of 401/.test(m.text()))
      problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    const path = new URL(r.url()).pathname;
    const i = expected.findIndex((e) => e.status === s && e.path.test(path));
    if (i >= 0) {
      expected.splice(i, 1);
      return;
    }
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
const ctx = await browser.newContext({
  viewport: { width: 1360, height: 900 },
  acceptDownloads: true,
});
const page = await ctx.newPage();
watch(page, 'merchant');
let failed = false;
let orgId;
let business;
let product;
const card = (id) => page.getByTestId(id);
const overview = () => call(page, 'GET', `/orgs/${orgId}/backups`);

try {
  await step('sign in, add a product, open Settings › Backups', async () => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    orgId = new URL(page.url()).pathname.match(/^\/app\/([a-f0-9]{24})/)[1];
    business = await call(page, 'GET', `/orgs/${orgId}`);
    product = await call(page, 'POST', `/orgs/${orgId}/products`, {
      name: PRODUCT,
      variants: [{ priceMinor: 95_000, stock: 3 }],
    });
    // A Drive left connected by an earlier run would change the page: start without one.
    const o = await overview();
    if (o.drive) await call(page, 'DELETE', `/orgs/${orgId}/backups/drive`);
    await page.goto(`${BASE}/app/${orgId}/settings`);
    await page.getByRole('link', { name: 'Backups' }).click();
    await page.waitForURL('**/settings/backups');
    await card('export-card').waitFor();
    await card('drive-card').getByRole('button', { name: 'Connect Google Drive' }).waitFor();
    await card('restore-card').waitFor();
    await shot(page, '01-backups-page', true);
  });

  await step(
    'Download your data: the worker prepares the ZIP; it holds the business, no secrets',
    async () => {
      const exports = card('export-card');
      const before = (await overview()).exports.map((e) => e.id);
      await exports.getByRole('button', { name: 'Prepare a download' }).click();
      await page.getByText('Preparing your download').waitFor();
      const made = await until(
        async () => {
          const e = (await overview()).exports.find((x) => !before.includes(x.id));
          return e && e.status !== 'running' ? e : null;
        },
        'the download to be prepared',
        60_000,
      );
      check(made.status === 'ready', `the download ${made.status}: ${made.error}`);
      const row = card(`export-${made.id}`);
      await row.getByText('Ready').waitFor();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        row.getByRole('button', { name: 'Download' }).click(),
      ]);
      check(
        /^sellora-[a-z0-9-]+-data-\d{4}-\d{2}-\d{2}\.zip$/.test(download.suggestedFilename()),
        `named ${download.suggestedFilename()}`,
      );
      const saved = join(OUT, 'download.zip');
      await download.saveAs(saved);
      const files = unzip(saved);
      check(files['products.csv']?.includes(PRODUCT), 'products.csv holds the new product');
      check(files['products.csv'].includes('950.00'), 'its price in taka');
      check(
        Boolean(files['README.txt'] && files['data/orders.json'] && files['data/business.json']),
        'README and JSON files',
      );
      const json = Object.entries(files)
        .filter(([n]) => n.endsWith('.json'))
        .map(([, b]) => b)
        .join('\n');
      check(
        !/"[A-Za-z]*(Enc|Hash)":|"passwordHash"|"token":/.test(json),
        'no secrets in the JSON files',
      );
      check(JSON.parse(files['data/business.json'])._id === orgId, 'the business itself');
      await shot(page, '02-download-ready');
    },
  );

  await step(
    "Connect Google Drive: the stand-in's consent page, Allow, back connected",
    async () => {
      await card('drive-card').getByRole('button', { name: 'Connect Google Drive' }).click();
      await page.waitForURL(`${GOOGLE}/o/oauth2/v2/auth**`);
      const consent = new URL(page.url());
      check(
        consent.searchParams.get('scope') === 'https://www.googleapis.com/auth/drive.file',
        'asks only for drive.file',
      );
      check(consent.searchParams.get('access_type') === 'offline', 'offline access');
      await page.getByText('not Google').waitFor();
      await shot(page, '03-consent-stand-in');
      await page.getByRole('button', { name: 'Allow' }).click();
      await page.waitForURL(`**/app/${orgId}/settings/backups**`);
      await page.getByText('Google Drive is connected').waitFor();
      check(!page.url().includes('drive='), 'the result is taken off the address');
      await card('drive-email').getByText(need('SMOKE_MERCHANT_EMAIL')).waitFor();
    },
  );

  await step('the worker saves the first copy to the Drive; Copy now saves another', async () => {
    const last = card('drive-last');
    await last.getByText(/^sellora-.*\.zip · /).waitFor({ timeout: 60_000 });
    // The newest folder of that name is this connection's (an earlier run may have left one).
    const folder = (await stand('/__files'))
      .filter(
        (x) =>
          x.mimeType === 'application/vnd.google-apps.folder' &&
          x.name === `Sellora backups - ${business.name}`,
      )
      .sort((a, b) => b.createdTime.localeCompare(a.createdTime))[0];
    check(folder, 'the folder is named after the business');
    const inFolder = async () =>
      (await stand('/__files')).filter(
        (x) => /^sellora-.*\.zip$/.test(x.name) && x.parents.includes(folder.id),
      );
    const firstCopies = await until(async () => {
      const f = await inFolder();
      return f.length >= 1 ? f : null;
    }, 'the copy in the stand-in Drive');
    await card('drive-card').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await card('drive-card').screenshot({ path: join(OUT, '04-drive-connected.png') });
    await card('drive-card').locator('#drive-keep').selectOption('3');
    await page.getByText('Saved').first().waitFor();
    await card('drive-card').getByRole('button', { name: 'Copy now' }).click();
    await page.getByText('Saving a copy to Google Drive now').waitFor();
    await until(
      async () => (await inFolder()).length >= firstCopies.length + 1,
      'a second copy',
      60_000,
    );
    const o = await overview();
    check(o.drive.keep === 3 && o.drive.lastError === null, 'kept 3, no problem');
    const drivePage = await ctx.newPage();
    await drivePage.goto(`${GOOGLE}/drive`);
    await drivePage.screenshot({ path: join(OUT, '05-stand-in-drive.png') });
    await drivePage.close();
  });

  await step(
    'a restore point; the product is deleted; the preview shows it coming back',
    async () => {
      const restore = card('restore-card');
      await restore.getByRole('button', { name: 'Make a restore point' }).click();
      await page.getByText('Making a restore point').first().waitFor();
      const point = await until(
        async () => {
          const o = await overview();
          const p = o.points.find((x) => x.kind === 'restore_point');
          return p && p.status === 'ready' && !o.points.some((x) => x.status === 'making')
            ? p
            : null;
        },
        'the restore point',
        60_000,
      );
      await call(page, 'DELETE', `/orgs/${orgId}/products/${product.id}`);
      await page.reload();
      await restore.locator('#restore-point').selectOption(point.id);
      await restore.getByRole('button', { name: 'See what would change' }).click();
      const preview = restore.getByTestId('restore-preview');
      await preview.waitFor();
      const cells = await preview
        .getByRole('row')
        .filter({ hasText: 'Products' })
        .getByRole('cell')
        .allTextContents();
      check(Number(cells[4]) >= 1, `the product comes back (${cells.join(' | ')})`);
      await restore.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await restore.screenshot({ path: join(OUT, '06-restore-preview.png') });
    },
  );

  await step(
    'restore Products: a wrong password is refused, the right one restores it',
    async () => {
      const restore = card('restore-card');
      await restore.getByRole('checkbox', { name: 'Restore Products' }).click();
      await restore.getByRole('button', { name: /Restore Products/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('Restore Products?').waitFor();
      await dialog.locator('#restore-reason').fill('Deleted the scarf by mistake');
      await dialog.locator('#restore-name').fill(business.name);
      await dialog.locator('#restore-password').fill('not the password');
      expected.push({ status: 422, path: /\/backups\/restores$/ });
      expectedConsole.push(/status of 422/);
      await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
      await dialog.getByText('The password is not right.').waitFor();
      await shot(page, '07-wrong-password');
      await dialog.locator('#restore-password').fill(need('SMOKE_MERCHANT_PASSWORD'));
      const before = (await overview()).restores.map((r) => r.id);
      await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByText('Restore started').waitFor();
      const done = await until(
        async () => {
          const r = (await overview()).restores.find((x) => !before.includes(x.id));
          return r && r.status !== 'running' ? r : null;
        },
        'the restore',
        60_000,
      );
      check(done.status === 'done', `the restore ${done.status}: ${done.error}`);
      check(done.by.label === need('SMOKE_MERCHANT_EMAIL'), 'named as the owner');
      await restore.getByTestId('restores').getByText('Restored').first().waitFor();
      const back = await call(page, 'GET', `/orgs/${orgId}/products/${product.id}`);
      check(back.name === PRODUCT, 'the same product is back');
      await restore.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await restore.screenshot({ path: join(OUT, '08-restored.png') });
    },
  );

  await step('disconnect Google Drive', async () => {
    await card('drive-card').getByRole('button', { name: 'Disconnect' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Disconnect Google Drive?').waitFor();
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByText('Google Drive disconnected').waitFor();
    await card('drive-card').getByRole('button', { name: 'Connect Google Drive' }).waitFor();
    check((await overview()).drive === null, 'no connection left');
  });
} catch (err) {
  failed = true;
  console.error(String(err));
  await shot(page, 'zz-failure', true).catch(() => undefined);
} finally {
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
