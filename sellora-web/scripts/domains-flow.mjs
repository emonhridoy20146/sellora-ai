/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through connecting a business's own domain to its online store (ADR 0015 in
 * sellora-api), in a real browser, against a running web app, API, worker, storefront app and
 * the DNS stand-in (`node scripts/dns-stand-in.mjs` in sellora-api, with the API started with
 * DNS_SERVERS=127.0.0.1:5300 STOREFRONT_DOMAIN_TARGET=edge.sellora.test
 * STOREFRONT_DOMAIN_IPS=127.0.0.1). The stand-in plays the business's DNS provider: this
 * script sets its records over HTTP where a person would type them into their provider's
 * page. No real domain, DNS provider or certificate is involved, and the made-up domains
 * reach the local storefront through Chromium's --host-resolver-rules.
 *
 * Needs the open store that `node scripts/stores-flow.mjs` leaves behind (Nakshi Ghor), and
 * automatic domain approval off in the super-admin settings.
 *
 * What it checks: the store's Web address tab; a Sellora address refused; a pasted URL
 * cleaned to a domain; the DNS records to add; checks that report a missing CNAME and one
 * pointing elsewhere; correct records moving the domain to review; the super-admin's queue
 * and approval; the domain becoming the store's main address; shoppers on the domain
 * (home, product, cart through the storefront's API routes); the Sellora address and a
 * second domain sending shoppers to the main one; switching the main address; the
 * certificate check Caddy asks; the super-admin disconnecting a domain with a reason the
 * owner sees; removing domains. Fails on console errors, unexpected API errors or a missing
 * result. Leaves the store on its Sellora address with no domains.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… \
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
 *   node scripts/domains-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SMOKE_OUT (smoke-output/domains),
 * API_URL (http://127.0.0.1:4000), DNS_STAND_IN_URL (http://127.0.0.1:4050).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const API = (env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const DNS = (env.DNS_STAND_IN_URL ?? 'http://127.0.0.1:4050').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/domains';
const WWW = 'www.nakshi-shop.test';
const APEX = 'nakshi-shop.test';
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
  // A whole-page picture of a scrolled page draws the fixed sidebar out of place.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
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

/** Plays the business at its DNS provider: replaces every record of one name. */
async function setRecords(name, records) {
  const res = await fetch(`${DNS}/records/${name}`, {
    method: 'PUT',
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error(`DNS stand-in refused ${name}: ${await res.text()}`);
}
async function dropRecords(...names) {
  for (const name of names) await fetch(`${DNS}/records/${name}`, { method: 'DELETE' });
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function domainList() {
  return call(page, 'GET', `/orgs/${orgId}/stores/${store.id}/domains`);
}
const card = (domain) => page.locator(`[data-domain="${domain}"]`);

async function checkNow(domain) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/check') && r.request().method() === 'POST'),
    card(domain).getByRole('button', { name: 'Check now' }).click(),
  ]);
  check(res.status() === 200, `Check now answered ${res.status()}`);
}

/** The super-admin's page, signed in once: a sign-in code works only once. */
let adminPage;
async function admin() {
  if (adminPage) return adminPage;
  const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  adminPage = await actx.newPage();
  watch(adminPage, 'admin');
  await adminPage.goto(`${BASE}/admin/login`);
  await adminPage.fill('#email', need('SMOKE_ADMIN_EMAIL'));
  await adminPage.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
  await adminPage.click('button[type=submit]');
  await adminPage.waitForSelector('#code', { timeout: 15_000 });
  await adminPage.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
  await adminPage.click('button[type=submit]');
  await adminPage.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });
  return adminPage;
}

/** Caddy's question before it fetches a certificate for a host. */
async function certificateAnswer(domain) {
  const res = await fetch(
    `${API}/v1/public/store-domains/check?domain=${encodeURIComponent(domain)}`,
  );
  return res.status;
}

