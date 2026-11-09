/* eslint-disable no-console -- a command-line report */
/**
 * Checks the value dashboard and first analytics in a real browser, against a running web app
 * and API, with the demo business's own orders, chats and AI usage (built up by the other
 * flows, whose AI replies come from the Claude stand-in in sellora-api/scripts). It is NOT a
 * check of real customers' data: the chats and AI replies were made by the stand-ins.
 *
 * What it checks: the overview shows "What Sellora did for you in the last 30 days" with the
 * numbers the API sent; the API's order, sales and AI reply counts match what MongoDB holds
 * for the same period (connection from sellora-api/.env, read only); the Analytics page shows
 * value, sales and chats with charts and tables; switching to 7 days asks for 7 days and
 * updates the numbers; a chart's table view lists every day and adds up to the order count;
 * with Reports taken out of the plan (a super-admin override, put back at the end) the page
 * says it is not in the plan and the overview leaves the tiles out; phone and dark views.
 * Fails on console errors, unexpected API errors or a missing result.
 *
 * Needs a business with the All-in-one plan and some orders and chats in the last 30 days
 * (Dhaka Fashion House, owner@demo.sellora.test, after meta-flow and commerce-flow), and
 * platform admin details.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/analytics-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SELLORA_API_DIR (../sellora-api).
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
const OUT = env.SMOKE_OUT ?? 'smoke-output/analytics';
mkdirSync(OUT, { recursive: true });

const LOST = ['cancelled', 'returned'];
const CHAT_TYPES = ['text', 'image', 'audio', 'file'];
const AI_ACTOR_ID = 'ai-agent';

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

function watch(page, label, allow = () => false) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow(m.text()))
      problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (
      (s >= 500 || (s >= 400 && s !== 401 && r.url().includes('/v1/'))) &&
      !allow(`${s} ${new URL(r.url()).pathname}`)
    )
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

// The same formatting as src/lib/format.ts and src/lib/analytics.ts.
const minorDigits = (currency) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
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
const num = (n) => new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(n);
function timeSaved(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  const rounded = hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours);
  return `about ${rounded} hour${rounded === 1 ? '' : 's'}`;
}
function daysBetween(fromIso, toIso, timeZone) {
  const key = (d) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const out = [];
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += 3_600_000) {
    const k = key(new Date(t));
    if (out.at(-1) !== k) out.push(k);
  }
  return out;
}

/** The API's own database, read only, to count the period's orders and replies independently. */
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
// While Reports is out of the plan, the API is meant to refuse the report with 402.
let planOff = false;
watch(page, 'merchant', (t) => planOff && /402/.test(t));
const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await actx.newPage();
watch(admin, 'admin');

let org;
let orgId;
let savedOverrides = null;
let failed = false;

/** The value under a tile's label, e.g. "Time saved" → "about 2 hours". */
const tile = (scope, label) =>
  scope.locator(`xpath=.//p[normalize-space(.)="${label}"]/following-sibling::p[1]`);
const tileText = async (scope, label) => (await tile(scope, label).first().innerText()).trim();

const isOverview = (r) => r.url().includes('/analytics/overview') && r.status() === 200;
async function overviewFrom(responsePromise) {
  const r = await responsePromise;
  const u = new URL(r.url());
  return { o: await r.json(), from: u.searchParams.get('from'), to: u.searchParams.get('to') };
}

/** Puts the plan overrides back exactly as they were before the flow. */
async function restorePlan() {
  if (!savedOverrides) return;
  await call(admin, 'PUT', `/platform/billing/tenants/${orgId}/subscription/overrides`, {
    addModules: savedOverrides.addModules ?? [],
    removeModules: savedOverrides.removeModules ?? [],
    limits: Object.fromEntries(
      Object.entries(savedOverrides.limits ?? {}).filter(([, v]) => v !== null),
    ),
    ...(savedOverrides.expiresAt ? { expiresAt: savedOverrides.expiresAt } : {}),
    note: 'analytics-flow: overrides put back as they were',
  });
  savedOverrides = null;
}

