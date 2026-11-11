/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through ad tracking (ADR 0030) in real browsers, against a running web app, API,
 * worker and storefront whose platforms point at the tracking stand-in
 * (sellora-api/scripts/tracking-stand-in.mjs). It is NOT a test against Meta, TikTok or
 * Google: the stand-in answers in their documented API shapes, and the browser tags
 * (fbevents.js, TikTok's events.js, gtag.js) are replaced by small fakes that record what
 * the page asks of them. So it proves what Sellora sends and when, not that the real
 * platforms count it.
 *
 * What it checks: Settings › Ad tracking starts empty; a wrong Meta token is refused and the
 * right one is checked and saved; TikTok and GA4 are added with their keys and Google Ads for
 * one landing page only; each test event reaches the stand-in with the test code. A store
 * shopper who came from a Facebook ad views a product, adds it to the cart, checks out and
 * orders: each step goes to the browser tags and, with the same event id, to Meta and
 * TikTok from the server, and the purchase reaches Meta, TikTok and GA4 once, with the click
 * id. With "Ask first", a landing page shopper on a phone sees the banner and nothing loads
 * until they allow it; their purchase goes to Meta and Google Ads (hashed phone) from the
 * thank-you page and to Meta and GA4 from the server. A shopper who says no loads nothing
 * and no event about their order is sent. Cancelling an order sends GA4 a refund. The
 * dashboard shows what was sent. Phone and dark screenshots too.
 *
 * Needs: the live store from stores-flow (Nakshi Ghor, shop@demo.sellora.test) with the
 * Inside Dhaka delivery area, the tracking stand-in, the API and worker started with
 * TRACKING_META_BASE_URL=http://127.0.0.1:4120/meta, TRACKING_TIKTOK_BASE_URL=…/tiktok and
 * TRACKING_GA4_BASE_URL=…/ga4, and platform admin details (to approve the landing page).
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… SMOKE_ADMIN_EMAIL=… \
 *   SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… node scripts/ad-tracking-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), TRACKING_STAND_IN_URL
 * (http://127.0.0.1:4120).
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const STAND_IN = (env.TRACKING_STAND_IN_URL ?? 'http://127.0.0.1:4120').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/ad-tracking';
mkdirSync(OUT, { recursive: true });

const SLUG = 'ads-check';
const CLICK = 'IwAR0flowclick12345';
const run = String(Date.now()).slice(-6);
const phone = (n) => `017${run}${String(n).padStart(2, '0')}`;
const sha = (v) => createHash('sha256').update(v).digest('hex');

/** The stand-in's demo ids and keys, typed into Settings › Ad tracking as a business would. */
const KEYS = {
  meta: { pixelId: '1234567890123456', token: 'demo-meta-capi-token-not-real', test: 'TEST12345' },
  tiktok: {
    pixelCode: 'CDEMOPIXEL000000001',
    token: 'demo-tiktok-events-token-not-real',
    test: 'TEST67890',
  },
  ga4: { id: 'G-DEMO123456', secret: 'demo-ga4-api-secret-not-real' },
  googleAds: { id: 'AW-123456789', label: 'AbCdEf12' },
};

// Fakes for the platforms' browser scripts: they record what the page asks of the tags.
const RECORD = `function __rec(c){(window.__adCalls=window.__adCalls||[]).push(c);if(window.__adRecord)window.__adRecord(JSON.stringify(c));}`;
const META_JS = `(function(){${RECORD}
var f=window.fbq;var q=f.queue.slice();f.queue.length=0;
f.callMethod=function(){__rec(['meta'].concat([].slice.call(arguments)));};
q.forEach(function(a){__rec(['meta'].concat([].slice.call(a)));});
if(!/(^|; )_fbp=/.test(document.cookie))document.cookie='_fbp=fb.1.'+Date.now()+'.1234567890; path=/';
var m=/[?&]fbclid=([^&]+)/.exec(location.search);if(m)document.cookie='_fbc=fb.1.'+Date.now()+'.'+m[1]+'; path=/';
})();`;
const TIKTOK_JS = `(function(){${RECORD}
var t=window.ttq;if(t.__fake)return;t.__fake=true;
function mk(code){var o={};t.methods.forEach(function(m){o[m]=function(){__rec(['tiktok',code,m].concat([].slice.call(arguments)));};});return o;}
var g=[].slice.call(t);t.length=0;var G=mk('*');t.methods.forEach(function(m){t[m]=G[m];});
g.forEach(function(c){__rec(['tiktok','*',c[0]].concat(c.slice(1)));});
var inst={};Object.keys(t._i||{}).forEach(function(code){var q=[].slice.call(t._i[code]);inst[code]=mk(code);q.forEach(function(c){__rec(['tiktok',code,c[0]].concat(c.slice(1)));});});
t.instance=function(code){return inst[code]||(inst[code]=mk(code));};
if(!/(^|; )_ttp=/.test(document.cookie))document.cookie='_ttp=flowttp0123456789abcdef; path=/';
})();`;
const GTAG_JS = `(function(){${RECORD}
var dl=window.dataLayer=window.dataLayer||[];if(dl.__fake)return;dl.__fake=true;
dl.forEach(function(a){__rec(['google'].concat([].slice.call(a)));});
var push=dl.push.bind(dl);dl.push=function(a){__rec(['google'].concat([].slice.call(a)));return push(a);};
if(!/(^|; )_ga=/.test(document.cookie))document.cookie='_ga=GA1.1.123456789.1700000000; path=/';
var s=Math.floor(Date.now()/1000);document.cookie='_ga_DEMO123456=GS2.1.s'+s+'$o1$g1$t'+s+'$j0$l0$h0; path=/';
})();`;

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

function watch(page, label, expected = []) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text()))
      if (!expected.some((e) => m.text().includes(e)))
        problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    const path = new URL(r.url()).pathname;
    if (expected.some((e) => `${s} ${path}`.startsWith(e))) return;
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
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
}

