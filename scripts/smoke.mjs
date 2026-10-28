/* eslint-disable no-console -- a command-line report */
/**
 * Browser smoke test against a running web app and API: signs in as a merchant and as a
 * platform admin, opens every built page, and fails on console errors, 5xx responses or
 * error panels. Screenshots go to SMOKE_OUT for a visual check.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… \
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
 *   npm run e2e
 *
 * Needs Playwright with Chromium installed (not a dependency of this app).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output';
mkdirSync(OUT, { recursive: true });

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), enough to sign in to the platform realm. */
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

const results = [];

async function check(page, path, name, { allowStatus = [] } = {}) {
  const problems = [];
  const onConsole = (m) => {
    if (m.type() !== 'error') return;
    // The browser logs the document's own expected status (e.g. the 404 page) as an error.
    if (allowStatus.some((s) => m.text().includes(`status of ${s}`))) return;
    problems.push(`console: ${m.text().slice(0, 200)}`);
  };
  const onResponse = (r) => {
    const s = r.status();
    if (s >= 500 || (s >= 400 && s !== 401 && !allowStatus.includes(s) && r.url().includes('/v1/')))
      problems.push(`${s} ${r.request().method()} ${new URL(r.url()).pathname}`);
  };
  page.on('console', onConsole);
  page.on('response', onResponse);
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page
      .waitForFunction(() => !document.querySelector('.animate-pulse'), null, { timeout: 10_000 })
      .catch(() => {
        problems.push('still loading after 10s');
      });
    await page.waitForTimeout(250);
    if (await page.getByText('This could not be loaded').count())
      problems.push('error panel shown');
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  } catch (err) {
    problems.push(String(err).slice(0, 200));
  } finally {
    page.off('console', onConsole);
    page.off('response', onResponse);
  }
  results.push({
    name,
    path,
    url: page.url().replace(BASE, ''),
    ok: problems.length === 0,
    problems,
  });
}

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- public
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    await check(page, '/', 'public-home');
    await check(page, '/legal/terms', 'public-terms');
    await check(page, '/legal/privacy', 'public-privacy');
    await check(page, '/login', 'public-login');
    await check(page, '/signup', 'public-signup');
    await check(page, '/admin/login', 'public-admin-login');
    await check(page, '/no-such-page', 'public-404', { allowStatus: [404] });
    await ctx.close();
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await check(await mobile.newPage(), '/', 'public-home-mobile');
    await mobile.close();
  }

  // ---------------------------------------------------------------- merchant
  let orgPath = null;
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    orgPath = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    for (const [sub, name] of [
      ['', 'overview'],
      ['/billing', 'billing'],
      ['/billing/plans', 'billing-plans'],
      ['/billing/wallet', 'billing-wallet'],
      ['/billing/usage', 'billing-usage'],
      ['/billing/invoices', 'billing-invoices'],
      ['/staff', 'staff'],
      ['/staff/invitations', 'staff-invitations'],
      ['/staff/roles', 'staff-roles'],
      ['/settings', 'settings'],
      ['/settings/selling', 'settings-selling'],
      ['/settings/channels', 'settings-channels'],
      ['/settings/couriers', 'settings-couriers'],
      ['/inbox', 'inbox'],
      ['/ai-agent', 'ai-agent'],
      ['/orders', 'orders'],
      ['/orders/new', 'orders-new'],
      ['/products', 'products'],
      ['/products/new', 'products-new'],
      ['/products/categories', 'products-categories'],
      ['/customers', 'customers'],
      ['/couriers', 'couriers'],
      ['/activity', 'activity'],
    ])
      await check(page, orgPath + sub, `merchant-${name}`);
    await check(page, '/app/account', 'merchant-account');
    await check(page, '/app?choose=1', 'merchant-picker');
    await ctx.close();

    const dark = await browser.newContext({
      viewport: { width: 1360, height: 900 },
      colorScheme: 'dark',
    });
    const dpage = await dark.newPage();
    await dpage.goto(`${BASE}/login`);
    await dpage.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await dpage.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await dpage.click('button[type=submit]');
    await dpage.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    await check(dpage, orgPath, 'merchant-overview-dark');
    await check(dpage, `${orgPath}/billing/usage`, 'merchant-usage-dark');
    await check(dpage, `${orgPath}/orders`, 'merchant-orders-dark');
    await dark.close();
  }

  // ---------------------------------------------------------------- platform admin
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`);
    await page.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await page.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForSelector('#code', { timeout: 15_000 });
    // A code is single-use; wait for a fresh window if one was used moments ago.
    await page.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
    await page.click('button[type=submit]');
    await page.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });
    const orgId = orgPath?.split('/').pop();
    for (const [path, name] of [
      ['/admin', 'overview'],
      ['/admin/tenants', 'tenants'],
      ...(orgId ? [[`/admin/tenants/${orgId}`, 'tenant-detail']] : []),
      ['/admin/users', 'users'],
      ['/admin/payments', 'payments'],
      ['/admin/withdrawals', 'withdrawals'],
      ['/admin/profit', 'profit'],
      ...(orgId ? [[`/admin/profit?orgId=${orgId}`, 'profit-one-business']] : []),
      ['/admin/plans', 'plans'],
      ['/admin/ai-pricing', 'ai-pricing'],
      ['/admin/gateways', 'gateways'],
      ['/admin/admins', 'team'],
      ['/admin/settings', 'settings'],
      ['/admin/audit', 'audit'],
    ])
      await check(page, path, `admin-${name}`);

    // Open the editors so their dialogs render against real data.
    await page.goto(`${BASE}/admin/plans`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Edit' }).nth(1).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, 'admin-plan-editor.png'), fullPage: false });
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/admin/ai-pricing`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Publish new price' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, 'admin-publish-price.png'), fullPage: false });
    await page.keyboard.press('Escape');
    // The model editor, with its "Understands photos" switch.
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByRole('switch', { name: 'Understands photos' }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, 'admin-model-editor.png'), fullPage: false });
    await ctx.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
for (const r of results)
  console.log(
    `${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(28)} ${r.url}${r.ok ? '' : `\n     ${r.problems.join('\n     ')}`}`,
  );
console.log(
  `\n${results.length - failed.length}/${results.length} pages passed. Screenshots in ${OUT}/`,
);
process.exit(failed.length ? 1 : 0);