// The made-up domains reach the local storefront; *.localhost already does.
const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP ${WWW} 127.0.0.1, MAP ${APEX} 127.0.0.1`],
});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
watch(page, 'merchant');
let failed = false;
let org;
let orgId;
let store;
let selloraUrl;
let port;

try {
  await step('sign in; find the open store; clear earlier domains', async () => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    const { items } = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = items.find((s) => s.status === 'live');
    check(store, 'needs an open store: run node scripts/stores-flow.mjs first');
    for (const d of (await domainList()).items)
      await call(page, 'DELETE', `/orgs/${orgId}/stores/${store.id}/domains/${d.id}`);
    await dropRecords(WWW, APEX, `_sellora-verify.${WWW}`, `_sellora-verify.${APEX}`);
    store = await call(page, 'GET', `/orgs/${orgId}/stores/${store.id}`);
    selloraUrl = store.selloraUrl;
    port = new URL(selloraUrl).port;
    check(store.url === selloraUrl, 'the store should start on its Sellora address');
    const settings = await domainList();
    check(settings.enabled, 'custom domains are off: set STOREFRONT_DOMAIN_TARGET for the API');
    check(settings.limit !== 0, "the business's plan has no custom domains");
  });

  await step('the Web address tab, empty', async () => {
    await page.goto(`${BASE}${org}/store/${store.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Use your own domain' }).click();
    await page.waitForURL(/\/domain$/);
    await page.getByRole('heading', { name: 'Your own domain' }).waitFor();
    await page.getByText('No domain yet.').waitFor();
    await shot(page, '01-web-address-empty', true);
  });

  await step('a Sellora address is refused; a pasted URL becomes a domain', async () => {
    expectError(422, /\/domains$/);
    // The address shoppers' domains point at is Sellora's own.
    await page.fill('#domain-input', 'edge.sellora.test');
    await page.getByRole('button', { name: 'Add domain' }).click();
    await page.getByText('This is a Sellora address; enter a domain you own').waitFor();
    await shot(page, '02-sellora-address-refused');
    await page.fill('#domain-input', `https://WWW.Nakshi-Shop.test/collections?ref=fb`);
    await page.getByRole('button', { name: 'Add domain' }).click();
    await card(WWW).waitFor();
    await card(WWW).getByText('Waiting for DNS', { exact: true }).waitFor();
    await card(WWW).getByRole('table').waitFor();
    check(
      (await card(WWW).getByRole('cell', { name: 'edge.sellora.test' }).count()) === 1,
      'the CNAME record should point at edge.sellora.test',
    );
    await shot(page, '03-domain-added-records', true);
  });

  await step('the TXT record alone: the check asks for the CNAME', async () => {
    const d = (await domainList()).items.find((x) => x.domain === WWW);
    const txt = d.records.find((r) => r.type === 'TXT');
    check(txt.name === `_sellora-verify.${WWW}`, `unexpected TXT name ${txt.name}`);
    await setRecords(txt.name, { TXT: [txt.value] });
    await checkNow(WWW);
    await card(WWW).getByText('The CNAME record is not there yet.').waitFor();
    await card(WWW).getByText('Waiting for DNS', { exact: true }).waitFor();
    await shot(page, '04-cname-missing', true);
  });

  await step('a CNAME pointing elsewhere is named', async () => {
    await setRecords(WWW, { CNAME: ['nakshi-shop.old-host.test'] });
    await checkNow(WWW);
    await card(WWW)
      .getByText('The CNAME record points to nakshi-shop.old-host.test, not edge.sellora.test.')
      .waitFor();
    await shot(page, '05-cname-wrong', true);
  });

  await step('right records: the domain waits for review', async () => {
    await setRecords(WWW, { CNAME: ['edge.sellora.test'] });
    await checkNow(WWW);
    await card(WWW).getByText('In review', { exact: true }).waitFor();
    await page.getByText(`The records are right. ${WWW} is now in review.`).waitFor();
    check((await certificateAnswer(WWW)) === 404, 'no certificate before approval');
    await shot(page, '06-in-review', true);
  });

  await step('super-admin approves it from the domains queue', async () => {
    const a = await admin();
    await a.goto(`${BASE}/admin/stores`, { waitUntil: 'networkidle' });
    await a.getByRole('link', { name: 'Custom domains' }).click();
    await a.waitForURL(/\/admin\/stores\/domains$/);
    const row = a.getByRole('row', { name: new RegExp(WWW.replaceAll('.', '\\.')) });
    await row.waitFor();
    await shot(a, '07-admin-domain-queue');
    await row.getByRole('button', { name: `Approve ${WWW}` }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Approve domain' }).click();
    await a.getByText(`${WWW} connected. The owner has been told.`).waitFor();
    await a.getByText('No domain waiting for review').waitFor({ timeout: 10_000 });
    check((await certificateAnswer(WWW)) === 200, 'Caddy should get a certificate now');
  });

  await step('the domain is the main address in the dashboard', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await card(WWW).getByText('Connected', { exact: true }).waitFor();
    await card(WWW).getByText('Main address', { exact: true }).waitFor();
    store = await call(page, 'GET', `/orgs/${orgId}/stores/${store.id}`);
    check(store.url === `http://${WWW}:${port}`, `store url is ${store.url}`);
    check(store.primaryDomain === WWW, 'primaryDomain should be the new domain');
    await page.getByText(WWW, { exact: true }).first().waitFor();
    await shot(page, '08-connected-main', true);
  });

  await step('shoppers on the domain: home, product, cart', async () => {
    const shopper = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await shopper.newPage();
    watch(p, 'shopper');
    await p.goto(`http://${WWW}:${port}/`, { waitUntil: 'networkidle' });
    check(new URL(p.url()).host === `${WWW}:${port}`, `landed on ${p.url()}`);
    await p.getByRole('heading', { name: 'Handwoven in Bangladesh' }).waitFor();
    await shot(p, '09-shopper-on-domain', true);
    await p.goto(`http://${WWW}:${port}/products/nakshi-kantha-throw`, {
      waitUntil: 'networkidle',
    });
    await p.getByRole('button', { name: 'Add to cart' }).click();
    await p.goto(`http://${WWW}:${port}/cart`, { waitUntil: 'networkidle' });
    await p.getByText('Nakshi Kantha Throw').first().waitFor();
    await shot(p, '10-cart-on-domain', true);
    await shopper.close();
  });

  await step('the Sellora address sends shoppers to the domain', async () => {
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await visitor.newPage();
    watch(p, 'visitor');
    const [first] = await Promise.all([
      p.waitForResponse((r) => r.url().startsWith(selloraUrl)),
      p.goto(`${selloraUrl}/products/dhakai-jamdani-saree?ref=fb`, { waitUntil: 'networkidle' }),
    ]);
    check(first.status() === 308, `the Sellora address answered ${first.status()}`);
    check(
      p.url() === `http://${WWW}:${port}/products/dhakai-jamdani-saree?ref=fb`,
      `redirected to ${p.url()}`,
    );
    await visitor.close();
  });

  await step('a second domain (the bare domain), approved on the store review page', async () => {
    await page.fill('#domain-input', APEX);
    await page.getByRole('button', { name: 'Add domain' }).click();
    await card(APEX).getByText('Waiting for DNS', { exact: true }).waitFor();
    const d = (await domainList()).items.find((x) => x.domain === APEX);
    check(
      d.records.some((r) => r.type === 'A' && r.value === '127.0.0.1'),
      'the bare domain should ask for an A record',
    );
    await shot(page, '11-apex-records', true);
    for (const r of d.records)
      await setRecords(r.name, r.type === 'TXT' ? { TXT: [r.value] } : { A: [r.value] });
    await checkNow(APEX);
    await card(APEX).getByText('In review', { exact: true }).waitFor();

    const a = await admin();
    await a.goto(`${BASE}/admin/stores/${store.id}`, { waitUntil: 'networkidle' });
    await a.getByRole('heading', { name: 'Custom domains' }).waitFor();
    await shot(a, '12-admin-store-domains', true);
    await a.getByRole('button', { name: `Approve ${APEX}` }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Approve domain' }).click();
    await a.getByText(`${APEX} connected. The owner has been told.`).waitFor();
  });

  await step('switch the main address to the bare domain; the other domain follows', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await card(APEX).getByText('Connected', { exact: true }).waitFor();
    check(
      (await card(APEX).getByText('Main address', { exact: true }).count()) === 0,
      'the second domain should not take over the main address',
    );
    await card(APEX).getByRole('button', { name: 'Make main address' }).click();
    await page.getByText(`Shoppers are now sent to ${APEX}.`).waitFor();
    await card(APEX).getByText('Main address', { exact: true }).waitFor();
    await shot(page, '13-two-domains', true);
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await visitor.newPage();
    watch(p, 'visitor');
    await p.goto(`http://${WWW}:${port}/track`, { waitUntil: 'networkidle' });
    check(p.url() === `http://${APEX}:${port}/track`, `the www domain went to ${p.url()}`);
    await visitor.close();
  });

  await step('the Sellora address as the main address again', async () => {
    await page.getByRole('button', { name: 'Make main address' }).first().click();
    await page.getByText('The Sellora address is the main address again.').waitFor();
    store = await call(page, 'GET', `/orgs/${orgId}/stores/${store.id}`);
    check(store.url === selloraUrl && !store.primaryDomain, `store url is ${store.url}`);
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await visitor.newPage();
    watch(p, 'visitor');
    await p.goto(`http://${APEX}:${port}/`, { waitUntil: 'networkidle' });
    check(p.url() === `${selloraUrl}/`, `the bare domain went to ${p.url()}`);
    await visitor.close();
  });

  await step('super-admin disconnects a domain; the owner reads why', async () => {
    const a = await admin();
    await a.goto(`${BASE}/admin/stores/domains`, { waitUntil: 'networkidle' });
    await a.getByRole('radio', { name: 'Connected' }).click();
    await a.getByRole('button', { name: `Disconnect ${APEX}` }).click();
    const dialog = a.getByRole('dialog');
    await dialog.getByLabel('Why (the owner sees this)').fill('The name copies another brand.');
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await a.getByText(`${APEX} disconnected.`).waitFor();
    check((await certificateAnswer(APEX)) === 404, 'no certificate after disconnecting');

    await page.reload({ waitUntil: 'networkidle' });
    await card(APEX).getByText('Not approved', { exact: true }).waitFor();
    await card(APEX).getByText('The name copies another brand.').waitFor();
    await shot(page, '14-disconnected-reason', true);
  });

  await step('remove both domains', async () => {
    for (const domain of [APEX, WWW]) {
      await card(domain).getByRole('button', { name: 'Remove' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove domain' }).click();
      await page.getByText('Domain removed.').first().waitFor();
      await card(domain).waitFor({ state: 'detached' });
    }
    await page.getByText('No domain yet.').waitFor();
    check((await certificateAnswer(WWW)) === 404, 'no certificate after removing');
    await shot(page, '15-removed', true);
    await dropRecords(WWW, APEX, `_sellora-verify.${WWW}`, `_sellora-verify.${APEX}`);
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