let first;
try {
  await step('sign in (business and super-admin)', async () => {
    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    await admin.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
    await admin.click('button[type=submit]');
    await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });

    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    const answered = page.waitForResponse(isOverview, { timeout: 20_000 });
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    first = await overviewFrom(answered);
  });

  await step('the overview shows what Sellora did in the last 30 days', async () => {
    const { o, from, to } = first;
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    check(Math.abs(span - 30) < 0.01, `the overview asked for ${span} days, not 30`);
    check(o.value.ai, 'the AI sales agent part is missing (is it in the plan?)');
    const section = page.locator('section[aria-labelledby=value-heading]');
    await section
      .getByRole('heading', { name: 'What Sellora did for you in the last 30 days' })
      .waitFor();
    // The overview shows the first four headline tiles, in this order.
    const want = [
      ['Time saved', timeSaved(o.value.ai.minutesSaved)],
      ['Chats the AI handled alone', num(o.value.ai.answeredByAiOnly)],
      ...(o.value.ai.orders ? [['Orders taken by the AI', num(o.value.ai.orders.count)]] : []),
      ...(o.value.carts ? [['Carts won back', num(o.value.carts.count)]] : []),
      ...(o.value.riskyOrders ? [['Risky orders not sent', num(o.value.riskyOrders.stopped)]] : []),
    ].slice(0, 4);
    for (const [label, value] of want) {
      const shown = await tileText(section, label);
      check(shown === value, `"${label}" shows ${shown}, the API sent ${value}`);
    }
    check(
      (await tile(section, 'AI cost').count()) === 0,
      'the overview should keep AI cost for the Analytics page',
    );
    await shot(page, '01-overview-value-tiles');
  });

  await step('the API’s counts match the database for the same period', async () => {
    const { o, from, to } = first;
    const oid = new ObjectId(orgId);
    const range = { $gte: new Date(from), $lt: new Date(to) };
    const orders = await db
      .collection('orders')
      .find(
        { orgId: oid, placedAt: range, currency: o.range.currency, status: { $nin: LOST } },
        { projection: { totalMinor: 1, history: { $slice: 1 } } },
      )
      .toArray();
    const valueMinor = orders.reduce((n, x) => n + x.totalMinor, 0);
    const byAi = orders.filter((x) => x.history?.[0]?.actor?.id === AI_ACTOR_ID).length;
    const aiReplies = await db.collection('messages').countDocuments({
      orgId: oid,
      createdAt: range,
      direction: 'out',
      type: { $in: CHAT_TYPES },
      'sender.type': 'ai',
    });
    check(
      o.sales.orders === orders.length,
      `orders: API ${o.sales.orders}, database ${orders.length}`,
    );
    check(
      o.sales.valueMinor === valueMinor,
      `sales: API ${o.sales.valueMinor}, database ${valueMinor}`,
    );
    check(
      (o.value.ai.orders?.count ?? 0) === byAi,
      `AI orders: API ${o.value.ai.orders?.count}, database ${byAi}`,
    );
    check(
      o.inbox.aiReplies === aiReplies,
      `AI replies: API ${o.inbox.aiReplies}, database ${aiReplies}`,
    );
    check(
      o.value.ai.replies === aiReplies,
      `value AI replies ${o.value.ai.replies} ≠ ${aiReplies}`,
    );
    console.log(
      `  30 days: ${orders.length} orders worth ${money(valueMinor, o.range.currency)}, ${byAi} taken by the AI, ${aiReplies} AI replies`,
    );
  });

  await step('the Analytics page shows value, sales and chats for 30 days', async () => {
    const { o } = first;
    await page.getByRole('link', { name: 'Analytics', exact: true }).first().click();
    await page.waitForURL(`${BASE}${org}/analytics`);
    await page.getByRole('heading', { name: 'Analytics', level: 1 }).waitFor();
    await page.getByRole('radio', { name: '30 days' }).waitFor();
    check(
      (await page.getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')) === 'true',
      '30 days is not the chosen period',
    );
    const value = page.locator('section[aria-labelledby=value-heading]');
    await value
      .getByRole('heading', { name: 'What Sellora did for you in the last 30 days' })
      .waitFor();
    check(
      (await tileText(value, 'AI cost')) === money(o.value.ai.spentMinor, o.range.currency),
      'AI cost differs from the API',
    );
    const sales = page.locator('section[aria-labelledby=sales-heading]');
    check(
      (await tileText(sales, 'Sales')) === money(o.sales.valueMinor, o.range.currency),
      'Sales differs from the API',
    );
    check(
      (await tileText(sales, 'Delivered')) === num(o.sales.delivered),
      'Delivered differs from the API',
    );
    for (const title of [
      'Orders per day',
      'Sales per day',
      'Where orders came from',
      'Best sellers',
    ])
      await sales.getByText(title, { exact: true }).waitFor();
    const sourceRows = sales
      .locator('div.rounded-lg', { hasText: 'Where orders came from' })
      .locator('tbody tr');
    check(
      (await sourceRows.count()) === o.sales.bySource.length,
      'the order sources table has the wrong number of rows',
    );
    const chats = page.locator('section[aria-labelledby=chats-heading]');
    check(
      (await tileText(chats, 'Chats with customers')) === num(o.inbox.conversations),
      'Chats with customers differs from the API',
    );
    await chats.getByText('Replies per day', { exact: true }).waitFor();
    await chats.getByText('Chats by channel', { exact: true }).waitFor();
    check(
      (await chats.locator('svg').count()) > 0 && (await sales.locator('svg').count()) > 1,
      'charts are missing',
    );
    await shot(page, '02-analytics-30-days', true);
  });

  await step('a chart’s table view lists every day and adds up to the order count', async () => {
    const { o, from, to } = first;
    check(o.sales.orders > 0, 'no orders in the last 30 days to check the table with');
    const card = page
      .locator('section[aria-labelledby=sales-heading] div.rounded-lg')
      .filter({ has: page.getByText('Orders per day', { exact: true }) })
      .last();
    await card.getByRole('button', { name: 'Show table' }).click();
    const rows = card.locator('tbody tr');
    await rows.first().waitFor();
    const days = daysBetween(from, to, o.range.timezone);
    const count = await rows.count();
    check(count === days.length, `${count} rows for ${days.length} days`);
    const totals = await rows.evaluateAll((trs) =>
      trs.map((tr) => Number(tr.lastElementChild.textContent.replace(/,/g, ''))),
    );
    const sum = totals.reduce((a, b) => a + b, 0);
    check(sum === o.sales.orders, `the table adds up to ${sum}, not ${o.sales.orders}`);
    await card.scrollIntoViewIfNeeded();
    await shot(page, '03-orders-table-view');
    await card.getByRole('button', { name: 'Show chart' }).click();
  });

  await step('switching to 7 days asks for 7 days and updates the numbers', async () => {
    const answered = page.waitForResponse(isOverview, { timeout: 15_000 });
    await page.getByRole('radio', { name: '7 days' }).click();
    const week = await overviewFrom(answered);
    const span = (Date.parse(week.to) - Date.parse(week.from)) / 86_400_000;
    check(Math.abs(span - 7) < 0.01, `asked for ${span} days, not 7`);
    await page
      .getByRole('heading', { name: 'What Sellora did for you in the last 7 days' })
      .waitFor();
    const sales = page.locator('section[aria-labelledby=sales-heading]');
    await page.waitForFunction(() => !document.querySelector('.opacity-60'), undefined, {
      timeout: 10_000,
    });
    check(
      (await tileText(sales, 'Sales')) === money(week.o.sales.valueMinor, week.o.range.currency),
      'Sales did not change to the 7-day figure',
    );
    check(week.o.sales.orders <= first.o.sales.orders, '7 days has more orders than 30 days');
    if (week.o.sales.orders === 0) await sales.getByText('No orders in this period').waitFor();
    console.log(`  7 days: ${week.o.sales.orders} orders, ${week.o.inbox.aiReplies} AI replies`);
    await shot(page, '04-analytics-7-days');
  });

  await step(
    'without Reports in the plan, the page says so and the overview hides the tiles',
    async () => {
      const billing = await call(admin, 'GET', `/platform/billing/tenants/${orgId}`);
      const current = billing.subscription.overrides ?? {};
      check(
        !(current.removeModules ?? []).includes('analytics'),
        'Reports is already taken out of this plan',
      );
      savedOverrides = current;
      planOff = true;
      await call(admin, 'PUT', `/platform/billing/tenants/${orgId}/subscription/overrides`, {
        addModules: current.addModules ?? [],
        removeModules: [...(current.removeModules ?? []), 'analytics'],
        limits: Object.fromEntries(
          Object.entries(current.limits ?? {}).filter(([, v]) => v !== null),
        ),
        note: 'analytics-flow: Reports taken out for a check',
      });
      await page.goto(`${BASE}${org}/analytics`);
      await page.getByText('Not included in your plan').waitFor({ timeout: 15_000 });
      await shot(page, '05-not-in-plan');
      await page.goto(`${BASE}${org}`);
      await page.getByRole('heading', { level: 1 }).waitFor();
      await page.waitForLoadState('networkidle');
      check(
        (await page.locator('section[aria-labelledby=value-heading]').count()) === 0,
        'the overview still shows the value tiles',
      );
      await restorePlan();
      planOff = false;
      const answered = page.waitForResponse(isOverview, { timeout: 15_000 });
      await page.goto(`${BASE}${org}`);
      await answered;
      await page
        .getByRole('heading', { name: 'What Sellora did for you in the last 30 days' })
        .waitFor();
    },
  );

  await step('the Analytics page on a phone, and in dark mode', async () => {
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      storageState: await ctx.storageState(),
    });
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/analytics`);
    await phone.getByRole('heading', { name: 'Sales', level: 2 }).waitFor({ timeout: 15_000 });
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    check(!overflow, 'the phone view scrolls sideways');
    await shot(phone, '06-analytics-phone', true);
    await phone.close();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE}${org}/analytics`);
    await page.getByRole('heading', { name: 'Sales', level: 2 }).waitFor();
    await shot(page, '07-analytics-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });
} catch {
  failed = true;
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
} finally {
  await restorePlan().catch((err) => {
    failed = true;
    problems.push(`could not put the plan overrides back: ${String(err).slice(0, 200)}`);
  });
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
