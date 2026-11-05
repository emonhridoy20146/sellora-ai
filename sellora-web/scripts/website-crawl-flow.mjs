/* eslint-disable no-console -- a command-line report */
/**
 * Checks "Your website" in Products › Sync in a real browser (ADR 0024), against a running web
 * app, API and worker, the website stand-in (sellora-api/scripts/site-stand-in.mjs), the DNS
 * stand-in (scripts/dns-stand-in.mjs, with DNS_SERVERS pointing at it) and the Claude
 * stand-in, with SYNC_ALLOW_PRIVATE_NETWORK=true in the API's .env. It is NOT a test against a
 * real website, DNS provider or Claude: the stand-ins answer from demo data in memory.
 *
 * What it checks: the check reads only robots.txt, the sitemap and the home page; an added
 * site is not read until it is verified; a failed verification says what was not found; the
 * meta tag verifies it and the first crawl imports products (a sold-out one with stock 0) and
 * keeps pages; the pages dialog shows the text and finds a Bangla question; the AI test chat
 * answers a delivery question from the website; a large price drop waits and "keep" keeps
 * Sellora's price, while a small change goes through; a page that is gone archives its
 * product; every request names SelloraBot and none goes where robots.txt forbids; losing the
 * tag stops reading and a DNS record verifies it again; settings offer website intervals;
 * dark mode and a phone; removing the source deletes its pages.
 * Fails on console errors, unexpected API errors or a missing result.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/website-crawl-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SITE_STAND_IN_URL (http://localhost:4095),
 * DNS_STAND_IN_URL (http://localhost:4050).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SITE = (env.SITE_STAND_IN_URL ?? 'http://localhost:4095').replace(/\/+$/, '');
const DNS = (env.DNS_STAND_IN_URL ?? 'http://localhost:4050').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/website-crawl';
mkdirSync(OUT, { recursive: true });

const NAME = 'Nakshi Ghor website';
const FLOW_SKUS = new Set(['WEB-JAM-01', 'WEB-KAN-01', 'WEB-PAN-01', 'WEB-FRK-01', 'WEB-GAM-02']);

const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

function watch(page, label) {
  page.on('console', (m) => {
    // A refused verification answers 422 on purpose, and the browser logs it.
    if (m.type() === 'error' && !m.text().includes('422'))
      problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    const path = new URL(r.url()).pathname;
    if (s === 422 && path.endsWith('/verify')) return;
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

async function site(path) {
  const res = await fetch(`${SITE}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`site stand-in ${path} answered ${res.status}`);
}

async function dns(name, records) {
  const res = await fetch(`${DNS}/records/${name}`, {
    method: records ? 'PUT' : 'DELETE',
    body: records ? JSON.stringify(records) : undefined,
  });
  if (!res.ok && records) throw new Error(`DNS stand-in answered ${res.status}`);
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

/** Removes the website sources and the products this flow imports. */
async function cleanUp(page, orgId) {
  const { items: sources } = await call(page, 'GET', `/orgs/${orgId}/catalog-sources`);
  const mine = sources.filter((s) => s.kind === 'website');
  for (const s of mine) await call(page, 'DELETE', `/orgs/${orgId}/catalog-sources/${s.id}`);
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
  return { sources: mine.length, products: doomed.length };
}

const browser = await chromium.launch();
let failed = false;
let staff;

