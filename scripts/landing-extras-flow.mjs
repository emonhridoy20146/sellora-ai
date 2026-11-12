/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through the landing page extras (ADR 0031) in a real browser, against a running
 * web app, API, worker and storefront app. The merchant account should own the demo
 * business Nakshi Ghor (`npm run dev:seed` in sellora-api, shop@demo.sellora.test) with the
 * open store stores-flow leaves behind.
 *
 * What it checks: the template gallery by kind of business (Fashion › Eid and festive
 * wear); the "Add section" menu in groups; a coupon made on the Coupons page; the new
 * sections written and published; a shopper on a phone tapping "Use this code" on the
 * coupon banner and "Choose" on a package card, the order taking the coupon off; the coupon
 * on the order and its use counted; a coupon at the store checkout; a version scheduled
 * for a minute later (time changed once) that the worker makes live by itself; an A/B test
 * where two browsers see the two versions, a buyer of version B counted, and B made live;
 * an offer end the worker turns into a paused page; "Save as template" and the template in
 * "My templates"; and a Bangla library template in preview. Fails on console errors,
 * unexpected API errors or a missing result. Turns the platform's automatic approval of
 * clean pages on for the run and back as it was at the end; cancels the orders it placed.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… \
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
 *   node scripts/landing-extras-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SMOKE_OUT (smoke-output/landing-extras),
 * STORE_HANDLE (nakshi-ghor).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/landing-extras';
const HANDLE = env.STORE_HANDLE ?? 'nakshi-ghor';
const SLUG = 'festive-panjabi';
const BN_SLUG = 'herbal-tea-bn';
const HEADLINE_A = 'Eid Panjabi, stitched by hand';
const HEADLINE_SCHEDULED = 'Chand Raat sale: Eid Panjabi, stitched by hand';
const HEADLINE_B = 'The Eid Panjabi your father will wear every Friday';
// A new code each run: a used coupon stays for the record and cannot be renamed.
const CODE = `EID${String(Date.now()).slice(-4)}`;
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