/** Calls the API from inside a signed-in page (cookies and the realm's CSRF header). */
async function call(page, method, path, body, { allow = [] } = {}) {
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
  if (r.status >= 400 && !allow.includes(r.status))
    throw new Error(
      `${method} ${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  return allow.length ? r : r.body;
}

/** Keeps the answer to each request to `path` in the tab's session storage as it arrives. */
async function keepAnswers(p, path) {
  await p.addInitScript((path) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await original(input, init);
      const url = typeof input === 'string' ? input : input.url;
      if (new URL(url, location.href).pathname === path)
        sessionStorage.setItem(
          '__flow_answer',
          JSON.stringify({ status: res.status, body: await res.clone().json() }),
        );
      return res;
    };
  }, path);
}

async function keptAnswer(p) {
  const raw = await p.evaluate(() => sessionStorage.getItem('__flow_answer'));
  check(raw, 'no answer was kept');
  return JSON.parse(raw);
}

async function standIn(path, init) {
  const res = await fetch(`${STAND_IN}${path}`, init);
  if (!res.ok) throw new Error(`stand-in ${path} answered ${res.status}`);
  return res.json();
}

/** Waits until the stand-in has received every event `want` describes. */
async function received(want, label, timeout = 30_000) {
  const until = Date.now() + timeout;
  let events = [];
  while (Date.now() < until) {
    events = await standIn('/__events');
    const missing = want.filter(
      (w) =>
        !events.some(
          (e) =>
            e.platform === w.platform &&
            e.event === w.event &&
            e.status === 'taken' &&
            (w.eventId === undefined || e.eventId === w.eventId),
        ),
    );
    if (!missing.length) return events;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `${label}: the stand-in did not receive ${JSON.stringify(
      want.filter(
        (w) =>
          !events.some(
            (e) =>
              e.platform === w.platform &&
              e.event === w.event &&
              (w.eventId === undefined || e.eventId === w.eventId),
          ),
      ),
    )}`,
  );
}

/** A shopper's browser whose tag scripts are the recording fakes. */
async function shopperContext(opts) {
  const c = await browser.newContext(opts);
  const calls = [];
  const loads = [];
  await c.exposeFunction('__adRecord', (json) => calls.push(JSON.parse(json)));
  const fake = (body) => async (route) => {
    loads.push(route.request().url());
    await route.fulfill({ contentType: 'application/javascript', body });
  };
  await c.route('https://connect.facebook.net/**', fake(META_JS));
  await c.route('https://analytics.tiktok.com/**', fake(TIKTOK_JS));
  await c.route('https://www.googletagmanager.com/**', fake(GTAG_JS));
  return { c, calls, loads };
}

/** Waits for a recorded tag call. */
async function tagCall(calls, test, label, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const hit = calls.find(test);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no tag call: ${label}`);
}

