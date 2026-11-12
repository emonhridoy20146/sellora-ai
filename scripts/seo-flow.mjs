/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through the AI SEO studio and content studio (ADR 0032) in a real browser, against
 * a running web app, API, worker and storefront, with the stand-ins for Claude (scripted, not
 * AI), keyword volumes (made-up numbers, not DataForSEO) and Google (not Google). The merchant
 * should own the demo business Nakshi Ghor with the open store stores-flow leaves behind.
 *
 * Module 5 exit test: research a Bangla keyword, add a product with AI-written SEO fields,
 * publish it; the sitemap, structured data and canonical tags validate; Search Console data
 * appears for a test property.
 *
 * What it checks: the super-admin prices keyword lookups; keyword research for জামদানি শাড়ি
 * with monthly searches (and the lookup charged once, then served from the cache); a keyword
 * list with gaps; a new product written with AI (focus keyword, title, meta, address, alt text,
 * questions) and its live score; the product page on the store: title, canonical, Product,
 * Offer, BreadcrumbList and FAQPage structured data checked against Google's required fields,
 * the FAQ on the page, the sitemap and robots.txt; changing the address redirects the old one;
 * the keyword list no longer shows the keyword as a gap; Search Console connected through the
 * stand-in's consent page, the meta tag put on the store and checked by the stand-in, the
 * sitemap sent and the numbers shown with opportunities; the SEO overview and the bulk
 * optimiser writing and saving suggestions; the content studio writing a Facebook ad; the
 * store's search title written with AI. Fails on console errors, unexpected API errors or a
 * missing result. Removes what an earlier run left first.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… \
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
 *   node scripts/seo-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), SMOKE_OUT (smoke-output/seo),
 * STORE_HANDLE (nakshi-ghor), GOOGLE_STAND_IN_URL (http://localhost:4070),
 * KEYWORD_STAND_IN_URL (http://127.0.0.1:4130).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/seo';
const HANDLE = env.STORE_HANDLE ?? 'nakshi-ghor';
const GOOGLE = (env.GOOGLE_STAND_IN_URL ?? 'http://localhost:4070').replace(/\/+$/, '');
const KEYWORDS = (env.KEYWORD_STAND_IN_URL ?? 'http://127.0.0.1:4130').replace(/\/+$/, '');
const SEED = 'জামদানি শাড়ি';
const NAME = 'Red Jamdani Saree';
const LIST = 'Jamdani (browser check)';
const MOVED = 'dhakai-jamdani-shari';
const DESCRIPTION = [
  'A red Dhakai jamdani saree woven by hand on a pit loom in Rupganj, Narayanganj.',
  'The motifs are woven into the cloth, not printed, so they stay sharp after many washes.',
  'Soft half-silk that drapes well for weddings, Eid and Pohela Boishakh.',
  'Length 5.5 metres with a 0.8 metre blouse piece.',
  'Dry clean the first time; after that, a gentle hand wash in cold water.',
].join(' ');
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
    // A 401 is the app's signal to refresh its short-lived token and retry.
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
  // A full-page picture taken while scrolled draws the fixed sidebar in the middle.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
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

/**
 * Google's required properties for each rich result type
 * (developers.google.com/search/docs/appearance/structured-data). Returns what is missing.
 */
function ldProblems(ld) {
  const out = [];
  const isUrl = (v) => typeof v === 'string' && /^https?:\/\/[^ ]+$/.test(v);
  if (ld['@context'] !== 'https://schema.org') out.push('@context');
  if (ld['@type'] === 'Product') {
    if (!ld.name) out.push('name');
    if (!Array.isArray(ld.image) || !ld.image.length || !ld.image.every(isUrl)) out.push('image');
    if (!Array.isArray(ld.offers) || !ld.offers.length) out.push('offers');
    for (const o of ld.offers ?? []) {
      if (o['@type'] !== 'Offer') out.push('offer @type');
      if (!/^\d+(\.\d+)?$/.test(o.price ?? '')) out.push('price');
      if (!/^[A-Z]{3}$/.test(o.priceCurrency ?? '')) out.push('priceCurrency');
      if (!/^https:\/\/schema\.org\/(InStock|OutOfStock)$/.test(o.availability ?? ''))
        out.push('availability');
      if (!isUrl(o.url)) out.push('offer url');
    }
  } else if (ld['@type'] === 'BreadcrumbList') {
    (ld.itemListElement ?? []).forEach((it, i) => {
      if (it.position !== i + 1 || !it.name || !isUrl(it.item)) out.push(`breadcrumb ${i}`);
    });
    if ((ld.itemListElement ?? []).length < 2) out.push('breadcrumb length');
  } else if (ld['@type'] === 'FAQPage') {
    for (const q of ld.mainEntity ?? [])
      if (q['@type'] !== 'Question' || !q.name || q.acceptedAnswer?.['@type'] !== 'Answer')
        out.push('question');
    if (!(ld.mainEntity ?? []).length) out.push('no questions');
  } else if (ld['@type'] === 'Organization' || ld['@type'] === 'WebSite') {
    if (!isUrl(ld.url) || !ld.name) out.push(`${ld['@type']} url or name`);
  } else out.push(`unknown type ${ld['@type']}`);
  return out;
}

/** The JSON-LD blocks of the page now open. */
async function ldOf(p) {
  const raw = await p.locator('script[type="application/ld+json"]').allTextContents();
  return raw.flatMap((t) => {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [v];
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
watch(page, 'merchant');
const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await actx.newPage();
watch(admin, 'admin');
const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const shop = await sctx.newPage();
watch(shop, 'shopper');
let failed = false;
let org;
let orgId;
let store;
let storeUrl;
let product;
let lookupCredits = 0;

try {
  await step('sign in, the plan with SEO, credit in the wallet, earlier runs removed', async () => {
    await admin.goto(`${BASE}/admin/login`);
    await admin.fill('#email', need('SMOKE_ADMIN_EMAIL'));
    await admin.fill('#password', need('SMOKE_ADMIN_PASSWORD'));
    await admin.click('button[type=submit]');
    await admin.waitForSelector('#code', { timeout: 15_000 });
    await admin.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
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
    const billing = await call(admin, 'GET', `/platform/billing/tenants/${orgId}`);
    if (!billing.subscription.entitlements.modules.includes('seo')) {
      console.log(`  plan was ${billing.subscription.plan.code}; giving the demo shop all-in-one`);
      await call(admin, 'PUT', `/platform/billing/tenants/${orgId}/subscription`, {
        planCode: 'all-in-one',
        interval: 'month',
        note: 'Demo shop: browser check of the SEO studio',
      });
    }
    const wallet = await call(page, 'GET', `/orgs/${orgId}/billing/wallet`);
    if (wallet.availableMinor < 50_000)
      await call(admin, 'POST', `/platform/billing/tenants/${orgId}/wallet/adjust`, {
        direction: 'credit',
        type: 'bonus',
        amountMinor: 100_000,
        note: 'Demo shop: credit for the SEO browser check',
        idempotencyKey: `seo-flow-${Date.now()}`,
      });
    const stores = await call(page, 'GET', `/orgs/${orgId}/stores`);
    store = stores.items.find((s) => s.handle === HANDLE);
    check(store && store.status === 'live', `run stores-flow first: ${HANDLE} must be open`);
    storeUrl = store.url.endsWith('/') ? store.url : `${store.url}/`;
    // What an earlier run left: its products, its keyword list, the Search Console link.
    const old = await call(page, 'GET', `/orgs/${orgId}/products?q=${encodeURIComponent(NAME)}`);
    for (const p of old.items.filter((x) => x.name === NAME))
      await call(page, 'DELETE', `/orgs/${orgId}/products/${p.id}`);
    const lists = await call(page, 'GET', `/orgs/${orgId}/seo/keyword-lists`);
    for (const l of lists.items.filter((x) => x.name === LIST))
      await call(page, 'DELETE', `/orgs/${orgId}/seo/keyword-lists/${l.id}`);
    const sc = await call(page, 'GET', `/orgs/${orgId}/seo/search-console`);
    if (sc.connection) await call(page, 'DELETE', `/orgs/${orgId}/seo/search-console`);
  });

  await step('super-admin: a price for keyword lookups (credits per lookup)', async () => {
    const rates = await call(admin, 'GET', '/platform/billing/credit-rates');
    const now = Date.now();
    const current = rates
      .filter((r) => r.currency === 'BDT' && Date.parse(r.effectiveFrom) <= now)
      .sort((a, b) => b.version - a.version)[0];
    await admin.goto(`${BASE}/admin/ai-pricing`, { waitUntil: 'networkidle' });
    if (current?.keywordLookupCredits) {
      lookupCredits = current.keywordLookupCredits;
      console.log(`  keyword lookups already cost ${lookupCredits} credits`);
      await shot(admin, '01-admin-keyword-price');
      return;
    }
    await admin.getByRole('button', { name: 'Publish new price' }).click();
    const d = admin.getByRole('dialog');
    await d.locator('#r-keywords').fill('150');
    await d.locator('#r-note').fill('Keyword search volumes for the SEO studio');
    await shot(admin, '01-admin-keyword-price');
    await d.getByRole('button', { name: /^Publish version/ }).click();
    await d.waitFor({ state: 'detached', timeout: 15_000 });
    lookupCredits = 150;
  });

  await step(`keyword research: “${SEED}” with monthly searches, charged once`, async () => {
    const lookups = async () => (await (await fetch(`${KEYWORDS}/__calls`)).json()).total;
    const callsBefore = await lookups();
    await page.goto(`${BASE}${org}/seo/keywords`, { waitUntil: 'networkidle' });
    await page
      .getByTestId('volume-price')
      .getByText(/per lookup/)
      .waitFor({ timeout: 10_000 });
    await page.fill('#kw-seed', SEED);
    await page.fill('#kw-about', 'Handwoven sarees from Narayanganj');
    await page.getByRole('button', { name: 'Find keywords' }).click();
    await page.getByText(`Ideas for “${SEED}”`).waitFor({ timeout: 30_000 });
    await page.getByText('Monthly searches in Bangladesh from Google Ads data.').waitFor();
    const research = (await call(page, 'GET', `/orgs/${orgId}/seo/keywords/research`)).items[0];
    check(research.seed === SEED && research.volumes === 'yes', 'research saved with volumes');
    check(
      research.ideas.some((i) => i.script === 'bangla') &&
        research.ideas.some((i) => i.script === 'banglish') &&
        research.ideas.some((i) => i.script === 'english'),
      'ideas in Bangla, Banglish and English',
    );
    const known = research.ideas.filter((i) => i.volume !== null);
    const unknown = research.ideas.filter((i) => i.volume === null);
    check(known.length > 0, 'some ideas have monthly searches');
    console.log(
      `  ${research.ideas.length} ideas, ${known.length} with volumes, ${unknown.length} "No data"; ${research.credits} credits`,
    );
    if (unknown.length) await page.getByRole('cell', { name: 'No data' }).first().waitFor();
    const calls = await lookups();
    const paid = calls - callsBefore;
    // One paid lookup, unless an earlier run left these volumes in the 30-day cache.
    check(paid <= 1, `${paid} lookups for one research`);
    check(
      paid === 1 ? research.credits >= lookupCredits : research.credits < lookupCredits,
      `${research.credits} credits with ${paid} paid lookups`,
    );
    console.log(paid ? '  volumes looked up (paid)' : '  volumes from the 30-day cache (free)');
    await shot(page, '02-keyword-research', true);

    // The same seed again: the volumes come from the 30-day cache, no new paid lookup.
    await page.getByRole('button', { name: 'Find keywords' }).click();
    await until(
      'the second research',
      async () =>
        (await call(page, 'GET', `/orgs/${orgId}/seo/keywords/research`)).items[0].id !==
        research.id,
      20_000,
      1000,
    );
    const again = (await call(page, 'GET', `/orgs/${orgId}/seo/keywords/research`)).items[0];
    check((await lookups()) === calls, 'volumes from the last 30 days are not looked up again');
    check(again.credits < lookupCredits, `the cached volumes are free (${again.credits} credits)`);
  });

  await step('keyword list: three ideas added; all three are gaps', async () => {
    const pick = ['জামদানি শাড়ি', 'জামদানি শাড়ি দাম', 'jamdani shari dam koto'];
    for (const k of pick)
      await page.getByRole('checkbox', { name: `Choose ${k}`, exact: true }).check();
    await page.locator('#kw-target').selectOption('__new__');
    await page.fill('#kw-new', LIST);
    await page.getByRole('button', { name: /^Add 3 to list/ }).click();
    await page.getByText(`Added to ${LIST}.`).waitFor({ timeout: 10_000 });
    await page.locator('#kl-pick').selectOption({ label: `${LIST} (3)` });
    await page.getByText('3 not targeted yet').waitFor({ timeout: 10_000 });
    await page.getByText(LIST, { exact: false }).last().scrollIntoViewIfNeeded();
    await shot(page, '03-keyword-list-gaps', true);
  });

  await step(
    'new product: AI writes the search fields, live score and Google preview',
    async () => {
      await page.goto(`${BASE}${org}/products/new`, { waitUntil: 'networkidle' });
      await page.fill('#p-name', NAME);
      await page.fill('#p-desc', DESCRIPTION);
      await page.fill('#v0-price', '4500');
      await page.fill('#v0-stock', '10');
      const pic = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 1600;
        c.height = 1200;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 1600, 1200);
        grad.addColorStop(0, 'hsl(350 70% 45%)');
        grad.addColorStop(1, 'hsl(20 80% 35%)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 1600, 1200);
        g.strokeStyle = 'rgba(255,215,0,0.7)';
        g.lineWidth = 6;
        for (let x = 0; x < 1600; x += 80) {
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x + 40, 1200);
          g.stroke();
        }
        return c.toDataURL('image/png').split(',')[1];
      });
      await page.locator('input[type=file]').setInputFiles({
        name: 'jamdani.png',
        mimeType: 'image/png',
        buffer: Buffer.from(pic, 'base64'),
      });
      await page
        .locator('ul[aria-label="Product photos"] img[src*="/v1/storage/"]')
        .waitFor({ timeout: 30_000 });
      const score = async () => Number(await page.getByTestId('seo-score').textContent());
      const before = await score();
      await page.fill('#seo-focus', SEED);
      await page.getByRole('button', { name: 'Write with AI' }).click();
      const s = page.getByLabel('AI suggestion');
      await s.waitFor({ timeout: 30_000 });
      await shot(page, '04-product-ai-suggestion', true);
      await s.getByRole('button', { name: 'Use all' }).click();
      check((await page.inputValue('#seo-title')).includes(SEED), 'the title has the keyword');
      check((await page.inputValue('#seo-slug')) === 'jamdani-shari', 'the address in Banglish');
      check(
        (await page.getByRole('textbox', { name: 'Alt text for photo 1' }).inputValue()).length > 0,
        'the photo got alt text',
      );
      check(
        (await page.getByRole('textbox', { name: 'Question 1' }).inputValue()).length > 0,
        'questions written',
      );
      const after = await score();
      check(after >= 90 && after > before, `score ${before} → ${after}`);
      console.log(`  live score ${before} → ${after}`);
      await page.getByTestId('google-preview').scrollIntoViewIfNeeded();
      await shot(page, '05-product-seo-card', true);
      await page.getByRole('button', { name: 'Add product' }).click();
      await page.waitForURL(/\/products\/[a-f0-9]{24}$/, { timeout: 15_000 });
      product = await call(page, 'GET', `/orgs/${orgId}/products/${page.url().split('/').pop()}`);
      check(product.slug === 'jamdani-shari', `saved at /products/${product.slug}`);
      check(product.seo.keywords[0] === SEED, 'focus keyword saved first');
      check(product.seo.title && product.seo.description, 'title and meta saved');
      check(product.seo.faq.length >= 2, 'questions saved');
      check(product.images[0].alt, 'alt text saved');
    },
  );

  await step(
    'store product page: title, canonical, structured data, FAQ; sitemap, robots',
    async () => {
      const url = `${storeUrl}products/${product.slug}`;
      await shop.goto(url, { waitUntil: 'networkidle' });
      check((await shop.title()).startsWith(product.seo.title), `title is “${await shop.title()}”`);
      const canonical = await shop.locator('link[rel=canonical]').getAttribute('href');
      check(canonical === url, `canonical ${canonical}`);
      check(
        (await shop.locator('meta[name=description]').getAttribute('content')) ===
          product.seo.description,
        'meta description',
      );
      const ld = await ldOf(shop);
      const types = ld.map((x) => x['@type']).sort();
      for (const t of ['BreadcrumbList', 'FAQPage', 'Product'])
        check(types.includes(t), `no ${t} structured data`);
      const bad = ld.flatMap((x) => ldProblems(x).map((p) => `${x['@type']}: ${p}`));
      check(!bad.length, `structured data problems: ${bad.join(', ')}`);
      const offer = ld.find((x) => x['@type'] === 'Product').offers[0];
      check(offer.price === '4500.00' && offer.priceCurrency === 'BDT', 'offer price');
      check(offer.availability === 'https://schema.org/InStock', 'in stock');
      await shop.getByText(product.seo.faq[0].question).first().waitFor();
      await shot(shop, '06-store-product-faq', true);

      const sitemap = await (await shop.goto(`${storeUrl}sitemap.xml`)).text();
      check(sitemap.includes(`<loc>${url}</loc>`), 'the product is in the sitemap');
      const robots = await (await shop.goto(`${storeUrl}robots.txt`)).text();
      check(robots.includes(`Sitemap: ${storeUrl}sitemap.xml`), 'robots.txt names the sitemap');
      // The home page: canonical and the shop as an organisation and a website.
      await shop.goto(storeUrl, { waitUntil: 'networkidle' });
      // Next writes the home page's canonical without the closing slash; both are the same page.
      const home = await shop.locator('link[rel=canonical]').getAttribute('href');
      check(home?.replace(/\/$/, '') === storeUrl.replace(/\/$/, ''), `home canonical ${home}`);
      const homeLd = await ldOf(shop);
      check(
        homeLd.some((x) => x['@type'] === 'Organization'),
        'home Organization',
      );
      check(!homeLd.flatMap(ldProblems).length, 'home structured data');
      console.log(
        `  ${types.join(', ')} valid; sitemap has ${(sitemap.match(/<loc>/g) ?? []).length} addresses`,
      );
    },
  );

  await step('change the address: the old one sends shoppers to the new one', async () => {
    await page.goto(`${BASE}${org}/products/${product.id}`, { waitUntil: 'networkidle' });
    await page.fill('#seo-slug', MOVED);
    await page.getByText(`The old address /products/jamdani-shari will send shoppers`).waitFor();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('Saved.').waitFor({ timeout: 10_000 });
    await page.getByText('Old addresses that still work').waitFor();
    const res = await shop.goto(`${storeUrl}products/jamdani-shari`, { waitUntil: 'networkidle' });
    check(shop.url() === `${storeUrl}products/${MOVED}`, `ended on ${shop.url()}`);
    check(res.request().redirectedFrom(), 'a redirect');
    const status = (await res.request().redirectedFrom().response()).status();
    check(status === 308 || status === 301, `redirect status ${status}`);
    product = await call(page, 'GET', `/orgs/${orgId}/products/${product.id}`);
    console.log(`  /products/jamdani-shari → /products/${MOVED} (${status})`);
  });

  await step('the keyword list: the product now targets the Bangla keywords', async () => {
    await page.goto(`${BASE}${org}/seo/keywords`, { waitUntil: 'networkidle' });
    await page.locator('#kl-pick').selectOption({ label: `${LIST} (3)` });
    await page.getByRole('link', { name: NAME }).first().waitFor({ timeout: 10_000 });
    const lists = await call(page, 'GET', `/orgs/${orgId}/seo/keyword-lists`);
    const l = await call(
      page,
      'GET',
      `/orgs/${orgId}/seo/keyword-lists/${lists.items.find((x) => x.name === LIST).id}`,
    );
    check(l.gaps < 3, `gaps ${l.gaps}`);
    await page.locator('#kl-pick').scrollIntoViewIfNeeded();
    await shot(page, '07-keyword-list-targeted', true);
  });

  await step('Search Console: consent, verification tag, sitemap sent, numbers', async () => {
    await page.goto(`${BASE}${org}/seo/search-console`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Connect Google Search Console' }).waitFor();
    await shot(page, '08-search-console-connect');
    await page.getByRole('button', { name: 'Connect with Google' }).click();
    await page.waitForURL(`${GOOGLE}/o/oauth2/v2/auth**`);
    const scope = new URL(page.url()).searchParams.get('scope') ?? '';
    check(scope.includes('webmasters') && scope.includes('siteverification'), `scope ${scope}`);
    await page.getByText('not Google').waitFor();
    await shot(page, '09-google-consent-stand-in');
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(`**/app/${orgId}/seo/search-console**`);
    await page.getByText('Google is connected.').waitFor();
    await page.waitForURL((u) => !u.search.includes('google='), { timeout: 5000 });
    const c = await until(
      'Search Console setup and the first numbers',
      async () => {
        const s = await call(page, 'GET', `/orgs/${orgId}/seo/search-console?days=28`);
        if (s.connection?.setupError) throw new Error(`setup: ${s.connection.setupError}`);
        return s.report?.ready ? s : null;
      },
      240_000,
    );
    // The tag is on the store's home page, where the stand-in found it.
    await shop.goto(storeUrl, { waitUntil: 'networkidle' });
    const tag = await shop.locator('meta[name="google-site-verification"]').getAttribute('content');
    check(tag && tag.length > 20, 'the verification tag is on the store');
    const g = await (await fetch(`${GOOGLE}/__search-console`)).json();
    check(g.owners[storeUrl]?.length === 1, 'the stand-in verified the owner');
    check(g.sitemaps[storeUrl]?.[0]?.urls > 0, 'the sitemap was sent and read');
    check(c.report.totals.impressions > 0, 'impressions');
    check(c.report.topQueries.length > 0 && c.report.topPages.length > 0, 'top phrases and pages');
    console.log(
      `  ${c.report.totals.clicks} clicks, ${c.report.totals.impressions} impressions (made up by the stand-in); ${c.report.opportunities.length} opportunities`,
    );
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('Clicks from Google per day').waitFor();
    await shot(page, '10-search-console-report', true);
  });

  await step('SEO overview and the bulk optimiser: write, then save', async () => {
    await page.goto(`${BASE}${org}/seo`, { waitUntil: 'networkidle' });
    await page.getByText('Products, lowest score first').waitFor();
    await shot(page, '11-seo-overview', true);
    const audit = await call(page, 'GET', `/orgs/${orgId}/seo/audit`);
    check(
      audit.stores.some((s) => s.checks.find((x) => x.key === 'search_console')?.ok),
      'store connected',
    );
    const low = audit.products.items.filter((p) => p.id !== product.id).slice(0, 2);
    check(low.length === 2, 'two products to fix');
    for (const p of low)
      await page.getByRole('checkbox', { name: `Choose ${p.name}`, exact: true }).check();
    await page.getByRole('button', { name: 'Write for 2 chosen' }).click();
    await page.waitForURL(/\/seo\/bulk\/[a-f0-9]{24}$/, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Save all ready (2)' }).waitFor({ timeout: 90_000 });
    await shot(page, '12-bulk-written', true);
    await page.getByRole('button', { name: 'Save all ready (2)' }).click();
    await page.getByText('Saved 2 products.').waitFor({ timeout: 20_000 });
    const runId = page.url().split('/').pop();
    const run = await call(page, 'GET', `/orgs/${orgId}/seo/bulk/${runId}`);
    check(run.counts.applied === 2, `applied ${run.counts.applied}`);
    for (const i of run.items)
      check(i.scoreAfter >= i.scoreBefore, `${i.name}: ${i.scoreBefore} → ${i.scoreAfter}`);
    console.log(
      `  ${run.items.map((i) => `${i.name} ${i.scoreBefore}→${i.scoreAfter}`).join(', ')}`,
    );
    await shot(page, '13-bulk-saved', true);
  });

  await step('content studio: a Facebook ad in Bangla, kept as a draft', async () => {
    await page.goto(`${BASE}${org}/seo/content`, { waitUntil: 'networkidle' });
    await page.fill('#cs-source', `${NAME}. ${DESCRIPTION}`);
    await page.fill('#cs-notes', 'Mention free delivery inside Dhaka');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.getByRole('button', { name: 'Copy version 1' }).first().waitFor({ timeout: 30_000 });
    const drafts = await call(page, 'GET', `/orgs/${orgId}/seo/content`);
    check(
      drafts.items[0].kind === 'facebook_ad' && drafts.items[0].variants.length === 3,
      'three versions',
    );
    await shot(page, '14-content-studio', true);
  });

  await step("store settings: AI writes the home page's search title (not saved)", async () => {
    await page.goto(`${BASE}${org}/store/${store.id}/details`, { waitUntil: 'networkidle' });
    const before = await page.inputValue('#d-seo-title');
    await page.getByRole('button', { name: 'Write with AI' }).click();
    await until(
      'the written title',
      async () => (await page.inputValue('#d-seo-title')) !== before,
      20_000,
      500,
    );
    await page.locator('#d-seo-title').scrollIntoViewIfNeeded();
    await shot(page, '15-store-seo-written');
  });
} catch (err) {
  failed = true;
  console.error(err);
  await page
    .screenshot({ path: join(OUT, 'failure-merchant.png'), fullPage: true })
    .catch(() => {});
} finally {
  await browser.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok ' : 'FAIL'} ${s.name}${s.ok ? ` (${s.ms} ms)` : `: ${s.error}`}`);
if (problems.length) console.log(`problems:\n  ${[...new Set(problems)].join('\n  ')}`);
console.log(failed || problems.length ? 'SEO FLOW FAILED' : 'SEO FLOW PASSED');
process.exit(failed || problems.length ? 1 : 0);