function watch(page, label) {
  page.on('console', (m) => {
    // A 401 is the app's signal to refresh its short-lived token and retry (the response
    // check below treats it the same way); the super-admin token lasts five minutes.
    if (m.type() === 'error' && !m.text().includes('status of 401'))
      problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    const url = new URL(r.url());
    const ours = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/');
    const isPage = r.request().resourceType() === 'document';
    if (s >= 500 || (s >= 400 && s !== 401 && (ours || isPage)))
      problems.push(`${label} ${s} ${r.request().method()} ${url.pathname}`);
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

/** Calls the API from inside a signed-in page (cookies and CSRF header included). */
async function call(page, method, path, body) {
  const r = await page.evaluate(
    async ({ method, path, body }) => {
      const name = path.startsWith('/platform') ? 'slp_csrf=' : 'sl_csrf=';
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
      `${method} ${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
    );
  return r.body;
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function until(what, fn, timeoutMs, everyMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** The page's sections, written by the business (no template words left). */
function sections(headline) {
  let n = 0;
  const id = () => `fx${String(++n).padStart(4, '0')}`;
  const s = (type, fields) => ({ id: id(), type, enabled: true, hideOn: 'none', ...fields });
  return [
    s('announcement', { text: 'Free delivery inside Dhaka until Chand Raat', tone: 'offer' }),
    s('hero', {
      heading: headline,
      subheading: 'Soft cotton, flowers stitched on the placket and cuffs by artisans in Jashore.',
      badge: 'Eid 2026',
      buttonLabel: 'Order now',
      image: null,
      showPrice: true,
    }),
    s('orders_today', { text: '{count} people ordered from this page today', minCount: 1 }),
    s('features', {
      title: 'Why it is worth it',
      items: [
        { icon: 'gift', title: 'Hand embroidery', text: 'Every flower is stitched by hand.' },
        { icon: 'truck', title: 'Fast delivery', text: 'Two days inside Dhaka.' },
        { icon: 'return', title: 'Easy exchange', text: 'Wrong size? Exchange within 7 days.' },
        { icon: 'cash', title: 'Cash on delivery', text: 'Check it first, then pay.' },
      ],
    }),
    s('gallery', { title: 'Close up', source: 'product', images: [] }),
    s('comparison', {
      title: 'Ours and the market’s',
      ourLabel: 'Nakshi Ghor',
      otherLabel: 'Market panjabi',
      rows: [
        { label: 'Embroidery', ours: 'By hand', others: 'Machine print' },
        { label: 'Fabric', ours: 'Cotton blend', others: 'Polyester' },
        { label: 'Exchange', ours: '7 days', others: 'None' },
      ],
    }),
    s('size_chart', {
      title: 'Find your size',
      columns: ['Size', 'Chest (in)', 'Length (in)'],
      rows: [
        { cells: ['M', '40', '42'] },
        { cells: ['L', '42', '43'] },
        { cells: ['XL', '44', '44'] },
      ],
      note: 'Between two sizes? Take the larger one.',
    }),
    s('who_for', {
      title: 'Is it for you?',
      forTitle: 'For you if',
      forItems: ['You want something handmade for Eid', 'You like soft, breathable cotton'],
      notForTitle: 'Not for you if',
      notForItems: ['You need it delivered abroad'],
    }),
    s('timeline', {
      title: 'After you order',
      items: [
        { label: 'Today', text: 'We call you to confirm the size and address.' },
        { label: 'Day 2', text: 'The parcel leaves our workshop in Jashore.' },
        { label: 'Day 3–4', text: 'It reaches you; pay the rider in cash.' },
      ],
    }),
    s('packages', { heading: 'Choose your package', text: 'A pair costs less than two singles.' }),
    s('coupon_banner', {
      heading: 'Eid gift: 10% off',
      code: CODE,
      text: 'Tap the button and the code goes into your order.',
    }),
    s('payment_methods', { heading: 'How to pay', text: '' }),
    s('order_form', {
      heading: 'Order now',
      subheading: 'We call you before sending it.',
      buttonLabel: 'Confirm order',
    }),
    s('faq', {
      title: 'Questions',
      items: [{ question: 'Can I exchange the size?', answer: 'Yes, within 7 days.' }],
    }),
    s('location', {
      heading: 'Visit the workshop',
      address: 'Nakshi Ghor, 12 Rail Road, Jashore',
      hours: 'Saturday to Thursday, 10 am to 7 pm',
      mapUrl: 'https://maps.app.goo.gl/nakshiGhorDemo1',
    }),
    s('spacer', { size: 'small', line: true }),
    s('call_to_action', {
      heading: 'Eid is close',
      text: 'Order today and it reaches you before Chand Raat.',
      buttonLabel: 'Order now',
    }),
  ];
}

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
let lp;
let autoApproveBefore = null;
let coupon;
const placedOrders = [];
const phoneNo = (i) => `018${String(Date.now()).slice(-7)}${i}`;

async function phoneContext() {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
}

const getPage = () => call(page, 'GET', `/orgs/${orgId}/landing-pages/${lp.id}`);
const saveDraft = async (content) => {
  const cur = await getPage();
  lp = await call(page, 'PUT', `/orgs/${orgId}/landing-pages/${lp.id}/draft`, {
    content: { ...cur.draft, ...content },
    revision: cur.revision,
  });
  return lp;
};

try {
  await step('sign in, automatic approval on for the run, clear earlier pages', async () => {
    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    await admin.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    await admin.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
    await admin.click('button[type=submit]');
    await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });
    const settings = await call(admin, 'GET', '/platform/settings');
    autoApproveBefore = settings.stores.autoApproveLandingPages;
    if (!autoApproveBefore)
      await call(admin, 'PATCH', '/platform/settings', {
        stores: { autoApproveLandingPages: true },
      });

    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    // The demo shop starts on a 14-day trial. Once it ends the shop drops to Free, which
    // has no store or landing pages, so the platform owner gives it the full plan again.
    const billing = await call(admin, 'GET', `/platform/billing/tenants/${orgId}`);
    const mods = billing.subscription.entitlements.modules;
    if (!['storefront', 'landing_pages', 'commerce', 'marketing'].every((m) => mods.includes(m))) {
      console.log(`  plan was ${billing.subscription.plan.code}; giving the demo shop all-in-one`);
      await call(admin, 'PUT', `/platform/billing/tenants/${orgId}/subscription`, {
        planCode: 'all-in-one',
        interval: 'month',
        note: 'Demo shop: browser check of landing page extras',
      });
    }
    const stores = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = stores.items.find((s) => s.handle === HANDLE);
    check(store && store.status === 'live', `run stores-flow first: ${HANDLE} must be open`);
    const { items } = await call(page, 'GET', `/orgs/${orgId}/landing-pages`);
    for (const p of items.filter((x) => [SLUG, BN_SLUG].includes(x.slug))) {
      if (p.takedown) await call(admin, 'POST', `/platform/landing-pages/${p.id}/reinstate`);
      await call(page, 'DELETE', `/orgs/${orgId}/landing-pages/${p.id}`);
    }
    // Coupons and templates earlier runs left: unused ones go, used ones are switched off.
    const coupons = await call(page, 'GET', `/orgs/${orgId}/coupons`);
    for (const c of coupons.items.filter((x) => x.note === 'Browser check'))
      if (c.used === 0) await call(page, 'DELETE', `/orgs/${orgId}/coupons/${c.id}`);
      else if (c.active)
        await call(page, 'PATCH', `/orgs/${orgId}/coupons/${c.id}`, { active: false });
    const templates = await call(page, 'GET', `/orgs/${orgId}/landing-pages/templates`);
    for (const t of templates.mine.items.filter((x) => x.name === 'Festive layout'))
      await call(page, 'DELETE', `/orgs/${orgId}/landing-pages/templates/${t.id}`);
  });

  await step('template gallery: Fashion › Eid and festive wear', async () => {
    await page.goto(`${BASE}${org}/landing-pages/new`, { waitUntil: 'networkidle' });
    await page.fill('#lp-product', 'Eid Panjabi');
    await page.getByRole('button', { name: /Embroidered Eid Panjabi/ }).click();
    await page.getByRole('tab', { name: /Fashion/ }).click();
    await page.getByRole('radio', { name: /Eid and festive wear/ }).click();
    await page.fill('#lp-name', 'Festive Panjabi');
    await page.fill('#lp-slug', SLUG);
    await page.getByLabel('Available').waitFor({ timeout: 10_000 });
    await shot(page, '01-template-gallery', true);
    await page.getByRole('tab', { name: /Health and herbal/ }).click();
    await shot(page, '02-template-gallery-health');
    await page.getByRole('tab', { name: /Fashion/ }).click();
    await page.getByRole('radio', { name: /Eid and festive wear/ }).click();
    await page.getByRole('button', { name: 'Create page' }).click();
    await page.waitForURL(/\/landing-pages\/[a-f0-9]{24}$/, { timeout: 15_000 });
    lp = await call(page, 'GET', `/orgs/${orgId}/landing-pages/${page.url().split('/').pop()}`);
    const types = lp.draft.sections.map((s) => s.type);
    for (const t of ['announcement', 'size_chart', 'packages', 'order_form'])
      check(types.includes(t), `the festive template has no ${t}`);
    check(lp.draft.offer.packages.length === 2, 'the template should bring two packages');
  });

  await step('editor: the template words hold publishing back; the grouped add menu', async () => {
    await page.getByRole('heading', { name: 'Sections' }).waitFor();
    await page
      .locator('aside')
      .getByText(/Announcement bar:/)
      .waitFor();
    await shot(page, '03-editor-template-words', true);
    await page.getByRole('button', { name: 'Add section' }).click();
    const menu = page.getByRole('menu');
    for (const g of [
      'Top of the page',
      'Pictures and video',
      'About the product',
      'Trust',
      'Buying',
    ])
      await menu.getByRole('group', { name: g }).waitFor();
    await shot(page, '04-add-section-menu');
    await menu.getByRole('menuitem', { name: /^Orders today/ }).click();
    await page.getByRole('button', { name: 'Discard' }).click();
  });

  await step('Coupons page: a 10% code for the store and landing pages', async () => {
    await page.goto(`${BASE}${org}/coupons`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Coupons' }).waitFor();
    await page.getByRole('button', { name: 'New coupon' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Code').fill(CODE.toLowerCase());
    await d.getByLabel('Note for your team').fill('Browser check');
    await d.getByLabel('Percent off').fill('10');
    await d.getByLabel(/Most it takes off/).fill('300');
    await shot(page, '05-coupon-new');
    await d.getByRole('button', { name: 'Create coupon' }).click();
    await page.getByText(`Coupon ${CODE} is ready.`).waitFor({ timeout: 10_000 });
    const list = await call(page, 'GET', `/orgs/${orgId}/coupons`);
    coupon = list.items.find((c) => c.code === CODE);
    check(
      coupon && coupon.percent === 10 && coupon.maxDiscountMinor === 30_000,
      'the coupon was not saved as typed',
    );
    check(coupon.store && coupon.landing === 'all', 'a new coupon should work everywhere');
    await page.locator(`[data-coupon="${CODE}"]`).waitFor();
    await shot(page, '06-coupons-list');
  });

  await step('write the page and publish now', async () => {
    await saveDraft({ sections: sections(HEADLINE_A) });
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}`, { waitUntil: 'networkidle' });
    await page.locator('aside').getByText('Everything needed is there.').waitFor();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('radio', { name: /Now/ }).waitFor();
    check(
      (await d.getByRole('radio', { name: /As an A\/B test/ }).isDisabled()) === true,
      'an A/B test needs a live page',
    );
    await shot(page, '07-publish-dialog');
    await d.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByText('Published. Shoppers see it now.').waitFor({ timeout: 15_000 });
    lp = await getPage();
    check(lp.status === 'live', `the page is ${lp.status}`);
  });

  await step('phone: "Use this code", "Choose" a package, order with the coupon', async () => {
    const phone = await phoneContext();
    const p = await phone.newPage();
    watch(p, 'phone');
    await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await p.getByRole('heading', { name: HEADLINE_A }).waitFor();
    for (const t of ['features', 'comparison', 'size_chart', 'who_for', 'timeline', 'packages'])
      check((await p.locator(`[data-section="${t}"]`).count()) === 1, `no ${t} section`);
    // No order yet today: "orders today" stays hidden below its minimum.
    check(
      (await p.locator('[data-section="orders_today"]').count()) === 0,
      'orders today shows before any order',
    );
    check(
      (await p.getByRole('link', { name: 'Open in Google Maps' }).getAttribute('href')) ===
        'https://maps.app.goo.gl/nakshiGhorDemo1',
      'the map link is wrong',
    );
    await shot(p, '08-phone-page', true);
    // The pair (2 pieces) by its card, then the code by its banner.
    await p
      .locator('[data-section="packages"]')
      .getByRole('button', { name: 'Choose' })
      .nth(1)
      .click();
    check(
      await p.locator('#order').getByRole('radio', { name: /Pair/ }).isChecked(),
      'the package card did not choose the pair',
    );
    await p.locator('[data-section="coupon_banner"]').scrollIntoViewIfNeeded();
    await shot(p, '09-phone-coupon-banner');
    await p.getByRole('button', { name: 'Use this code' }).click();
    await p.getByText(`${CODE} applied`).waitFor({ timeout: 10_000 });
    await p.getByRole('button', { name: 'M', exact: true }).click();
    await p.getByLabel('Full name').fill('Rafiq Islam');
    await p.getByLabel('Mobile number').fill(phoneNo(1));
    await p.getByLabel('Full address').fill('House 9, Road 2, Dhanmondi, Dhaka');
    await p
      .locator('#order')
      .getByRole('radio', { name: /Inside Dhaka/ })
      .check();
    await p.getByText(`Coupon ${CODE}`).waitFor();
    await p.locator('#order').screenshot({ path: join(OUT, '10-phone-order-with-coupon.png') });
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === `/api/landing/${SLUG}/order`),
      p.getByRole('button', { name: /Confirm order|Place order/ }).click(),
    ]);
    const body = await placed.json();
    check(
      placed.status() === 201,
      `the order answered ${placed.status()}: ${JSON.stringify(body)}`,
    );
    const list = await call(page, 'GET', `/orgs/${orgId}/orders?q=${body.orderNumber}`);
    const order = await call(page, 'GET', `/orgs/${orgId}/orders/${list.items[0].id}`);
    placedOrders.push(order.id);
    check(order.coupon?.code === CODE, `the order has coupon ${JSON.stringify(order.coupon)}`);
    // 10% of the pair, at most ৳300.
    const tenPercent = Math.min(Math.round(order.subtotalMinor * 0.1), 30_000);
    check(
      Math.abs(order.coupon.discountMinor - tenPercent) <= 100,
      `the coupon took ${order.coupon.discountMinor} off ${order.subtotalMinor}`,
    );
    await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await p.getByText('1 people ordered from this page today').waitFor();
    await phone.close();
  });

  await step('the order shows the coupon; the Coupons page counts the use', async () => {
    await page.goto(`${BASE}${org}/orders/${placedOrders[0]}`, { waitUntil: 'networkidle' });
    await page.getByText(`(${CODE})`).waitFor();
    await shot(page, '11-order-with-coupon', true);
    await page.goto(`${BASE}${org}/coupons`, { waitUntil: 'networkidle' });
    const list = await call(page, 'GET', `/orgs/${orgId}/coupons`);
    check(list.items.find((c) => c.code === CODE)?.used === 1, 'the use was not counted');
    await shot(page, '12-coupons-used');
  });

  await step('store checkout: the same code at the shop', async () => {
    const phone = await phoneContext();
    const p = await phone.newPage();
    watch(p, 'checkout');
    await p.goto(`${store.url}/products/handloom-gamchha`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Add to cart' }).click();
    await p.goto(`${store.url}/checkout`, { waitUntil: 'networkidle' });
    await p.getByLabel('Full name').fill('Sadia Akter');
    await p.getByLabel('Mobile number').fill(phoneNo(2));
    await p.getByRole('button', { name: 'Have a coupon code?' }).click();
    await p.getByLabel('Coupon code').fill('nope-123');
    await p.getByRole('button', { name: 'Apply' }).click();
    await p.getByText('This code is not valid.').waitFor({ timeout: 10_000 });
    await p.getByLabel('Coupon code').fill(CODE);
    await p.getByRole('button', { name: 'Apply' }).click();
    await p.getByText(`${CODE} applied`).waitFor({ timeout: 10_000 });
    await p.getByText(`Coupon ${CODE}`).waitFor();
    await shot(p, '13-store-checkout-coupon', true);
    await phone.close();
  });

  let scheduledFor;
  await step('schedule a version for a minute later, change the time once', async () => {
    const draft = (await getPage()).draft;
    draft.sections[1].heading = HEADLINE_SCHEDULED;
    await saveDraft({ sections: draft.sections });
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Publish changes' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('radio', { name: /At a time/ }).click();
    const at = new Date(Date.now() + 3 * 60_000);
    const local = (x) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
    };
    await d.getByLabel('Goes live at').fill(local(at));
    await shot(page, '14-publish-at-a-time');
    await d.getByRole('button', { name: 'Schedule' }).click();
    await page.getByText(/^Scheduled\. It goes live on/).waitFor({ timeout: 15_000 });
    await page
      .getByText(/^Goes live on/)
      .first()
      .waitFor();
    // Moved to the first whole minute at least 70 s away (the field has no seconds): the
    // worker publishes it on its next round after that.
    await page.getByRole('button', { name: 'Change time' }).click();
    scheduledFor = new Date(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000);
    await page.getByRole('dialog').getByLabel('Goes live at').fill(local(scheduledFor));
    await page.getByRole('dialog').getByRole('button', { name: 'Save time' }).click();
    await page.getByText(/^Moved\./).waitFor({ timeout: 10_000 });
    lp = await getPage();
    check(lp.scheduled && lp.status === 'live', 'the version is not scheduled');
    await shot(page, '15-scheduled-card');
  });

  await step('the worker makes the scheduled version live by itself', async () => {
    lp = await until(
      'the scheduled version to go live',
      async () => {
        const p = await getPage();
        return !p.scheduled && p.published.revision === p.revision ? p : null;
      },
      200_000,
      5000,
    );
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const v = await visitor.newPage();
    watch(v, 'visitor');
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: HEADLINE_SCHEDULED }).waitFor();
    await visitor.close();
    await page.reload({ waitUntil: 'networkidle' });
    await shot(page, '16-scheduled-went-live');
  });

  await step('A/B test: version B to half the visitors', async () => {
    const draft = (await getPage()).draft;
    draft.sections[1].heading = HEADLINE_B;
    await saveDraft({ sections: draft.sections });
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Publish changes' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('radio', { name: /As an A\/B test/ }).click();
    await d.getByLabel('Visitors each version needs').fill('50');
    await shot(page, '17-ab-settings');
    await d.getByRole('button', { name: 'Start A/B test' }).click();
    await page.getByText(/A\/B test started/).waitFor({ timeout: 15_000 });
    await page.getByText('A/B test running').waitFor();
    lp = await getPage();
    check(lp.abTest?.splitB === 50, 'the test did not start');
  });

  await step('two browsers see the two versions; a buyer of B is counted', async () => {
    const seen = {};
    for (let i = 0; i < 16 && !(seen.a && seen.b); i += 1) {
      const c = await phoneContext();
      const p = await c.newPage();
      watch(p, `ab-${i}`);
      await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
      const h = await p.locator('h1').first().textContent();
      const v = h?.includes(HEADLINE_B) ? 'b' : h?.includes(HEADLINE_SCHEDULED) ? 'a' : null;
      check(v, `a visitor saw "${h}"`);
      // The same browser keeps its version.
      await p.reload({ waitUntil: 'networkidle' });
      check(
        (await p.locator('h1').first().textContent()) === h,
        'a visitor saw the other version on reload',
      );
      if (!seen[v]) {
        seen[v] = { c, p };
        await shot(p, v === 'a' ? '18-ab-visitor-a' : '19-ab-visitor-b');
      } else await c.close();
    }
    check(seen.a && seen.b, 'both versions should be seen within 16 visitors');
    const p = seen.b.p;
    await p.locator('#order').scrollIntoViewIfNeeded();
    await p.getByRole('button', { name: 'L', exact: true }).click();
    await p.getByLabel('Full name').fill('Mitu Rahman');
    await p.getByLabel('Mobile number').fill(phoneNo(3));
    await p.getByLabel('Full address').fill('Flat 4B, Road 12, Uttara, Dhaka');
    await p
      .locator('#order')
      .getByRole('radio', { name: /Inside Dhaka/ })
      .check();
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === `/api/landing/${SLUG}/order`),
      p.getByRole('button', { name: /Confirm order|Place order/ }).click(),
    ]);
    const body = await placed.json();
    check(placed.status() === 201, `the B order answered ${placed.status()}`);
    const list = await call(page, 'GET', `/orgs/${orgId}/orders?q=${body.orderNumber}`);
    const order = await call(page, 'GET', `/orgs/${orgId}/orders/${list.items[0].id}`);
    placedOrders.push(order.id);
    check(order.landingPage?.variant === 'b', `the order says ${order.landingPage?.variant}`);
    await seen.a.c.close();
    await seen.b.c.close();
    const tests = await call(page, 'GET', `/orgs/${orgId}/landing-pages/${lp.id}/ab-tests`);
    const t = tests.items[0];
    check(t.counts.a.visitors >= 1 && t.counts.b.visitors >= 1, 'the visitors were not counted');
    check(t.counts.b.buyers === 1 && t.counts.b.orders === 1, 'the B buyer was not counted');
    await page.goto(`${BASE}${org}/orders/${order.id}`, { waitUntil: 'networkidle' });
    await page.getByText('the new version (B)').waitFor();
  });

  await step('A/B results, then "Make B live"', async () => {
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}/ab-tests`, { waitUntil: 'networkidle' });
    await page.getByText('Running test').waitFor();
    await page.getByText('Too early to tell').waitFor();
    await shot(page, '20-ab-results', true);
    await page.getByRole('button', { name: 'Make B live' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Make B live' }).click();
    await page.getByText('Version B is live for everyone now.').waitFor({ timeout: 15_000 });
    await page.getByText('Earlier tests').waitFor();
    await shot(page, '21-ab-ended', true);
    lp = await getPage();
    check(!lp.abTest && lp.published.revision === lp.revision, 'B is not the live version');
  });

  await step('offer end: the worker pauses the page at the time set', async () => {
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}/settings`, { waitUntil: 'networkidle' });
    // The first whole minute at least 70 s away: the field has no seconds.
    const at = new Date(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000);
    const pad = (n) => String(n).padStart(2, '0');
    await page
      .getByLabel(/Offer ends at/)
      .fill(
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
      );
    await page.getByRole('button', { name: 'Save end' }).click();
    await page.getByText(/^The page pauses itself on/).waitFor({ timeout: 10_000 });
    await page.getByText(/^The offer ends on/).waitFor();
    await shot(page, '22-offer-end', true);
    await until(
      'the worker to pause the page',
      async () => (await getPage()).status === 'paused',
      200_000,
      5000,
    );
    const visitor = await phoneContext();
    const v = await visitor.newPage();
    watch(v, 'visitor');
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: 'This offer is paused' }).waitFor();
    await shot(v, '23-offer-ended-phone');
    await call(page, 'POST', `/orgs/${orgId}/landing-pages/${lp.id}/resume`);
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: HEADLINE_B }).waitFor();
    await visitor.close();
  });

  await step('save as template; it shows under "My templates"', async () => {
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Save as template' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Template name').fill('Festive layout');
    await d.getByLabel(/Note/).fill('Our Eid page with the size chart and packages');
    await d.getByRole('button', { name: 'Save template' }).click();
    await page.getByText(/Saved\. Choose it under/).waitFor({ timeout: 10_000 });
    await page.goto(`${BASE}${org}/landing-pages/new`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /My templates/ }).click();
    await page.getByRole('radio', { name: /Festive layout/ }).waitFor();
    await shot(page, '24-my-templates');
  });

  await step('a Bangla library template in preview', async () => {
    const products = await call(page, 'GET', `/orgs/${orgId}/products?q=Gamchha&status=active`);
    const gamchha = products.items[0];
    check(gamchha, 'the demo gamchha is missing');
    const made = await call(page, 'POST', `/orgs/${orgId}/landing-pages`, {
      storeId: store.id,
      name: 'Bangla template check',
      slug: BN_SLUG,
      productId: gamchha.id,
      template: 'herbal_remedy',
      language: 'bn',
    });
    // Business-only sections start hidden; show them all for the look.
    await call(page, 'PUT', `/orgs/${orgId}/landing-pages/${made.id}/draft`, {
      content: {
        ...made.draft,
        sections: made.draft.sections.map((s) => ({ ...s, enabled: true })),
      },
      revision: made.revision,
    });
    const link = await call(page, 'POST', `/orgs/${orgId}/landing-pages/${made.id}/preview`, {
      kind: 'draft',
    });
    const phone = await phoneContext();
    const p = await phone.newPage();
    watch(p, 'bangla');
    await p.goto(link.url, { waitUntil: 'networkidle' });
    await p
      .getByText('প্রিভিউ', { exact: false })
      .first()
      .waitFor()
      .catch(() => {});
    await p.locator('[data-section="who_for"]').waitFor();
    await shot(p, '25-bangla-template-preview', true);
    await phone.close();
  });
} catch (err) {
  failed = true;
  console.error(`\nStopped: ${String(err).split('\n')[0]}`);
  await shot(page, 'zz-failure', true).catch(() => {});
} finally {
  for (const id of placedOrders)
    await call(page, 'POST', `/orgs/${orgId}/orders/${id}/cancel`, {
      reason: 'Browser check',
    }).catch((e) => problems.push(`could not cancel the test order: ${String(e).slice(0, 120)}`));
  if (autoApproveBefore === false)
    await call(admin, 'PATCH', '/platform/settings', {
      stores: { autoApproveLandingPages: false },
    }).catch((e) => problems.push(`could not restore automatic approval: ${String(e)}`));
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
