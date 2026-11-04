/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through a landing page's whole life in a real browser, against a running web app,
 * API, worker and storefront app (sellora-storefront). The merchant account should own the
 * demo business Nakshi Ghor (`npm run dev:seed` in sellora-api, shop@demo.sellora.test) with
 * the open store stores-flow leaves behind. Its product pictures are generated patterns.
 *
 * What it checks: the empty landing pages list; making a page (product, template, a
 * reserved address refused); the editor (the template's sample words holding publishing
 * back until replaced or hidden, headline, two packages, an add-on, a video and a countdown
 * added, a section hidden, saved); the signed preview on the shop address;
 * publishing for review while shoppers still get "not found"; the super-admin's queue,
 * review page and approval; a shopper on a phone arriving from a Facebook ad (UTM tags),
 * using the sticky order button, choosing a package, a size and the add-on, ordering, and
 * the thank-you page; the order in the dashboard with the page and the ad it came from; the
 * page's numbers; the same phone ordering again within 15 minutes getting the first order
 * back; pausing; the platform taking the page down and putting it back; and a short page in
 * Bangla. Fails on console errors, unexpected API errors or a missing result. Deletes the
 * business's earlier landing pages first and cancels the orders it placed at the end (their
 * stock goes back).
 *
 * YouTube is not reachable from the build machine, so the video player is answered by a
 * stand-in page inside the browser; the check is that the page embeds the right player.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… \
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
 *   node scripts/landing-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SMOKE_OUT (smoke-output/landing),
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
const OUT = env.SMOKE_OUT ?? 'smoke-output/landing';
const HANDLE = env.STORE_HANDLE ?? 'nakshi-ghor';
const SLUG = 'eid-panjabi-offer';
const BN_SLUG = 'gamchha-offer';
const HEADLINE = 'Hand-embroidered Eid Panjabi';
const BENEFITS = [
  'Every flower is stitched by hand on the placket and cuffs.',
  'A soft cotton blend that stays cool through Eid prayers and visits.',
  'Two pieces cost less than buying them one at a time.',
];
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
    const url = new URL(r.url());
    const ours = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/');
    const isPage = r.request().resourceType() === 'document';
    if (!(s >= 500 || (s >= 400 && s !== 401 && (ours || isPage)))) return;
    const i = expected.findIndex((e) => e.status === s && e.path.test(url.pathname));
    if (i >= 0) expected.splice(i, 1);
    else problems.push(`${label} ${s} ${r.request().method()} ${url.pathname}`);
  });
}