try {
  await site('/__reset');
  await dns('_sellora-verify.localhost', null);
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  staff = await ctx.newPage();
  watch(staff, 'staff');
  let org;
  let orgId;

  await step('sign in', async () => {
    await staff.goto(`${BASE}/login`);
    await staff.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await staff.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await staff.click('button[type=submit]');
    await staff.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(staff.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    const left = await cleanUp(staff, orgId);
    if (left.sources || left.products)
      console.log(
        `removed ${left.sources} sources and ${left.products} products from an earlier run`,
      );
  });

  const card = () => staff.locator('[data-testid^="source-"]').filter({ hasText: NAME });
  const dialog = () => staff.getByRole('dialog');
  const toastWith = async (re, timeout = 45_000) => {
    const t = staff.locator('[data-sonner-toast]').filter({ hasText: re }).first();
    await t.waitFor({ timeout });
    return t.innerText();
  };
  const siteLog = async () => (await fetch(`${SITE}/__log`)).json();

  await step('the check reads only robots.txt, the sitemap and the home page', async () => {
    await staff.goto(`${BASE}${org}/products/sync`);
    const add = staff.getByRole('button', { name: 'Add source' });
    if (await add.count()) await add.click();
    await staff
      .getByRole('button', { name: /^Your website/ })
      .first()
      .click();
    await dialog().getByRole('heading', { name: 'Add your website' }).waitFor();
    await staff.getByLabel('Website address').fill(SITE);
    await dialog().getByRole('button', { name: 'Check' }).click();
    const check = dialog().getByTestId('site-check');
    await check.getByText('robots.txt lets SelloraBot read the site.').waitFor();
    await check.getByText(/The sitemap lists \d+ pages\./).waitFor();
    const asked = (await siteLog()).map((l) => l.path);
    const pages = asked.filter((p) => !['/robots.txt', '/sitemap.xml', '/'].includes(p));
    if (pages.length) throw new Error(`the check read more than it should: ${pages.join(', ')}`);
    await staff.getByLabel('Name in Sellora').fill(NAME);
    const interval = await staff.getByLabel('Sync', { exact: true }).inputValue();
    if (interval !== '1440') throw new Error(`default interval ${interval}`);
    const options = await staff
      .getByLabel('Sync', { exact: true })
      .locator('option')
      .allInnerTexts();
    if (options.includes('Every 15 minutes')) throw new Error('a website offers 15 minutes');
    await shot(staff, '01-check', true);
  });

  await step('an added site is not read until it is verified', async () => {
    await dialog().getByRole('button', { name: 'Add website' }).click();
    await toastWith(/Prove the site is yours on its card/);
    await card().getByText('Not verified', { exact: true }).waitFor();
    await card().getByText('After you verify the site').waitFor();
    if (await card().getByRole('button', { name: 'Sync now' }).count())
      throw new Error('Sync now is offered before verification');
    await shot(staff, '02-added-not-verified', true);
  });

  let token;
  await step('a failed verification says what was not found', async () => {
    const panel = card().getByTestId('verify-panel');
    const tag = await panel.locator('code').filter({ hasText: 'sellora-site-verification' });
    token = /content="([0-9a-f]{32})"/.exec(await tag.innerText())?.[1];
    if (!token) throw new Error('no token in the tag');
    await panel.getByRole('button', { name: 'Verify' }).click();
    await panel.getByText(/Sellora found neither the sellora-site-verification tag/).waitFor();
    await shot(staff, '03-verify-failed');
  });

  await step('the tag verifies the site and the first crawl imports and keeps pages', async () => {
    await site(`/__verify?token=${token}`);
    await card().getByTestId('verify-panel').getByRole('button', { name: 'Verify' }).click();
    await toastWith(/localhost is verified\. Reading the site now\./);
    const text = await toastWith(new RegExp(`${NAME}: \\d+ pages read`));
    if (!/products: 5 added/.test(text)) throw new Error(`crawl said: ${text}`);
    await card().getByText('Up to date').waitFor({ timeout: 10_000 });
    await card()
      .getByText(/in 1 day|in 24 hours|tomorrow/)
      .waitFor();
    await shot(staff, '04-first-crawl', true);
  });

  await step('products came from product pages; a sold-out one has stock 0', async () => {
    const all = await call(staff, 'GET', `/orgs/${orgId}/products?status=all&limit=100`);
    const mine = all.items.filter((p) => p.variants.some((v) => FLOW_SKUS.has(v.sku)));
    if (mine.length !== 5) throw new Error(`${mine.length} products`);
    const frock = mine.find((p) => p.name === 'Kids Cotton Frock');
    const v = frock?.variants[0];
    if (!v?.trackStock || v.stock !== 0) throw new Error(`frock stock ${JSON.stringify(v)}`);
    const saree = mine.find((p) => p.name === 'Dhakai Jamdani Saree');
    if (saree?.variants[0].trackStock) throw new Error('an in-stock page should not count stock');
    if (!saree?.images?.length) throw new Error('the saree photo was not copied');
    await staff.goto(`${BASE}${org}/products`);
    await staff
      .getByRole('row')
      .filter({ hasText: 'Dhakai Jamdani Saree', has: staff.getByLabel('Synced from a source') })
      .waitFor();
    await shot(staff, '05-products');
  });

  await step('the pages dialog shows the text and finds a Bangla question', async () => {
    await staff.goto(`${BASE}${org}/products/sync`);
    await card().getByRole('button', { name: /^\d+$/ }).first().click();
    await dialog().getByText('Delivery charges and times | Nakshi Ghor').waitFor();
    await dialog()
      .getByRole('button', { name: /Delivery charges and times/ })
      .click();
    await dialog()
      .getByText(/Inside Dhaka delivery costs ৳70/)
      .waitFor();
    await dialog().getByLabel('Question', { exact: true }).fill('ডেলিভারি চার্জ কত?');
    await dialog().getByRole('button', { name: 'Search' }).click();
    const hits = dialog().getByTestId('search-hits');
    await hits.getByText(/ঢাকার ভিতরে ডেলিভারি চার্জ ৭০ টাকা/).waitFor();
    await shot(staff, '06-pages-and-search', true);
    await staff.keyboard.press('Escape');
  });

  await step('the AI test chat answers a delivery question from the website', async () => {
    await staff.goto(`${BASE}${org}/ai-agent`);
    await staff.fill('#test-chat-input', 'ডেলিভারি চার্জ কত?');
    await staff.press('#test-chat-input', 'Enter');
    const chat = staff.getByRole('list', { name: 'Test chat' });
    await chat.getByText(/৭০ টাকা/).waitFor({ timeout: 20_000 });
    await chat.getByText(/read the website · [\d.]+ credits?/).waitFor();
    await shot(staff, '07-ai-answers-from-site');
  });

  await step('a large price drop waits; "keep" keeps Sellora’s price', async () => {
    await site('/__price?slug=jamdani-saree&price=1200');
    await staff.goto(`${BASE}${org}/products/sync`);
    await card().getByRole('button', { name: 'Sync now' }).click();
    await toastWith(/Some changes wait for you\./);
    await card().getByTestId('held-banner').getByText('1 large change waits for you').waitFor();
    await shot(staff, '08-held-banner');
    await card().getByTestId('held-banner').getByRole('button', { name: 'Review' }).click();
    const entry = dialog().getByTestId('held-WEB-JAM-01').or(dialog().locator('li').first());
    await entry.getByText('Dhakai Jamdani Saree').waitFor();
    await entry.getByText(/3,200/).waitFor();
    await entry.getByText(/1,200/).waitFor();
    await shot(staff, '09-held-dialog');
    await entry.getByRole('button', { name: 'Keep Sellora’s price' }).click();
    await toastWith(/Kept\. Sellora keeps its version\./);
    await dialog().getByText('Kept as it is in Sellora').waitFor();
    await staff.keyboard.press('Escape');
    const all = await call(staff, 'GET', `/orgs/${orgId}/products?status=all&limit=100`);
    const saree = all.items.find((p) => p.name === 'Dhakai Jamdani Saree');
    if (saree.variants[0].priceMinor !== 320000)
      throw new Error(`price is ${saree.variants[0].priceMinor}`);
  });

  await step('a small price change goes straight through', async () => {
    await site('/__price?slug=jamdani-saree&price=2950');
    await card().getByRole('button', { name: 'Sync now' }).click();
    const text = await toastWith(new RegExp(`${NAME}: .*1 updated`));
    if (/wait for you/.test(text)) throw new Error(`still held: ${text}`);
    if (await card().getByTestId('held-banner').count()) throw new Error('banner still shown');
    const all = await call(staff, 'GET', `/orgs/${orgId}/products?status=all&limit=100`);
    const saree = all.items.find((p) => p.name === 'Dhakai Jamdani Saree');
    if (saree.variants[0].priceMinor !== 295000)
      throw new Error(`price is ${saree.variants[0].priceMinor}`);
  });

  await step('a product page that is gone archives its product and its page', async () => {
    await site('/__hide?slug=handloom-gamcha');
    await card().getByRole('button', { name: 'Sync now' }).click();
    const text = await toastWith(new RegExp(`${NAME}: .*1 archived`));
    if (!/1 removed/.test(text)) throw new Error(`crawl said: ${text}`);
    await card().getByRole('button', { name: 'History' }).click();
    await dialog().getByText('First import').waitFor();
    await shot(staff, '10-history');
    await staff.keyboard.press('Escape');
  });

  await step('every request names SelloraBot; none goes where robots.txt forbids', async () => {
    const log = await siteLog();
    const wrong = log.filter((l) => !/^SelloraBot\/1\.0 \(\+.+\/bot\)$/.test(l.ua));
    if (wrong.length) throw new Error(`other user agents: ${wrong[0].ua}`);
    const forbidden = log.filter(
      (l) => /^\/(cart|account)/.test(l.path) || l.path.includes('sort='),
    );
    if (forbidden.length) throw new Error(`read ${forbidden.map((l) => l.path).join(', ')}`);
    if (!log.some((l) => l.path === '/robots.txt')) throw new Error('robots.txt never read');
  });

  await step('losing the tag stops reading; a DNS record verifies it again', async () => {
    await site('/__verify?token=');
    await card().getByRole('button', { name: 'Sync now' }).click();
    await toastWith(new RegExp(`${NAME}: .*(verification|sellora-site-verification|prove)`, 'i'));
    await card().getByText('Prove again that the site is yours').waitFor();
    await card().getByText('Not verified', { exact: true }).waitFor();
    await shot(staff, '11-ownership-lost', true);
    await dns('_sellora-verify.localhost', { TXT: [`sellora-verify=${token}`] });
    await card().getByTestId('verify-panel').getByRole('button', { name: 'Verify' }).click();
    await toastWith(/localhost is verified/);
    await toastWith(new RegExp(`${NAME}: \\d+ pages read`));
    await card().getByText('Up to date').waitFor();
  });

  await step('settings offer website intervals and the page and hold switches', async () => {
    await card()
      .getByRole('button', { name: /^Settings for/ })
      .click();
    await dialog()
      .getByRole('switch', { name: /Let the AI read the site’s pages/ })
      .waitFor();
    await dialog()
      .getByRole('switch', { name: /Hold large changes for me/ })
      .waitFor();
    const options = await dialog().getByLabel('Sync').locator('option').allInnerTexts();
    if (options.join('|') !== 'Only when I ask|Every hour|Every 6 hours|Once a day')
      throw new Error(`intervals: ${options.join(', ')}`);
    await dialog().getByText('The address cannot be changed').waitFor();
    await shot(staff, '12-settings');
    await staff.keyboard.press('Escape');
  });

  await step('dark mode and a phone', async () => {
    await staff.emulateMedia({ colorScheme: 'dark' });
    await shot(staff, '13-dark', true);
    await staff.emulateMedia({ colorScheme: 'light' });
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    await phone.context().addCookies(await ctx.cookies());
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/products/sync`);
    await phone.locator('[data-testid^="source-"]').filter({ hasText: NAME }).waitFor();
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 1) throw new Error(`the page scrolls sideways by ${overflow}px on a phone`);
    await shot(phone, '14-phone', true);
    await phone.close();
  });

  await step('removing the source deletes its pages and keeps its products', async () => {
    await card()
      .getByRole('button', { name: /^Remove/ })
      .click();
    await dialog()
      .getByText(/saved pages? are deleted, so the AI stops answering/)
      .waitFor();
    await dialog().getByRole('button', { name: 'Remove source' }).click();
    await toastWith(/products stay as ordinary products/);
    const hits = await call(
      staff,
      'GET',
      `/orgs/${orgId}/catalog-sources/website/search?q=${encodeURIComponent('delivery')}`,
    );
    if (hits.hits.length) throw new Error(`${hits.hits.length} pages still found`);
  });

  await step('clean up', async () => {
    await cleanUp(staff, orgId);
    await site('/__reset');
    await dns('_sellora-verify.localhost', null);
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
