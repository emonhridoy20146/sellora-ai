import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../../src/modules/billing/entitlements.service.js';
import { CatalogSyncRunner } from '../../src/modules/catalog-sync/catalog-sync.runner.js';
import { FakeAnthropic, toolResults } from '../helpers/fake-anthropic.js';
import { FakeDns, FakeSite, htmlPage, productLd, type FakeProduct } from '../helpers/fake-site.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface Counts {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  restored: number;
  failed: number;
  held: number;
}

interface RunDto {
  id: string;
  status: string;
  counts: Counts;
  pages: { read: number; added: number; changed: number; removed: number; notRead: number } | null;
  problems: { ref: string; message: string }[];
  error: string | null;
}

interface HeldDto {
  ref: string;
  kind: string;
  label: string;
  prices: { variant: string; fromMinor: number; toMinor: number }[];
  names: string[];
  decision: string;
}

interface SourceDto {
  id: string;
  kind: string;
  name: string;
  url: string;
  intervalMinutes: number;
  nextSyncAt: string | null;
  holdLargeChanges: boolean;
  held: HeldDto[];
  website: {
    host: string;
    verified: boolean;
    verifiedBy: string | null;
    verifyError: string | null;
    token: string;
    dnsName: string;
    dnsValue: string;
    metaTag: string;
    importProducts: boolean;
    readPages: boolean;
    pageCount: number;
  };
  lastRun: { status: string; error: string | null } | null;
}

interface ProductDto {
  id: string;
  name: string;
  status: string;
  description: string;
  images: { url: string; fileId: string | null }[];
  options: { name: string; values: string[] }[];
  variants: {
    title: string;
    sku: string | null;
    priceMinor: number;
    trackStock: boolean;
    stock: number;
  }[];
  sync: { sourceId: string } | null;
}

const words = (n: number, w = 'handmade') => Array.from({ length: n }, () => w).join(' ');