/** YouTube is blocked here: the player frame gets a stand-in page instead. */
async function standInPlayer(ctx) {
  await ctx.route('https://www.youtube-nocookie.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#111;color:#ddd;font:15px system-ui">Video player stand-in (YouTube is not reachable from the build machine)</body>',
    }),
  );
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
      // The platform admin has its own session and CSRF cookie.
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
      `${method} ${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  return r.body;
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

/** A section's row in the editor, by its label. */
const sectionEdit = (page, label) =>
  page.getByRole('button', { name: `Edit ${label}`, exact: true });

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
let orderNumber;
const placedOrders = [];
const shopperPhone = `017${String(Date.now()).slice(-8)}`;

async function phoneContext() {
  const c = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await standInPlayer(c);
  return c;
}

try {
  await step('sign in (merchant and super-admin), clear earlier landing pages', async () => {
    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    // A code is accepted once: start a fresh 30-second window so a rerun never repeats one.
    await admin.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    await admin.fill('#code', totp(need('SMOKE_ADMIN_TOTP_SECRET')));
    await admin.click('button[type=submit]');
    await admin.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 });
    const settings = await call(admin, 'GET', '/platform/settings');
    if (settings.stores.autoApproveLandingPages)
      await call(admin, 'PATCH', '/platform/settings', {
        stores: { autoApproveLandingPages: false },
      });

    await page.goto(`${BASE}/login`);
    await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
    orgId = org.split('/').pop();
    const stores = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = stores.items.find((s) => s.handle === HANDLE);
    check(store && store.status === 'live', `run stores-flow first: ${HANDLE} must be open`);
    const { items } = await call(page, 'GET', `/orgs/${orgId}/landing-pages`);
    for (const p of items) {
      // A page the platform took down stays for the record until it is put back.
      if (p.takedown) await call(admin, 'POST', `/platform/landing-pages/${p.id}/reinstate`);
      await call(page, 'DELETE', `/orgs/${orgId}/landing-pages/${p.id}`);
    }
  });

  await step('landing pages, empty', async () => {
    await page.goto(`${BASE}${org}/landing-pages`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Sell one product from one page' }).waitFor();
    await shot(page, '01-empty');
  });

  await step('new page: product, template, a reserved address refused', async () => {
    await page.getByRole('link', { name: 'New landing page' }).click();
    await page.waitForURL(/\/landing-pages\/new$/);
    await page.fill('#lp-product', 'Eid Panjabi');
    await page.getByRole('button', { name: /Embroidered Eid Panjabi/ }).click();
    check(
      (await page.getByRole('radio', { name: /Full offer page/ }).getAttribute('aria-checked')) ===
        'true',
      'Full offer page should be the starting template',
    );
    await page.fill('#lp-name', 'Eid Panjabi offer');
    await page.fill('#lp-slug', 'checkout');
    await page.getByLabel('Not available').waitFor({ timeout: 10_000 });
    await shot(page, '02-new-reserved', true);
    await page.fill('#lp-slug', SLUG);
    await page.getByLabel('Available').waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Create page' }).click();
    await page.waitForURL(/\/landing-pages\/[a-f0-9]{24}$/, { timeout: 15_000 });
    lp = await call(page, 'GET', `/orgs/${orgId}/landing-pages/${page.url().split('/').pop()}`);
    check(lp.slug === SLUG && lp.status === 'draft', `the page is ${lp.slug} / ${lp.status}`);
    check(
      lp.draft.sections.at(-2)?.type === 'order_form' ||
        lp.draft.sections.some((s) => s.type === 'order_form'),
      'the template has no order form',
    );
    await page.getByRole('heading', { name: 'Sections' }).waitFor();
    await shot(page, '03-editor-new');
  });

  await step(
    'editor: headline, packages, add-on, video, countdown, a section hidden; save',
    async () => {
      await sectionEdit(page, 'Top offer').click();
      await page.locator('[id^="ls-"][id$="-heading"]').fill(HEADLINE);
      await page.locator('[id^="ls-"][id$="-badge"]').fill('Eid offer');
      await sectionEdit(page, 'Top offer').click();

      await page.getByRole('button', { name: 'Add package' }).click();
      await page.getByRole('button', { name: 'Add package' }).click();
      const prices = page.locator('[id^="pk-"][id$="-price"]');
      check((await prices.count()) === 2, 'two packages should be listed');
      await prices.nth(1).fill('4990');
      await page.locator('[id^="pk-"][id$="-badge"]').nth(1).fill('Best value');

      await page.fill('#picker', 'Gamchha');
      await page.getByRole('button', { name: /^Add/ }).filter({ hasText: '৳' }).first().click();
      await page.fill('#addon-price', '199');

      await page.getByRole('button', { name: 'Add section' }).click();
      await page.getByRole('menuitem', { name: /^Video/ }).click();
      await page.locator('[id^="ls-"][id$="-title"]').fill('See the embroidery');
      await page
        .locator('[id^="ls-"][id$="-url"]')
        .fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await page.getByRole('button', { name: 'Add section' }).click();
      await page.getByRole('menuitem', { name: /^Countdown/ }).click();
      await page.getByRole('switch', { name: 'Show Call and WhatsApp section' }).click();

      // The template's "write here" words and sample reviews hold publishing back until the
      // business writes its own or hides the section.
      const ready = page.locator('aside');
      await ready.getByText('Benefits: Replace the template’s sample words').waitFor();
      await ready.getByText('Reviews: Replace the sample reviews with real ones').waitFor();
      await shot(page, '04-editor-sample-words', true);
      await sectionEdit(page, 'Benefits').click();
      const explain = page.locator('[id^="ls-"][id*="-b-"][id$="-x"]');
      check((await explain.count()) === 3, 'the template should have three benefits');
      for (const [i, text] of BENEFITS.entries()) await explain.nth(i).fill(text);
      await sectionEdit(page, 'Benefits').click();
      await page.getByRole('switch', { name: 'Show Reviews section' }).click();
      await ready.getByText('Everything needed is there.').waitFor();
      await shot(page, '04-editor-editing', true);

      await page.getByRole('button', { name: 'Save draft' }).click();
      await page.getByText('All changes saved.').waitFor({ timeout: 15_000 });
      lp = await call(page, 'GET', `/orgs/${orgId}/landing-pages/${lp.id}`);
      const d = lp.draft;
      check(d.sections[0].heading === HEADLINE, 'the headline was not saved');
      check(d.offer.packages.length === 2, 'the packages were not saved');
      check(d.offer.packages[1].priceMinor === 499_000, 'the package price was not saved');
      check(d.offer.addOn?.priceMinor === 19_900, 'the add-on was not saved');
      check(
        d.sections.some((s) => s.type === 'video') &&
          d.sections.some((s) => s.type === 'countdown'),
        'the added sections were not saved',
      );
      check(
        d.sections.find((s) => s.type === 'contact')?.enabled === false &&
          d.sections.find((s) => s.type === 'reviews')?.enabled === false,
        'the contact and review sections should be hidden',
      );
      check(
        d.sections.find((s) => s.type === 'benefits')?.items[2]?.text === BENEFITS[2],
        'the benefits were not saved',
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, '05-editor-saved');
    },
  );

  await step('preview opens the saved draft on the shop address', async () => {
    await standInPlayer(ctx);
    const [preview] = await Promise.all([
      ctx.waitForEvent('page'),
      page.getByRole('button', { name: 'Preview', exact: true }).first().click(),
    ]);
    watch(preview, 'preview');
    await preview.waitForURL((u) => u.hostname.startsWith(`${HANDLE}.`), { timeout: 15_000 });
    await preview.waitForLoadState('networkidle');
    await preview.getByText('Preview: shoppers do not see this version yet').first().waitFor();
    await preview.getByText('Orders open once the page is published.').waitFor();
    await preview.getByRole('heading', { name: HEADLINE }).waitFor();
    const src = await preview.locator('iframe').first().getAttribute('src');
    check(
      src === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
      `the video player is ${src}`,
    );
    const robots = await preview.locator('meta[name="robots"]').getAttribute('content');
    check(/noindex/.test(robots ?? ''), 'a preview must not be indexed');
    await shot(preview, '06-preview-desktop', true);
    await preview.close();
  });

  await step('publish sends it for review; shoppers still find nothing', async () => {
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByText('Sent for review.').waitFor({ timeout: 10_000 });
    await page.getByText('In review').first().waitFor();
    await shot(page, '07-in-review');
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const v = await visitor.newPage();
    watch(v, 'visitor');
    expectError(404, new RegExp(`^/${SLUG}$`));
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByText('Page not found').waitFor();
    await visitor.close();
  });

  await step('super-admin reviews and approves', async () => {
    await admin.goto(`${BASE}/admin/landing-pages`, { waitUntil: 'networkidle' });
    await admin.getByRole('link', { name: 'Eid Panjabi offer' }).first().waitFor();
    await shot(admin, '08-admin-queue');
    await admin.getByRole('link', { name: 'Eid Panjabi offer' }).first().click();
    await admin.getByRole('heading', { name: 'Decision' }).waitFor();
    await admin.getByText('What it sells').waitFor();
    await admin
      .getByText(/Best value/)
      .first()
      .waitFor();
    await shot(admin, '09-admin-review', true);
    await admin.getByRole('button', { name: 'Approve and publish' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Approve and publish' }).click();
    await admin.getByText('Published. The owner has been told.').waitFor({ timeout: 10_000 });
    await admin.getByText('Live', { exact: true }).first().waitFor();
    await shot(admin, '10-admin-approved');
  });

  await step('shopper on a phone: from a Facebook ad to the thank-you page', async () => {
    const phone = await phoneContext();
    const p = await phone.newPage();
    watch(p, 'phone');
    await p.goto(
      `${store.url}/${SLUG}?utm_source=facebook&utm_medium=paid&utm_campaign=eid-2026&fbclid=IwAR0demo`,
      { waitUntil: 'networkidle' },
    );
    await p.getByRole('heading', { name: HEADLINE }).waitFor();
    await shot(p, '11-phone-page', true);
    await shot(p, '12-phone-first-screen');
    await p.getByRole('link', { name: 'Order now' }).last().click();
    await p.locator('#order').waitFor();
    await p
      .locator('#order')
      .getByRole('radio', { name: /2 pieces/ })
      .check();
    await p.getByRole('button', { name: 'M', exact: true }).click();
    await p.locator('#order').getByRole('checkbox').check();
    await p.getByLabel('Full name').fill('Tanvir Ahmed');
    await p.getByLabel('Mobile number').fill(shopperPhone);
    await p.getByLabel('Full address').fill('House 7, Road 3, Mirpur 10, Dhaka');
    await p
      .locator('#order')
      .getByRole('radio', { name: /Inside Dhaka/ })
      .check();
    // 4,990 for two, the gamchha at 199, 60 to Dhaka.
    await p.getByRole('button', { name: /Confirm order · ৳5,249/ }).waitFor();
    await p.locator('#order').screenshot({ path: join(OUT, '13-phone-order-form.png') });
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === `/api/landing/${SLUG}/order`),
      p.getByRole('button', { name: /Confirm order/ }).click(),
    ]);
    const body = await placed.json();
    check(
      placed.status() === 201,
      `the order answered ${placed.status()}: ${JSON.stringify(body)}`,
    );
    check(body.totalMinor === 524_900, `the order total is ${body.totalMinor}`);
    orderNumber = body.orderNumber;
    await p.waitForURL(`**/${SLUG}/thanks?**`, { timeout: 15_000 });
    await p.getByRole('heading', { name: 'Thank you for your order!' }).waitFor();
    await p.getByText(orderNumber).first().waitFor();
    await shot(p, '14-phone-thanks', true);
    await phone.close();
  });

  await step('the order and the visit reach the dashboard', async () => {
    const list = await call(page, 'GET', `/orgs/${orgId}/orders?landingPageId=${lp.id}`);
    const order = list.items.find((o) => o.number === orderNumber);
    check(order, 'the order is not listed under the landing page');
    placedOrders.push(order.id);
    const full = await call(page, 'GET', `/orgs/${orgId}/orders/${order.id}`);
    check(full.source === 'landing_page', `the order source is ${full.source}`);
    check(full.landingPage?.slug === SLUG, 'the order does not name the page');
    check(
      full.attribution?.utmSource === 'facebook' &&
        full.attribution?.utmCampaign === 'eid-2026' &&
        full.attribution?.fbclid === 'IwAR0demo',
      `the ad tags are ${JSON.stringify(full.attribution)}`,
    );
    check(full.items.length === 2 && full.items[0].quantity === 2, 'the items are wrong');
    check(full.discountMinor === 39_100, `the discount is ${full.discountMinor}`);
    await page.goto(`${BASE}${org}/orders/${order.id}`, { waitUntil: 'networkidle' });
    await page.getByText('Where it came from').waitFor();
    await page.getByText('eid-2026').waitFor();
    await shot(page, '15-order-source', true);
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}/stats`, { waitUntil: 'networkidle' });
    const stats = await call(page, 'GET', `/orgs/${orgId}/landing-pages/${lp.id}/stats`);
    check(stats.total.visitors >= 1, 'the visit was not counted');
    check(
      stats.total.orders === 1 && stats.total.revenueMinor === 524_900,
      'the order is not counted',
    );
    await shot(page, '16-numbers', true);
    await page.goto(`${BASE}${org}/orders?landingPageId=${lp.id}`, { waitUntil: 'networkidle' });
    await page.getByText(orderNumber).first().waitFor();
    await shot(page, '17-orders-from-page');
  });

  await step('the same phone ordering again gets its first order back', async () => {
    const phone = await phoneContext();
    const p = await phone.newPage();
    watch(p, 'phone-again');
    await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await p.locator('#order').scrollIntoViewIfNeeded();
    await p
      .locator('#order')
      .getByRole('radio', { name: /2 pieces/ })
      .check();
    await p.getByRole('button', { name: 'M', exact: true }).click();
    await p.getByLabel('Full name').fill('Tanvir Ahmed');
    await p.getByLabel('Mobile number').fill(shopperPhone);
    await p.getByLabel('Full address').fill('House 7, Road 3, Mirpur 10, Dhaka');
    await p
      .locator('#order')
      .getByRole('radio', { name: /Inside Dhaka/ })
      .check();
    const [placed] = await Promise.all([
      p.waitForResponse((r) => new URL(r.url()).pathname === `/api/landing/${SLUG}/order`),
      p.getByRole('button', { name: /Confirm order/ }).click(),
    ]);
    const body = await placed.json();
    check(body.duplicate === true && body.orderNumber === orderNumber, 'a second order was made');
    await p.getByText('You ordered this a moment ago').waitFor({ timeout: 15_000 });
    await shot(p, '18-phone-ordered-again');
    // Confirming takes the stock: 11 panjabis less 2 is within the page's "stock left" limit.
    await call(page, 'POST', `/orgs/${orgId}/orders/${placedOrders[0]}/status`, {
      status: 'confirmed',
    });
    await p.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    const stock = p.getByText('Only 9 left in stock');
    await stock.waitFor();
    await stock.scrollIntoViewIfNeeded();
    await shot(p, '19-phone-stock-left');
    await phone.close();
  });

  await step('pausing shows shoppers a note; resume', async () => {
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Pause page' }).click();
    await page.getByText('Paused.').first().waitFor({ timeout: 10_000 });
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const v = await visitor.newPage();
    watch(v, 'visitor');
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: 'This offer is paused' }).waitFor();
    await shot(v, '20-paused');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Resume page' }).click();
    await page.getByText('The page is live again.').waitFor({ timeout: 10_000 });
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: HEADLINE }).waitFor();
    await visitor.close();
  });

  await step('the platform takes the page down and puts it back', async () => {
    await admin.goto(`${BASE}/admin/landing-pages/${lp.id}`, { waitUntil: 'networkidle' });
    await admin.getByRole('button', { name: 'Take page down' }).click();
    await admin
      .getByRole('dialog')
      .getByLabel('Why (the owner sees this)')
      .fill('The "cures back pain" claim needs proof.');
    await admin.getByRole('dialog').getByRole('button', { name: 'Take page down' }).click();
    await admin.getByText('Page taken down.').waitFor({ timeout: 10_000 });
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const v = await visitor.newPage();
    watch(v, 'visitor');
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: 'This offer is not available right now' }).waitFor();
    await shot(v, '21-taken-down');
    await page.goto(`${BASE}${org}/landing-pages/${lp.id}`, { waitUntil: 'networkidle' });
    await page.getByText('Sellora took this page down').first().waitFor();
    await shot(page, '22-merchant-taken-down');
    await admin.getByRole('button', { name: 'Put page back' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Put page back' }).click();
    await admin.getByText('Page put back.').waitFor({ timeout: 10_000 });
    await v.goto(`${store.url}/${SLUG}`, { waitUntil: 'networkidle' });
    await v.getByRole('heading', { name: HEADLINE }).waitFor();
    await visitor.close();
  });

  await step('a short page in Bangla', async () => {
    const products = await call(page, 'GET', `/orgs/${orgId}/products?q=Gamchha&status=active`);
    const gamchha = products.items.find((x) => x.name === 'Handloom Gamchha');
    check(gamchha, 'the demo gamchha is missing');
    const made = await call(page, 'POST', `/orgs/${orgId}/landing-pages`, {
      storeId: store.id,
      name: 'Gamchha offer',
      slug: BN_SLUG,
      productId: gamchha.id,
      template: 'quick_order',
      language: 'bn',
    });
    const sent = await call(page, 'POST', `/orgs/${orgId}/landing-pages/${made.id}/submit`);
    await call(admin, 'POST', `/platform/landing-pages/${made.id}/approve`, {
      revision: sent.submission.revision,
    });
    const phone = await phoneContext();
    const p = await phone.newPage();
    watch(p, 'bangla');
    await p.goto(`${store.url}/${BN_SLUG}`, { waitUntil: 'networkidle' });
    await p
      .getByRole('button', { name: /অর্ডার নিশ্চিত করুন|অর্ডার/ })
      .first()
      .waitFor();
    await shot(p, '23-bangla-page', true);
    await phone.close();
  });

  await step('sitemap lists the live pages', async () => {
    // Through the browser: only Chromium resolves the shop's *.localhost address.
    const tab = await ctx.newPage();
    const res = await tab.goto(`${store.url}/sitemap.xml`);
    const xml = await res.text();
    await tab.close();
    check(xml.includes(`/${SLUG}</loc>`) && xml.includes(`/${BN_SLUG}</loc>`), 'pages missing');
  });
} catch (err) {
  failed = true;
  console.error(`\nStopped: ${String(err).split('\n')[0]}`);
  await shot(page, 'zz-failure', true).catch(() => {});
} finally {
  // Cancelled orders put their stock back, so the next run starts from the same numbers.
  for (const id of placedOrders)
    await call(page, 'POST', `/orgs/${orgId}/orders/${id}/cancel`, {
      reason: 'Browser check',
    }).catch((e) => problems.push(`could not cancel the test order: ${String(e).slice(0, 120)}`));
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