const metaCall = (event) => (c) => c[0] === 'meta' && c[1] === 'trackSingle' && c[3] === event;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await actx.newPage();
// The wrong Meta token is refused on purpose.
watch(page, 'merchant', [
  '422 /v1/orgs',
  'Failed to load resource: the server responded with a status of 422',
]);
watch(admin, 'admin');
let failed = false;
let org;
let orgId;
let store;
let landing;
const placed = [];
let storeOrder;
let storeShopper;

function phoneOptions() {
  return {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };
}

async function trackingPage() {
  await page.goto(`${BASE}${org}/settings/ad-tracking`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  await page.locator('a[aria-current=page]', { hasText: 'Ad tracking' }).waitFor();
}

async function openAdd(name) {
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: `Add ${name}` }).waitFor();
  return dialog;
}

async function orderByNumber(number) {
  const list = await call(page, 'GET', `/orgs/${orgId}/orders?q=${encodeURIComponent(number)}`);
  const o = list.items.find((x) => x.number === number);
  check(o, `order ${number} not found`);
  return o;
}

try {
  await step('sign in (business and super-admin), start with no tracking id', async () => {
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
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();

    const stores = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = stores.items.find((s) => s.status === 'live');
    check(store, 'the business needs a live store (run stores-flow first)');

    const o = await call(page, 'GET', `/orgs/${orgId}/ad-tracking`);
    for (const d of o.destinations)
      await call(page, 'DELETE', `/orgs/${orgId}/ad-tracking/destinations/${d.id}`);
    await call(page, 'PATCH', `/orgs/${orgId}/ad-tracking/settings`, { consent: 'off' });
    await standIn('/__reset', { method: 'POST' });

    const pages = await call(page, 'GET', `/orgs/${orgId}/landing-pages?limit=100`);
    for (const p of pages.items.filter((x) => x.slug === SLUG)) {
      if (p.takedown) await call(admin, 'POST', `/platform/landing-pages/${p.id}/reinstate`);
      await call(page, 'DELETE', `/orgs/${orgId}/landing-pages/${p.id}`);
    }
    const products = await call(page, 'GET', `/orgs/${orgId}/products?q=Gamchha&status=active`);
    const gamchha = products.items.find((x) => x.name === 'Handloom Gamchha');
    check(gamchha, 'the demo gamchha is missing');
    const made = await call(page, 'POST', `/orgs/${orgId}/landing-pages`, {
      storeId: store.id,
      name: 'Gamchha ads check',
      slug: SLUG,
      productId: gamchha.id,
      template: 'quick_order',
      language: 'en',
    });
    const sent = await call(page, 'POST', `/orgs/${orgId}/landing-pages/${made.id}/submit`);
    if (sent.submission?.status === 'pending')
      await call(admin, 'POST', `/platform/landing-pages/${made.id}/approve`, {
        revision: sent.submission.revision,
      });
    landing = made;
  });

  await step('Settings › Ad tracking starts empty', async () => {
    await page.goto(`${BASE}${org}/settings`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Ad tracking', exact: true }).click();
    await page.waitForURL('**/settings/ad-tracking');
    await page.getByText('No pixel or tag yet').waitFor();
    await page.getByText('Asking shoppers first').waitFor();
    await shot(page, '01-ad-tracking-empty', true);
  });

  await step('a wrong Meta token is refused; the right one is checked and saved', async () => {
    const dialog = await openAdd('Meta Pixel');
    await dialog.getByLabel(/^Pixel \(dataset\) ID/).fill('12345');
    await dialog.getByRole('button', { name: 'Check and save' }).click();
    await dialog.getByText('This is not a Meta Pixel Pixel (dataset) ID').waitFor();
    await dialog.getByLabel(/^Pixel \(dataset\) ID/).fill(KEYS.meta.pixelId);
    await dialog.getByLabel(/^Name/).fill('Facebook and Instagram ads');
    await dialog.getByLabel(/^Conversions API access token/).fill('demo-wrong-token-not-real');
    await dialog.getByLabel(/^Test event code/).fill(KEYS.meta.test);
    await dialog.getByRole('button', { name: 'Check and save' }).click();
    await dialog
      .getByText(/Meta did not accept this pixel and token: Meta refused the access token/)
      .waitFor({ timeout: 15_000 });
    await dialog.screenshot({ path: join(OUT, '02-meta-token-refused.png') });
    await dialog.getByLabel(/^Conversions API access token/).fill(KEYS.meta.token);
    await dialog.getByRole('button', { name: 'Check and save' }).click();
    await page
      .getByText('Meta accepted the token for the pixel “Demo Pixel (stand-in)”.')
      .first()
      .waitFor({ timeout: 15_000 });
    await dialog.waitFor({ state: 'detached' });
  });

  await step('TikTok and GA4 with their keys; Google Ads for the landing page only', async () => {
    let dialog = await openAdd('TikTok Pixel');
    await dialog.getByLabel(/^Pixel ID/).fill(KEYS.tiktok.pixelCode.toLowerCase());
    await dialog.getByLabel(/^Events API access token/).fill(KEYS.tiktok.token);
    await dialog.getByLabel(/^Test event code/).fill(KEYS.tiktok.test);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });

    dialog = await openAdd('Google Analytics 4');
    await dialog.getByLabel(/^Measurement ID/).fill(KEYS.ga4.id);
    await dialog.getByLabel(/^Measurement Protocol API secret/).fill(KEYS.ga4.secret);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });

    dialog = await openAdd('Google Ads');
    await dialog.getByLabel(/^Conversion ID/).fill(KEYS.googleAds.id);
    await dialog.getByLabel(/^Purchase conversion label/).fill(KEYS.googleAds.label);
    await dialog.getByRole('switch', { name: 'Everywhere' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.getByText('Choose at least one store or landing page').waitFor();
    await dialog.getByLabel(/Gamchha ads check/).check();
    await dialog.screenshot({ path: join(OUT, '03-google-ads-where.png') });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });

    const o = await call(page, 'GET', `/orgs/${orgId}/ad-tracking`);
    check(o.destinations.length === 4, `${o.destinations.length} tracking ids`);
    const tiktok = o.destinations.find((d) => d.platform === 'tiktok');
    check(tiktok.publicId === KEYS.tiktok.pixelCode, `TikTok id kept as ${tiktok.publicId}`);
    const ads = o.destinations.find((d) => d.platform === 'google_ads');
    check(
      !ads.everywhere && ads.landingPageIds.length === 1 && ads.landingPageIds[0] === landing.id,
      `Google Ads scope: ${JSON.stringify(ads)}`,
    );
    // Nothing secret comes back: only a hint.
    const raw = JSON.stringify(o);
    check(
      !raw.includes(KEYS.meta.token) &&
        !raw.includes(KEYS.tiktok.token) &&
        !raw.includes(KEYS.ga4.secret),
      'a key came back',
    );
    await page.getByText('The landing page Gamchha ads check').waitFor();
    await shot(page, '04-ad-tracking-added', true);
  });

  await step('each test event reaches the platform with the test code', async () => {
    for (const [name, toast] of [
      ['Facebook and Instagram ads', 'Meta took the test event'],
      [`TikTok Pixel ${KEYS.tiktok.pixelCode.slice(-4)}`, 'TikTok took the test event'],
      [`Google Analytics 4 ${KEYS.ga4.id.slice(-4)}`, 'Google Analytics took the test event'],
    ]) {
      const card = page.getByRole('group', { name, exact: true });
      await card.getByRole('button', { name: 'Send test event' }).click();
      await page.getByText(toast, { exact: false }).first().waitFor({ timeout: 15_000 });
    }
    const events = await received(
      [
        { platform: 'meta', event: 'ViewContent' },
        { platform: 'tiktok', event: 'ViewContent' },
        { platform: 'ga4', event: 'sellora_test' },
      ],
      'test events',
    );
    check(
      events.filter((e) => e.test).length >= 3,
      'test events were not marked with the test code',
    );
    await shot(page, '05-test-events-sent', true);
  });

  await step('a store shopper from a Facebook ad: view, cart, checkout, order', async () => {
    storeShopper = await shopperContext({ viewport: { width: 1280, height: 900 } });
    const { c, calls, loads } = storeShopper;
    const p = await c.newPage();
    watch(p, 'store shopper');
    await keepAnswers(p, '/api/checkout');
    await p.goto(
      `${store.url}/products/nakshi-kantha-throw?utm_source=facebook&utm_campaign=winter&fbclid=${CLICK}`,
      { waitUntil: 'networkidle' },
    );
    const view = await tagCall(calls, metaCall('ViewContent'), 'Meta ViewContent');
    const viewId = view[5].eventID;
    check(/^view\./.test(viewId), `view id ${viewId}`);
    await tagCall(
      calls,
      (x) =>
        x[0] === 'tiktok' &&
        x[1] === KEYS.tiktok.pixelCode &&
        x[2] === 'track' &&
        x[3] === 'ViewContent' &&
        x[5]?.event_id === viewId,
      'TikTok ViewContent with the same id',
    );
    await tagCall(
      calls,
      (x) => x[0] === 'google' && x[1] === 'event' && x[2] === 'view_item',
      'GA4 view_item',
    );
    await tagCall(
      calls,
      (x) => x[0] === 'meta' && x[1] === 'track' && x[2] === 'PageView',
      'Meta PageView',
    );
    check(
      !calls.some((x) => x[0] === 'google' && x[1] === 'config' && String(x[2]).startsWith('AW-')),
      'Google Ads loaded on the store, though it is kept for the landing page',
    );
    await shot(p, '06-store-product');
    await p.getByRole('button', { name: 'Add to cart' }).click();
    const cart = await tagCall(calls, metaCall('AddToCart'), 'Meta AddToCart');
    await p.goto(`${store.url}/checkout`, { waitUntil: 'networkidle' });
    const checkout = await tagCall(calls, metaCall('InitiateCheckout'), 'Meta InitiateCheckout');
    await p.getByLabel('Full name').fill('Sadia Islam');
    await p.getByLabel('Mobile number').fill(phone(1));
    await p.getByLabel('House, road, village').fill('House 9, Road 4, Dhanmondi');
    await p.getByLabel('City').fill('Dhaka');
    await p.getByLabel('Inside Dhaka').check();
    await p.getByRole('button', { name: /^Place order/ }).click();
    await p.waitForURL('**/order?**new=1**', { timeout: 20_000 });
    const { status, body } = await keptAnswer(p);
    check(status === 201, `checkout answered ${status}`);
    placed.push(body.orderNumber);
    const purchase = await tagCall(calls, metaCall('Purchase'), 'Meta Purchase on the receipt');
    const purchaseId = purchase[5].eventID;
    check(/^purchase\.[a-f0-9]{24}$/.test(purchaseId), `purchase id ${purchaseId}`);
    check(purchase[4].order_id === body.orderNumber, 'the browser purchase has no order number');
    await tagCall(
      calls,
      (x) =>
        x[0] === 'tiktok' &&
        x[2] === 'track' &&
        x[3] === 'Purchase' &&
        x[5]?.event_id === purchaseId,
      'TikTok Purchase with the same id',
    );
    check(
      !calls.some((x) => x[0] === 'google' && x[1] === 'event' && x[2] === 'purchase'),
      'GA4 got a purchase from the browser too (it must come from the server only)',
    );
    await shot(p, '07-store-receipt');
    // A reload of the receipt does not report the purchase again.
    const before = calls.filter(metaCall('Purchase')).length;
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    check(calls.filter(metaCall('Purchase')).length === before, 'the purchase was reported twice');
    check(loads.length >= 3, `tag scripts loaded: ${loads.length}`);

    // The same events, with the same ids, from the server; the purchase once per platform.
    const events = await received(
      [
        { platform: 'meta', event: 'ViewContent', eventId: viewId },
        { platform: 'tiktok', event: 'ViewContent', eventId: viewId },
        { platform: 'meta', event: 'AddToCart', eventId: cart[5].eventID },
        { platform: 'meta', event: 'InitiateCheckout', eventId: checkout[5].eventID },
        { platform: 'meta', event: 'Purchase', eventId: purchaseId },
        { platform: 'tiktok', event: 'Purchase', eventId: purchaseId },
        { platform: 'ga4', event: 'purchase', eventId: body.orderNumber },
      ],
      'store events',
    );
    const metaPurchase = events.filter((e) => e.platform === 'meta' && e.eventId === purchaseId);
    check(metaPurchase.length === 1, `Meta got the purchase ${metaPurchase.length} times`);
    const u = metaPurchase[0].data.user_data;
    check(
      u.ph?.[0] === sha(`880${phone(1).slice(1)}`) &&
        /^fb\.1\.\d{13}\.IwAR0flowclick12345$/.test(u.fbc ?? ''),
      `Meta purchase user data: ${JSON.stringify(u)}`,
    );
    check(
      metaPurchase[0].data.custom_data.order_id === body.orderNumber,
      'Meta purchase without the order number',
    );
    storeOrder = body.orderNumber;
    await c.close();
  });

  await step('the stand-in shows what a platform would have received', async () => {
    const s = await browser.newPage();
    await s.goto(`${STAND_IN}/`, { waitUntil: 'domcontentloaded' });
    await s.getByRole('heading', { name: 'Ad tracking stand-in' }).waitFor();
    await shot(s, '08-stand-in-received');
    await s.close();
  });

  await step(
    'with “Ask first”, nothing loads on a landing page until the shopper allows it',
    async () => {
      await trackingPage();
      await page.getByRole('radio', { name: 'Ask first' }).click();
      await page.getByText('Shoppers are asked first.', { exact: false }).waitFor();

      const { c, calls, loads } = await shopperContext(phoneOptions());
      const p = await c.newPage();
      watch(p, 'landing shopper');
      await keepAnswers(p, `/api/landing/${SLUG}/order`);
      await p.goto(`${store.url}/${SLUG}?utm_source=google&gclid=flow-gclid-1`, {
        waitUntil: 'networkidle',
      });
      const banner = p.getByRole('region', { name: 'Ads and analytics' });
      await banner.waitFor();
      await p.waitForTimeout(800);
      check(
        loads.length === 0 && calls.length === 0,
        `tags loaded before the shopper agreed: ${loads.join(', ')}`,
      );
      await shot(p, '09-landing-consent-banner');
      await banner.getByRole('button', { name: 'Allow' }).click();
      await banner.waitFor({ state: 'detached' });
      const view = await tagCall(calls, metaCall('ViewContent'), 'Meta ViewContent after allowing');
      await tagCall(
        calls,
        (x) => x[0] === 'google' && x[1] === 'config' && x[2] === KEYS.googleAds.id,
        'Google Ads on its landing page',
      );
      await p.locator('#order').scrollIntoViewIfNeeded();
      await p.getByLabel('Full name').fill('Mitu Akter');
      await tagCall(calls, metaCall('InitiateCheckout'), 'Meta InitiateCheckout on the form');
      await p.getByLabel('Mobile number').fill(phone(2));
      await p.getByLabel(/Full address/).fill('Ward 2, Kazir Dewri, Chattogram');
      await p.getByLabel('Inside Dhaka').check();
      await p.locator('#order button[type=submit]').click();
      await p.waitForURL(`**/${SLUG}/thanks?**`, { timeout: 20_000 });
      const { status, body } = await keptAnswer(p);
      check(status === 201, `landing order answered ${status}`);
      placed.push(body.orderNumber);
      const purchase = await tagCall(
        calls,
        metaCall('Purchase'),
        'Meta Purchase on the thank-you page',
      );
      const purchaseId = purchase[5].eventID;
      const userData = await tagCall(
        calls,
        (x) => x[0] === 'google' && x[1] === 'set' && x[2] === 'user_data',
        'Google Ads enhanced conversion data',
      );
      check(
        userData[3].sha256_phone_number === sha(`+880${phone(2).slice(1)}`),
        `enhanced conversions: ${JSON.stringify(userData[3])}`,
      );
      const conv = await tagCall(
        calls,
        (x) => x[0] === 'google' && x[1] === 'event' && x[2] === 'conversion',
        'Google Ads conversion',
      );
      check(
        conv[3].send_to === `${KEYS.googleAds.id}/${KEYS.googleAds.label}` &&
          conv[3].transaction_id === body.orderNumber,
        `conversion: ${JSON.stringify(conv[3])}`,
      );
      await shot(p, '10-landing-thanks', true);
      await received(
        [
          { platform: 'meta', event: 'ViewContent', eventId: view[5].eventID },
          { platform: 'meta', event: 'Purchase', eventId: purchaseId },
          { platform: 'ga4', event: 'purchase', eventId: body.orderNumber },
        ],
        'landing events',
      );
      await c.close();
    },
  );

  await step(
    'a shopper who says no: no tag loads and nothing about their order is sent',
    async () => {
      const { c, calls, loads } = await shopperContext(phoneOptions());
      const p = await c.newPage();
      watch(p, 'declining shopper');
      await keepAnswers(p, `/api/landing/${SLUG}/order`);
      await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
      const banner = p.getByRole('region', { name: 'Ads and analytics' });
      await banner.getByRole('button', { name: 'No thanks' }).click();
      await banner.waitFor({ state: 'detached' });
      await p.locator('#order').scrollIntoViewIfNeeded();
      await p.getByLabel('Full name').fill('Rumana Haque');
      await p.getByLabel('Mobile number').fill(phone(3));
      await p.getByLabel(/Full address/).fill('Sector 7, Uttara, Dhaka');
      await p.getByLabel('Inside Dhaka').check();
      await p.locator('#order button[type=submit]').click();
      await p.waitForURL(`**/${SLUG}/thanks?**`, { timeout: 20_000 });
      const { body } = await keptAnswer(p);
      placed.push(body.orderNumber);
      await p.waitForTimeout(4000);
      check(
        loads.length === 0 && calls.length === 0,
        `tags loaded after a no: ${loads.join(', ')}`,
      );
      const events = await standIn('/__events');
      check(
        !events.some(
          (e) =>
            e.eventId === body.orderNumber || e.data?.custom_data?.order_id === body.orderNumber,
        ),
        'an event about the declining shopper’s order was sent',
      );
      await c.close();
    },
  );

  await step('cancelling the store order sends Google Analytics a refund', async () => {
    const o = await orderByNumber(storeOrder);
    await call(page, 'POST', `/orgs/${orgId}/orders/${o.id}/cancel`, { reason: 'Browser check' });
    placed.splice(placed.indexOf(storeOrder), 1);
    await received([{ platform: 'ga4', event: 'refund', eventId: storeOrder }], 'refund');
  });

  await step('the dashboard shows what was sent', async () => {
    await trackingPage();
    const card = page.getByRole('group', { name: 'Facebook and Instagram ads', exact: true });
    await card.getByText(/\d+ sent in the last 7 days/).waitFor();
    await card.getByRole('button', { name: 'What was sent' }).click();
    await card
      .getByRole('cell', { name: new RegExp(`Order ${storeOrder}`) })
      .first()
      .waitFor();
    await card.getByText('Meta took it.').first().waitFor();
    await shot(page, '11-what-was-sent', true);
  });

  await step('phone and dark layouts', async () => {
    const c = await browser.newContext(phoneOptions());
    const p = await c.newPage();
    watch(p, 'merchant phone');
    await p.goto(`${BASE}/login`);
    await p.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await p.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await p.click('button[type=submit]');
    await p.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    await p.goto(`${BASE}${org}/settings/ad-tracking`, { waitUntil: 'networkidle' });
    await p.getByText('Asking shoppers first').waitFor();
    await shot(p, '12-ad-tracking-phone', true);
    await c.close();

    await page.emulateMedia({ colorScheme: 'dark' });
    await trackingPage();
    await shot(page, '13-ad-tracking-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });
} catch (err) {
  failed = true;
  console.error(`\nStopped: ${String(err).split('\n')[0]}`);
  await shot(page, 'zz-failure', true).catch(() => {});
} finally {
  // The next run starts the same way: test orders cancelled, page and tracking ids removed,
  // so other browser checks never load these tags.
  if (orgId) {
    for (const number of placed)
      await orderByNumber(number)
        .then((o) =>
          call(page, 'POST', `/orgs/${orgId}/orders/${o.id}/cancel`, { reason: 'Browser check' }),
        )
        .catch((e) => problems.push(`could not cancel ${number}: ${String(e).slice(0, 120)}`));
    if (landing)
      await call(page, 'DELETE', `/orgs/${orgId}/landing-pages/${landing.id}`).catch(() => {});
    await call(page, 'GET', `/orgs/${orgId}/ad-tracking`)
      .then(async (o) => {
        for (const d of o.destinations)
          await call(page, 'DELETE', `/orgs/${orgId}/ad-tracking/destinations/${d.id}`);
        await call(page, 'PATCH', `/orgs/${orgId}/ad-tracking/settings`, { consent: 'off' });
      })
      .catch((e) => problems.push(`could not remove tracking ids: ${String(e).slice(0, 120)}`));
  }
  await browser.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? ` (${s.ms} ms)` : `: ${s.error}`}`);
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`  ${p}`);
}
console.log(`\nScreenshots in ${OUT}/`);
process.exit(failed || problems.length ? 1 : 0);