describe('Website crawl: ownership, products and pages for the AI (ADR 0024)', () => {
  const site = new FakeSite();
  const dns = new FakeDns();
  const ai = new FakeAnthropic();
  let t: TestApp;
  let owner: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let sourceId = '';
  let token = '';

  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const O = () => t.as(owner.token);
  const run = async (runId: string) => {
    await t.app.get(CatalogSyncRunner).run(orgId, runId);
    return (
      await O()
        .get(url(`/catalog-sources/${sourceId}/runs/${runId}`))
        .expect(200)
    ).body as RunDto;
  };
  const syncNow = async () => {
    const r = (
      await O()
        .post(url(`/catalog-sources/${sourceId}/sync`))
        .expect(202)
    ).body as RunDto;
    return run(r.id);
  };
  const source = async () =>
    (
      await O()
        .get(url(`/catalog-sources/${sourceId}`))
        .expect(200)
    ).body as SourceDto;
  const products = async () =>
    (
      (await O().get(url('/products?status=all&limit=100')).expect(200)).body.items as ProductDto[]
    ).filter((p) => p.sync?.sourceId === sourceId || p.name.startsWith('Extra '));
  const byName = async (name: string) => {
    const p = (await products()).find((x) => x.name === name);
    if (!p) throw new Error(`No product ${name}`);
    return p;
  };
  const pageKeys = async () =>
    (
      (
        await O()
          .get(url(`/catalog-sources/${sourceId}/pages?limit=50`))
          .expect(200)
      ).body.items as { url: string }[]
    )
      .map((p) => new URL(p.url).pathname)
      .sort();

  // The demo website.
  const saree: FakeProduct = {
    name: 'Jamdani Saree',
    sku: 'JAM-1',
    price: 3200,
    image: '/img/saree.png',
  };
  const verifyTag = () => `<meta name="sellora-site-verification" content="${token}">`;
  let homeHead = '';
  const homeLinks = [
    '/p/jamdani-saree',
    '/p/eid-panjabi',
    '/p/clay-pot',
    '/p/lungi',
    '/delivery',
    '/about-us',
    '/private/stock',
    '/cart/',
    '/search?q=saree',
    '/hidden-page',
    '/thin',
    'https://elsewhere.example/page',
  ];
  const putHome = (extraLinks: string[] = []) =>
    site.pages.set('/', {
      html: htmlPage({
        title: 'Nakshi Ghor — Handmade in Bangladesh',
        head: homeHead,
        links: [...homeLinks, ...extraLinks],
        body: `<h1>Nakshi Ghor</h1><p>Sarees, panjabis and clay pots made by hand in Rajshahi and Dhaka. ${words(20)}</p>`,
      }),
    });
  const putSaree = () =>
    site.pages.set('/p/jamdani-saree', {
      html: htmlPage({
        title: 'Jamdani Saree | Nakshi Ghor',
        head: productLd(saree),
        body: `<h1>Jamdani Saree</h1><p>Six yards of Dhakai jamdani, woven over three weeks. ${words(20)}</p>`,
      }),
    });
  const panjabi = (m: string, l: string) =>
    site.pages.set('/p/eid-panjabi', {
      html: htmlPage({
        title: 'Eid Panjabi',
        head: `<script type="application/ld+json">${JSON.stringify({
          '@type': 'ProductGroup',
          name: 'Eid Panjabi',
          variesBy: 'https://schema.org/size',
          hasVariant: [
            {
              '@type': 'Product',
              sku: 'PJ-M',
              size: 'M',
              offers: { price: 1800, availability: m },
            },
            {
              '@type': 'Product',
              sku: 'PJ-L',
              size: 'L',
              offers: { price: 1900, availability: l },
            },
          ],
        })}</script>`,
        body: `<p>Cotton panjabi for Eid in two sizes. ${words(20)}</p>`,
      }),
    });
  const clayPot = (path: string) =>
    site.pages.set(path, {
      html: htmlPage({
        title: 'Clay Pot',
        head:
          '<meta property="og:type" content="product"><meta property="og:title" content="Clay Pot">' +
          '<meta property="product:price:amount" content="450"><meta property="product:price:currency" content="BDT">' +
          '<meta property="product:retailer_item_id" content="POT-1">',
        body: `<p>A clay pot from Bogura. ${words(20)}</p>`,
      }),
    });

  beforeAll(async () => {
    await site.start();
    t = await TestApp.create(
      {
        SYNC_ALLOW_PRIVATE_NETWORK: 'true',
        CRAWL_MIN_DELAY_MS: '0',
        AI_ANTHROPIC_API_KEY: 'sk-ant-test-key',
      },
      { aiFetch: ai.fetch, dnsLookup: dns },
    );
    owner = await t.registerUser({ name: 'Owner Rahman' });
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor' })).id;
    rival = await t.registerUser({ name: 'Rival Owner' });
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Bazar' })).id;
    await Promise.all(
      ['Product', 'CatalogSource', 'CatalogSyncRun', 'WebsitePage'].map((m) =>
        t.db.model(m).init(),
      ),
    );

    site.robots = {
      status: 200,
      text: `User-agent: *\nDisallow: /private/\nSitemap: ${site.base}/sitemap.xml\n`,
    };
    site.sitemap = ['/p/jamdani-saree', '/delivery', '/sitemap-only'];
    putHome();
    putSaree();
    panjabi('InStock', 'OutOfStock');
    clayPot('/p/clay-pot');
    site.pages.set('/p/lungi', {
      html: htmlPage({
        title: 'Cotton Lungi',
        head: `<script type="application/ld+json">${JSON.stringify({
          '@type': 'Product',
          name: 'Cotton Lungi',
          offers: {
            '@type': 'AggregateOffer',
            lowPrice: 450,
            highPrice: 650,
            priceCurrency: 'BDT',
          },
        })}</script>`,
        body: `<p>Checked cotton lungi in many colours. ${words(20)}</p>`,
      }),
    });
    site.pages.set('/delivery', {
      html: htmlPage({
        title: 'Delivery and returns',
        body:
          '<h2>Delivery charges</h2><p>Inside Dhaka the delivery charge is 80 taka and it takes 1-2 days.</p>' +
          '<p>Outside Dhaka the delivery charge is 150 taka and it takes 3-5 days. Cash on delivery everywhere.</p>' +
          '<h2>ফেরত নীতি</h2><p>পণ্য হাতে পাওয়ার ৭ দিনের মধ্যে ফেরত দেওয়া যায়, ট্যাগ লাগানো থাকতে হবে।</p>',
      }),
    });
    site.pages.set('/about-us', {
      html: htmlPage({
        title: 'About us',
        body: `<p>We started in 2015 with three looms in Rajshahi. ${words(20)}</p>`,
      }),
    });
    site.pages.set('/sitemap-only', {
      html: htmlPage({
        title: 'Care guide',
        body: `<p>Wash jamdani by hand in cold water and dry it in shade. ${words(20)}</p>`,
      }),
    });
    site.pages.set('/private/stock', { html: htmlPage({ title: 'Private', body: words(40) }) });
    site.pages.set('/hidden-page', {
      html: htmlPage({
        title: 'Hidden',
        head: '<meta name="robots" content="noindex">',
        body: words(40),
      }),
    });
    site.pages.set('/thin', {
      html: htmlPage({ title: 'Thin', body: '<p>Just a few words.</p>' }),
    });
  });

  afterAll(async () => {
    await t?.close();
    await site.stop();
  });

  it('checks a website before saving: reads only robots.txt, the home page and the sitemap', async () => {
    const res = await O()
      .post(url('/catalog-sources/check'))
      .send({ kind: 'website', url: `${site.base}/some/page?x=1` })
      .expect(200);
    expect(res.body).toMatchObject({
      title: 'Nakshi Ghor — Handmade in Bangladesh',
      sample: [],
      site: {
        address: `${site.base}/`,
        robotsAllowed: true,
        sitemapPages: 3,
        hasVerificationTag: false,
      },
    });
    expect(new Set(site.paths())).toEqual(new Set(['/', '/robots.txt', '/sitemap.xml']));
  });

  it('adds the website without crawling it: it must be verified first', async () => {
    await O()
      .post(url('/catalog-sources'))
      .send({ source: { kind: 'website', url: site.base }, intervalMinutes: 15 })
      .expect(422);
    site.log.length = 0;
    const res = await O()
      .post(url('/catalog-sources'))
      .send({ source: { kind: 'website', url: site.base } })
      .expect(201);
    const s = res.body.source as SourceDto;
    sourceId = s.id;
    token = s.website.token;
    expect(res.body.runId).toBeNull();
    expect(s).toMatchObject({
      kind: 'website',
      name: 'Nakshi Ghor — Handmade in Bangladesh',
      intervalMinutes: 1440,
      nextSyncAt: null,
      holdLargeChanges: true,
      website: {
        host: '127.0.0.1',
        verified: false,
        importProducts: true,
        readPages: true,
        dnsName: '_sellora-verify.127.0.0.1',
        dnsValue: `sellora-verify=${token}`,
        metaTag: `<meta name="sellora-site-verification" content="${token}">`,
      },
    });
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(site.paths().filter((p) => p.startsWith('/p/'))).toEqual([]);
    const again = await O()
      .post(url('/catalog-sources'))
      .send({ source: { kind: 'website', url: site.base } })
      .expect(409);
    expect(again.body.code).toBe('website_exists');
    const early = await O()
      .post(url(`/catalog-sources/${sourceId}/sync`))
      .expect(422);
    expect(early.body.code).toBe('site_not_verified');
  });

  it('refuses to verify without the tag or the record, and says what it looked for', async () => {
    const res = await O()
      .post(url(`/catalog-sources/${sourceId}/verify`))
      .expect(422);
    expect(res.body.code).toBe('site_not_verified');
    expect(res.body.detail).toMatch(/neither the sellora-site-verification tag/);
    expect(dns.asked).toContain('127.0.0.1');
    expect((await source()).website.verifyError).toMatch(/neither/);
  });

  it('verifies with the meta tag and crawls: products from schema.org data, pages for the AI', async () => {
    homeHead = verifyTag();
    putHome();
    const res = await O()
      .post(url(`/catalog-sources/${sourceId}/verify`))
      .expect(200);
    expect(res.body.source.website).toMatchObject({
      verified: true,
      verifiedBy: 'meta',
      verifyError: null,
    });
    site.log.length = 0;
    const r = await run(res.body.runId as string);
    expect(r.error).toBeNull();
    expect(r.status).toBe('partial');
    expect(r.counts).toMatchObject({ seen: 3, created: 3, failed: 1, held: 0 });
    expect(r.problems).toContainEqual({
      ref: 'Cotton Lungi',
      message: expect.stringMatching(/price range \(450–650\)/),
    });
    expect(r.pages).toMatchObject({ notRead: 0, removed: 0 });
    expect(r.pages!.added).toBe(8);

    // robots.txt first, the home page next; never the disallowed, cart, search or other sites.
    expect(site.paths().slice(0, 2)).toEqual(['/robots.txt', '/']);
    for (const p of ['/private/stock', '/cart/', '/search?q=saree'])
      expect(site.paths()).not.toContain(p);
    expect(site.paths()).toContain('/sitemap-only');
    expect(site.log.every((l) => /^SelloraBot\/1\.0 \(\+http.*\/bot\)$/.test(l.ua))).toBe(true);

    expect(await pageKeys()).toEqual([
      '/',
      '/about-us',
      '/delivery',
      '/p/clay-pot',
      '/p/eid-panjabi',
      '/p/jamdani-saree',
      '/p/lungi',
      '/sitemap-only',
    ]);
    const s = await byName('Jamdani Saree');
    expect(s).toMatchObject({
      status: 'active',
      description: 'Jamdani Saree, made in Bangladesh.',
    });
    expect(s.variants).toMatchObject([{ sku: 'JAM-1', priceMinor: 320000, trackStock: false }]);
    expect(s.images[0]!.fileId).toBeTruthy();
    const pj = await byName('Eid Panjabi');
    expect(pj.options).toEqual([{ name: 'Size', values: ['M', 'L'] }]);
    expect(pj.variants.map((v) => [v.sku, v.priceMinor, v.trackStock, v.stock])).toEqual([
      ['PJ-M', 180000, false, 0],
      ['PJ-L', 190000, true, 0],
    ]);
    expect((await byName('Clay Pot')).variants[0]).toMatchObject({
      sku: 'POT-1',
      priceMinor: 45000,
    });
    expect((await source()).website.pageCount).toBe(8);
  });

  it('finds page passages for questions in English and Bangla, and only for this business', async () => {
    const en = await O()
      .get(url('/catalog-sources/website/search'))
      .query({ q: 'delivery charge outside Dhaka' })
      .expect(200);
    expect(en.body.hits[0]).toMatchObject({ title: 'Delivery and returns' });
    expect(en.body.hits[0].passages).toContain('Outside Dhaka the delivery charge is 150 taka');
    const bn = await O()
      .get(url('/catalog-sources/website/search'))
      .query({ q: 'ফেরত' })
      .expect(200);
    expect(bn.body.hits[0].passages).toContain('৭ দিনের মধ্যে ফেরত');
    const part = await O()
      .get(url('/catalog-sources/website/search'))
      .query({ q: 'looms' })
      .expect(200);
    expect(part.body.hits[0].title).toBe('About us');
    const theirs = await t
      .as(rival.token)
      .get(url('/catalog-sources/website/search', rivalOrgId))
      .query({ q: 'delivery' })
      .expect(200);
    expect(theirs.body.hits).toEqual([]);
    await t
      .as(rival.token)
      .get(url(`/catalog-sources/${sourceId}/pages`, rivalOrgId))
      .expect(404);
  });

  it('gives the AI agent the website: a prompt section and a search_website tool', async () => {
    ai.reset();
    ai.then(
      FakeAnthropic.tool('search_website', { query: 'delivery charge outside Dhaka' }),
      FakeAnthropic.text('Outside Dhaka delivery is ৳150 and takes 3-5 days.'),
    );
    const res = await O()
      .post(url('/ai-agent/preview'))
      .send({ messages: [{ from: 'customer', text: 'Dhakar baire delivery charge koto?' }] })
      .expect(200);
    expect(res.body).toMatchObject({
      reply: 'Outside Dhaka delivery is ৳150 and takes 3-5 days.',
      toolCalls: [{ name: 'search_website', ok: true }],
    });
    const first = ai.requests[0]!.body as unknown as { system: string; tools: { name: string }[] };
    expect(JSON.stringify(first.system)).toContain('## Website');
    expect(JSON.stringify(first.system)).toContain(
      'has 8 pages you can search with search_website',
    );
    expect(first.tools.map((x) => x.name)).toContain('search_website');
    const result = Object.values(toolResults(ai.requests[1]!))[0]!;
    const body = JSON.parse(result.content) as { results: { url: string; text: string }[] };
    expect(body.results[0]!.url).toBe(`${site.base}/delivery`);
    expect(body.results[0]!.text).toContain('150 taka');
  });

  it('applies a price change at the next crawl (the exit test): the AI sees the new price', async () => {
    saree.price = 3000;
    putSaree();
    const r = await syncNow();
    expect(r.counts).toMatchObject({ updated: 1, held: 0 });
    expect(r.pages).toMatchObject({ changed: 0 });
    expect((await byName('Jamdani Saree')).variants[0]!.priceMinor).toBe(300000);
  });

  it('holds a price change of more than half until the merchant applies it', async () => {
    saree.price = 900;
    putSaree();
    const r = await syncNow();
    expect(r.status).toBe('partial');
    expect(r.counts).toMatchObject({ held: 1, updated: 0 });
    expect(r.problems.map((p) => p.message).join(' ')).toMatch(/৳3,000 → ৳900/);
    expect((await byName('Jamdani Saree')).variants[0]!.priceMinor).toBe(300000);
    const held = (await source()).held;
    expect(held).toEqual([
      expect.objectContaining({
        ref: '/p/jamdani-saree',
        kind: 'price',
        label: 'Jamdani Saree',
        prices: [{ variant: '', fromMinor: 300000, toMinor: 90000 }],
        decision: 'pending',
      }),
    ]);
    await O()
      .post(url(`/catalog-sources/${sourceId}/held`))
      .send({ ref: '/p/nothing', decision: 'apply' })
      .expect(404);
    const res = await O()
      .post(url(`/catalog-sources/${sourceId}/held`))
      .send({ ref: '/p/jamdani-saree', decision: 'apply' })
      .expect(200);
    const applied = await run(res.body.runId as string);
    expect(applied.counts).toMatchObject({ updated: 1, held: 0 });
    expect((await byName('Jamdani Saree')).variants[0]!.priceMinor).toBe(90000);
    expect((await source()).held).toEqual([]);
  });

  it('keeps Sellora’s price when the merchant says so, until the source changes again', async () => {
    saree.price = 2000;
    putSaree();
    expect((await syncNow()).counts.held).toBe(1);
    await O()
      .post(url(`/catalog-sources/${sourceId}/held`))
      .send({ ref: '/p/jamdani-saree', decision: 'keep' })
      .expect(200);
    const again = await syncNow();
    expect(again.counts).toMatchObject({ held: 0, updated: 0 });
    expect(again.status).toBe('partial'); // Lungi is still skipped
    expect((await byName('Jamdani Saree')).variants[0]!.priceMinor).toBe(90000);
    expect((await source()).held[0]).toMatchObject({ decision: 'keep' });
    saree.price = 950;
    putSaree();
    expect((await syncNow()).counts.updated).toBe(1);
    expect((await byName('Jamdani Saree')).variants[0]!.priceMinor).toBe(95000);
    expect((await source()).held).toEqual([]);
  });

  it('follows "sold out" at the site: sold out is a counted 0, back in stock is not counted', async () => {
    panjabi('OutOfStock', 'InStock');
    expect((await syncNow()).counts.updated).toBe(1);
    expect(
      (await byName('Eid Panjabi')).variants.map((v) => [v.sku, v.trackStock, v.stock]),
    ).toEqual([
      ['PJ-M', true, 0],
      ['PJ-L', false, 0],
    ]);
  });

  it('moves a product whose page moved, archives it when the page is gone, restores it when back', async () => {
    const before = await byName('Clay Pot');
    site.pages.set('/p/clay-pot', { redirect: '/p/clay-pot-2' });
    clayPot('/p/clay-pot-2');
    const moved = await syncNow();
    expect(moved.counts).toMatchObject({ created: 0, archived: 0 });
    const after = await byName('Clay Pot');
    expect(after.id).toBe(before.id);
    expect((await pageKeys()).filter((k) => k.startsWith('/p/clay'))).toEqual(['/p/clay-pot-2']);

    site.pages.delete('/p/clay-pot');
    site.pages.delete('/p/clay-pot-2');
    const gone = await syncNow();
    expect(gone.counts.archived).toBe(1);
    expect((await byName('Clay Pot')).status).toBe('archived');
    // Not linked anywhere any more, but its page is re-read first, so it comes back.
    clayPot('/p/clay-pot-2');
    const back = await syncNow();
    expect(back.counts.restored).toBe(1);
    expect((await byName('Clay Pot')).status).toBe('active');
  });

  it('holds archiving more than half of the products at once', async () => {
    const extras = Array.from({ length: 6 }, (_, i) => `/p/extra-${i + 1}`);
    extras.forEach((p, i) =>
      site.pages.set(p, {
        html: htmlPage({
          title: `Extra ${i + 1}`,
          head: productLd({ name: `Extra ${i + 1}`, sku: `EX-${i + 1}`, price: 100 + i }),
          body: `<p>${words(25)}</p>`,
        }),
      }),
    );
    putHome(extras);
    expect((await syncNow()).counts.created).toBe(6);
    extras.forEach((p) => site.pages.delete(p));
    const r = await syncNow();
    expect(r.counts).toMatchObject({ archived: 0, held: 1 });
    const held = (await source()).held.find((h) => h.kind === 'archive')!;
    expect(held).toMatchObject({ ref: 'archive', label: '6 products', decision: 'pending' });
    expect(held.names).toHaveLength(6);
    const res = await O()
      .post(url(`/catalog-sources/${sourceId}/held`))
      .send({ ref: 'archive', decision: 'apply' })
      .expect(200);
    expect((await run(res.body.runId as string)).counts.archived).toBe(6);
    expect((await byName('Extra 1')).status).toBe('archived');
    putHome();
  });

  it('does not crawl while robots.txt cannot be read, and stops at the plan’s page limit', async () => {
    site.robots = { ...site.robots, status: 500 };
    const failed = await syncNow();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/robots\.txt could not be read \(HTTP 500\)/);
    site.robots = { ...site.robots, status: 200 };

    const subs = t.db.collection('subscriptions');
    await subs.updateOne(
      { orgId: new Types.ObjectId(orgId) },
      { $set: { 'limits.websitePages': 3 } },
    );
    await t.app.get(EntitlementsService).invalidate(orgId);
    const cut = await syncNow();
    expect(cut.status).toBe('partial');
    expect(cut.pages).toMatchObject({ read: 3 });
    expect(cut.pages!.notRead).toBeGreaterThan(0);
    expect(cut.problems.map((p) => p.message).join(' ')).toMatch(
      /Read 3 pages, the most one crawl may read/,
    );
    expect(cut.counts.archived).toBe(0);
    // Pages it did not reach are kept.
    expect((await pageKeys()).length).toBeGreaterThanOrEqual(8);
    await subs.updateOne(
      { orgId: new Types.ObjectId(orgId) },
      { $set: { 'limits.websitePages': null } },
    );
    await t.app.get(EntitlementsService).invalidate(orgId);
  });

  it('stops when the ownership proof is gone, and verifies again with a DNS TXT record', async () => {
    homeHead = '';
    putHome();
    const lost = await syncNow();
    expect(lost.status).toBe('failed');
    expect(lost.error).toMatch(/neither the sellora-site-verification tag/);
    const s = await source();
    expect(s.website).toMatchObject({ verified: false });
    expect(s.nextSyncAt).toBeNull();
    await O()
      .post(url(`/catalog-sources/${sourceId}/sync`))
      .expect(422);

    dns.txt.set('127.0.0.1', [`sellora-verify=${token}`]);
    const res = await O()
      .post(url(`/catalog-sources/${sourceId}/verify`))
      .expect(200);
    expect(res.body.source.website).toMatchObject({ verified: true, verifiedBy: 'dns' });
    expect((await run(res.body.runId as string)).error).toBeNull();
  });

  it('forgets the pages when the AI may no longer read them, and on removal keeps the products', async () => {
    const off = await O()
      .patch(url(`/catalog-sources/${sourceId}`))
      .send({ readPages: false })
      .expect(200);
    expect(off.body.website.pageCount).toBe(0);
    const none = await O()
      .get(url('/catalog-sources/website/search'))
      .query({ q: 'delivery' })
      .expect(200);
    expect(none.body.hits).toEqual([]);
    const r = await syncNow();
    expect(r.pages).toMatchObject({ added: 0 });
    await O()
      .patch(url(`/catalog-sources/${sourceId}`))
      .send({ readPages: true })
      .expect(200);
    await syncNow();
    expect((await source()).website.pageCount).toBeGreaterThan(0);

    await O()
      .patch(url(`/catalog-sources/${sourceId}`))
      .send({ intervalMinutes: 15 })
      .expect(422);
    await O()
      .patch(url(`/catalog-sources/${sourceId}`))
      .send({ url: 'https://other.example' })
      .expect(422);

    await O()
      .delete(url(`/catalog-sources/${sourceId}`))
      .expect(200);
    expect(await t.db.collection('website_pages').countDocuments({})).toBe(0);
    const saved = (
      (await O().get(url('/products?status=all&limit=100')).expect(200)).body.items as ProductDto[]
    ).find((p) => p.name === 'Jamdani Saree');
    expect(saved).toMatchObject({ status: 'active', sync: null });
  });
});
