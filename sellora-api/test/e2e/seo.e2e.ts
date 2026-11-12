import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { SearchConsoleService, SEO_JOBS } from '../../src/modules/seo/search-console.service.js';
import { SeoAuditService } from '../../src/modules/seo/seo-audit.service.js';
import {
  SEO_GOOGLE_SCOPES,
  WEBMASTERS_SCOPE,
} from '../../src/modules/seo/search-console.client.js';
import { FakeAnthropic } from '../helpers/fake-anthropic.js';
import { FakeGoogle, GOOGLE_TEST, googleEnv } from '../helpers/fake-google.js';
import { FakeKeywords, keywordsEnv } from '../helpers/fake-keywords.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ProductDto {
  id: string;
  name: string;
  slug: string;
  previousSlugs: string[];
  description: string;
  tags: string[];
  images: { url: string; alt: string }[];
  seo: {
    title: string;
    description: string;
    keywords: string[];
    faq: { question: string; answer: string }[];
  };
}

const suggestion = (over: Record<string, unknown> = {}) => ({
  focusKeyword: 'জামদানি শাড়ি',
  keywords: ['জামদানি শাড়ি', 'jamdani saree', 'dhakai jamdani price'],
  seoTitle: 'জামদানি শাড়ি: হাতে বোনা ঢাকাই জামদানি অর্ডার করুন',
  slug: 'Jamdani Saree Dhakai',
  metaDescription:
    'হাতে বোনা ঢাকাই জামদানি শাড়ি, নরম সুতি আর ঝলমলে নকশা। ঢাকার ভেতরে ও বাইরে হোম ডেলিভারি, ক্যাশ অন ডেলিভারিতে অর্ডার করুন আজই।',
  description: `জামদানি শাড়ি ${'হাতে বোনা নরম সুতির নকশা '.repeat(30)}`,
  tags: ['jamdani', 'saree', 'dhakai'],
  imageAlts: ['Red Dhakai jamdani saree folded', 'Close up of jamdani weave', 'extra alt'],
  faq: [
    { question: 'শাড়িটা কি হাতে বোনা?', answer: 'হ্যাঁ, পুরোটা তাঁতে হাতে বোনা।' },
    { question: 'ডেলিভারি কত দিনে?', answer: 'ঢাকায় ২-৩ দিন।' },
    { question: '', answer: 'dropped: no question' },
  ],
  ...over,
});

describe('AI SEO studio and content studio (ADR 0032)', () => {
  const ai = new FakeAnthropic();
  const google = new FakeGoogle();
  const keywords = new FakeKeywords();
  let t: TestApp;
  let owner: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let platform: string;
  let key: string;
  let storeId: string;
  let host: string;

  const O = () => t.as(owner.token);
  const R = () => t.as(rival.token);
  const P = () => t.as(platform);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const shop = (path: string) =>
    t
      .http()
      .get(`/v1/storefront${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', '203.0.113.9');
  const usage = (feature: string) =>
    t.db.collection('ai_usage').find({ feature }).sort({ createdAt: 1 }).toArray();
  const queue = () => t.app.get<Queue>(getQueueToken(QUEUES.seo));
  const sc = () => t.app.get(SearchConsoleService);

  const createProduct = async (body: Record<string, unknown>) =>
    (await O().post(url('/products')).send(body).expect(201)).body as ProductDto;

  beforeAll(async () => {
    t = await TestApp.create(
      {
        API_PUBLIC_URL: 'http://api.test',
        AI_ANTHROPIC_API_KEY: 'sk-ant-test-key',
        ...googleEnv,
        ...keywordsEnv,
      },
      { aiFetch: ai.fetch, googleFetch: google.fetch, keywordFetch: keywords.fetch },
    );
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner Akter' });
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor' })).id;
    rival = await t.registerUser({ name: 'Rival Owner' });
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Shop' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      [
        'Product',
        'Store',
        'AiUsage',
        'KeywordVolumeCache',
        'KeywordList',
        'SeoGoogle',
        'SearchConsoleDay',
      ].map((m) => t.db.model(m).init()),
    );
    await createProduct({ name: 'Jamdani Saree', variants: [{ priceMinor: 450_000, stock: 5 }] });
    const store = (await O().post(url('/stores')).send({ name: 'Nakshi Ghor' }).expect(201))
      .body as { id: string; handle: string; host: string };
    storeId = store.id;
    host = store.host;
    await O()
      .patch(url(`/stores/${storeId}`))
      .send({ contact: { phone: '01712345678' } })
      .expect(200);
    await O()
      .post(url(`/stores/${storeId}/submit`))
      .expect(200);
    await P().post(`/v1/platform/stores/${storeId}/approve`).send({}).expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    ai.reset();
    keywords.reset();
  });

  describe('writing a product’s SEO fields with AI', () => {
    it('asks for a structured answer, fits it to the product and charges the tokens', async () => {
      ai.then(FakeAnthropic.json(suggestion()));
      const res = await O()
        .post(url('/seo/write/product'))
        .send({
          name: 'Jamdani Saree',
          description: 'Handwoven Dhakai jamdani.',
          tags: ['saree'],
          imageCount: 2,
          priceMinor: 450_000,
          focusKeyword: 'জামদানি শাড়ি',
          language: 'bn',
        })
        .expect(200);
      const s = res.body.suggestion;
      // The address is made usable, one alt per photo, empty FAQ entries dropped.
      expect(s.slug).toBe('jamdani-saree-dhakai');
      expect(s.imageAlts).toEqual(['Red Dhakai jamdani saree folded', 'Close up of jamdani weave']);
      expect(s.faq).toHaveLength(2);
      expect(s.keywords[0]).toBe('জামদানি শাড়ি');
      expect(res.body.credits).toBeGreaterThan(0);

      const req = ai.last();
      expect(req.body.output_config?.format?.type).toBe('json_schema');
      expect(req.body.tools).toBeUndefined();
      // The shop's text is fenced as material; the price is the org's money.
      const prompt = JSON.stringify(req.body.messages);
      expect(prompt).toContain('<product>');
      expect(prompt).toContain('4,500');
      const [u] = await usage('seo_product_writer');
      expect(u).toMatchObject({ status: 'settled', tier: 'standard' });
    });

    it('says so when the answer does not fit, and still charges what the model used', async () => {
      ai.then(FakeAnthropic.text('Sure! Here is a title: Jamdani'));
      const res = await O()
        .post(url('/seo/write/product'))
        .send({ name: 'Jamdani Saree', language: 'en' })
        .expect(422);
      expect(res.body.code).toBe('ai_bad_answer');
      const all = await usage('seo_product_writer');
      expect(all.at(-1)).toMatchObject({ status: 'settled' });
    });

    it('needs the SEO studio in the plan and catalog permission', async () => {
      await P()
        .put(`/v1/platform/billing/tenants/${rivalOrgId}/subscription/overrides`)
        .send({ note: 'seo test', removeModules: ['seo'] })
        .expect(200);
      const res = await R()
        .post(url('/seo/write/product', rivalOrgId))
        .send({ name: 'Anything', language: 'en' })
        .expect(402);
      expect(res.body.code).toBe('module_not_in_plan');
      await P()
        .put(`/v1/platform/billing/tenants/${rivalOrgId}/subscription/overrides`)
        .send({ note: 'seo test', removeModules: [] })
        .expect(200);
    });
  });

  describe('product SEO fields and addresses that move', () => {
    let product: ProductDto;

    it('saves search title, meta, keywords and FAQ; the shop page gets them', async () => {
      product = await createProduct({
        name: 'Muslin Panjabi',
        description: 'Soft muslin panjabi for Eid.',
        variants: [{ priceMinor: 250_000, stock: 3, sku: 'MP-01' }],
        seo: {
          title: 'Muslin Panjabi for Eid: soft, light and handmade',
          description:
            'A soft muslin panjabi for Eid, light for hot days. Order with cash on delivery anywhere in Bangladesh.',
          keywords: ['muslin panjabi', 'eid panjabi', 'muslin panjabi'],
          faq: [{ question: 'Is it see-through?', answer: 'No, it is lined.' }],
        },
      });
      expect(product.slug).toBe('muslin-panjabi');
      expect(product.seo.keywords).toEqual(['muslin panjabi', 'eid panjabi']);
      const page = await shop('/products/muslin-panjabi').expect(200);
      expect(page.body.product).toMatchObject({
        seo: { title: 'Muslin Panjabi for Eid: soft, light and handmade' },
        faq: [{ question: 'Is it see-through?', answer: 'No, it is lined.' }],
        sku: 'MP-01',
      });
    });

    it('redirects an old address to the new one when the address changes', async () => {
      const moved = (
        await O()
          .patch(url(`/products/${product.id}`))
          .send({ slug: 'Eid Muslin Panjabi' })
          .expect(200)
      ).body as ProductDto;
      expect(moved.slug).toBe('eid-muslin-panjabi');
      expect(moved.previousSlugs).toEqual(['muslin-panjabi']);
      expect((await shop('/products/muslin-panjabi').expect(200)).body).toEqual({
        movedTo: 'eid-muslin-panjabi',
      });
      // A chosen address stays when the product is renamed.
      const renamed = (
        await O()
          .patch(url(`/products/${product.id}`))
          .send({ name: 'Muslin Panjabi (white)' })
          .expect(200)
      ).body as ProductDto;
      expect(renamed.slug).toBe('eid-muslin-panjabi');
    });

    it('moves an address made from the name along with a rename, keeping the old one', async () => {
      const p = await createProduct({ name: 'Cotton Lungi', variants: [{ priceMinor: 60_000 }] });
      const renamed = (
        await O()
          .patch(url(`/products/${p.id}`))
          .send({ name: 'Batik Lungi' })
          .expect(200)
      ).body as ProductDto;
      expect(renamed.slug).toBe('batik-lungi');
      expect(renamed.previousSlugs).toEqual(['cotton-lungi']);
      // A new product named like the old one takes the address; the redirect gives way.
      const again = await createProduct({
        name: 'Cotton Lungi',
        variants: [{ priceMinor: 50_000 }],
      });
      expect(again.slug).toBe('cotton-lungi');
      const old = (
        await O()
          .get(url(`/products/${p.id}`))
          .expect(200)
      ).body as ProductDto;
      expect(old.previousSlugs).toEqual([]);
      expect((await shop('/products/cotton-lungi').expect(200)).body.product.name).toBe(
        'Cotton Lungi',
      );
    });

    it('clears the SEO fields with null', async () => {
      const cleared = (
        await O()
          .patch(url(`/products/${product.id}`))
          .send({ seo: null })
          .expect(200)
      ).body as ProductDto;
      expect(cleared.seo).toEqual({ title: '', description: '', keywords: [], faq: [] });
    });
  });

  describe('keyword research', () => {
    it('lists AI ideas with monthly searches, charging one lookup', async () => {
      keywords.volumes.set('জামদানি শাড়ি', 2_400);
      keywords.volumes.set('jamdani saree price', 880);
      ai.then(
        FakeAnthropic.json({
          ideas: [
            { keyword: 'jamdani saree price', script: 'english', intent: 'buy' },
            { keyword: 'Jamdani Saree Price', script: 'english', intent: 'buy' },
            { keyword: 'dhakai jamdani kinbo', script: 'banglish', intent: 'buy' },
          ],
        }),
      );
      const setup = (await O().get(url('/seo/keywords/setup')).expect(200)).body;
      expect(setup).toMatchObject({
        volumes: 'ready',
        lookup: { credits: 150, amountMinor: 1500 },
      });
      const r = (
        await O()
          .post(url('/seo/keywords/research'))
          .send({ seed: 'জামদানি শাড়ি', mix: 'all' })
          .expect(201)
      ).body;
      expect(r.volumes).toBe('yes');
      // The seed is an idea too; duplicates are dropped; known volumes first.
      expect(r.ideas.map((i: { keyword: string }) => i.keyword)).toEqual([
        'জামদানি শাড়ি',
        'jamdani saree price',
        'dhakai jamdani kinbo',
      ]);
      expect(r.ideas[0]).toMatchObject({ script: 'bangla', volume: 2400, competition: 'high' });
      expect(r.ideas[0].trend).toHaveLength(12);
      expect(r.ideas[2]).toMatchObject({ volume: null, competition: null, trend: [] });
      expect(keywords.calls).toHaveLength(1);
      expect(keywords.calls[0]!.locationCode).toBe(2050);
      const [lookup] = await usage('seo_keyword_volumes');
      expect(lookup).toMatchObject({ status: 'settled', credits: 150, billedMinor: 1500 });
      // What DataForSEO billed, for the platform's margin: $0.075.
      expect(lookup!.costUsdMicros).toBe(75_000);
    });

    it('does not pay again for volumes the platform already has', async () => {
      ai.then(
        FakeAnthropic.json({
          ideas: [{ keyword: 'jamdani saree price', script: 'english', intent: 'buy' }],
        }),
      );
      const r = (
        await O().post(url('/seo/keywords/research')).send({ seed: 'জামদানি শাড়ি' }).expect(201)
      ).body;
      expect(r.volumes).toBe('yes');
      expect(keywords.calls).toHaveLength(0);
      expect(await usage('seo_keyword_volumes')).toHaveLength(1);
    });

    it('keeps ideas without numbers when the provider fails, and gives the credits back', async () => {
      keywords.failNext = {
        status: 200,
        body: { status_code: 50000, status_message: 'Internal error.' },
      };
      ai.then(
        FakeAnthropic.json({
          ideas: [{ keyword: 'nakshi kantha', script: 'banglish', intent: 'buy' }],
        }),
      );
      const r = (await O().post(url('/seo/keywords/research')).send({ seed: 'kantha' }).expect(201))
        .body;
      expect(r.volumes).toBe('failed');
      expect(r.ideas.every((i: { volume: null }) => i.volume === null)).toBe(true);
      const all = await usage('seo_keyword_volumes');
      expect(all.at(-1)).toMatchObject({ status: 'released' });
    });

    it('says "no volume data" when no price is set for lookups', async () => {
      const rates = (await P().get('/v1/platform/billing/credit-rates').expect(200)).body as {
        currency: string;
        version: number;
        creditPriceMinor: number;
        minimumCreditsPerRequest: number;
        tiers: unknown[];
        usdRate: number;
      }[];
      const bdt = rates
        .filter((r) => r.currency === 'BDT')
        .sort((a, b) => b.version - a.version)[0]!;
      await P()
        .post('/v1/platform/billing/credit-rates')
        .send({
          currency: 'BDT',
          creditPriceMinor: bdt.creditPriceMinor,
          minimumCreditsPerRequest: bdt.minimumCreditsPerRequest,
          tiers: bdt.tiers,
          usdRate: bdt.usdRate,
          note: 'no keyword price',
        })
        .expect(201);
      expect((await O().get(url('/seo/keywords/setup')).expect(200)).body.volumes).toBe(
        'not_priced',
      );
      ai.then(
        FakeAnthropic.json({
          ideas: [{ keyword: 'new idea', script: 'english', intent: 'learn' }],
        }),
      );
      const r = (
        await O().post(url('/seo/keywords/research')).send({ seed: 'brand new' }).expect(201)
      ).body;
      expect(r.volumes).toBe('not_priced');
      expect(keywords.calls).toHaveLength(0);
      // Put the price back for the rest of the tests.
      await P()
        .post('/v1/platform/billing/credit-rates')
        .send({
          currency: 'BDT',
          creditPriceMinor: bdt.creditPriceMinor,
          minimumCreditsPerRequest: bdt.minimumCreditsPerRequest,
          tiers: bdt.tiers,
          usdRate: bdt.usdRate,
          keywordLookupCredits: 150,
        })
        .expect(201);
    });

    it('keeps research to the business that ran it', async () => {
      const mine = (await O().get(url('/seo/keywords/research')).expect(200)).body.items;
      expect(mine.length).toBeGreaterThanOrEqual(3);
      expect(
        (await R().get(url('/seo/keywords/research', rivalOrgId)).expect(200)).body.items,
      ).toEqual([]);
      await R()
        .get(url(`/seo/keywords/research/${mine[0].id}`, rivalOrgId))
        .expect(404);
    });
  });

  describe('keyword lists and gaps', () => {
    let listId: string;

    it('collects keywords and shows which products target them', async () => {
      listId = (await O().post(url('/seo/keyword-lists')).send({ name: 'Eid' }).expect(201)).body
        .id;
      await O().post(url('/seo/keyword-lists')).send({ name: 'Eid' }).expect(409);
      const detail = (
        await O()
          .post(url(`/seo/keyword-lists/${listId}/keywords`))
          .send({
            keywords: [
              { keyword: 'Jamdani Saree', volume: 1000 },
              { keyword: 'jamdani  saree' },
              { keyword: 'eid panjabi' },
              { keyword: 'dhakai jamdani kinbo' },
            ],
          })
          .expect(200)
      ).body;
      expect(detail.count).toBe(3);
      const by = Object.fromEntries(
        detail.keywords.map((k: { keyword: string; targetedBy: { name: string }[] }) => [
          k.keyword,
          k.targetedBy.map((p) => p.name),
        ]),
      );
      expect(by['Jamdani Saree']).toEqual(['Jamdani Saree']);
      expect(by['dhakai jamdani kinbo']).toEqual([]);
      expect(detail.gaps).toBe(2);
    });

    it('looks up volumes for keywords without, from the cache first', async () => {
      keywords.volumes.set('eid panjabi', 5_400);
      const r = (
        await O()
          .post(url(`/seo/keyword-lists/${listId}/volumes`))
          .expect(200)
      ).body;
      expect(r.volumes).toBe('yes');
      // "dhakai jamdani kinbo" was looked up already (no data) and is not paid again.
      expect(keywords.calls).toEqual([expect.objectContaining({ keywords: ['eid panjabi'] })]);
      expect(r.keywords.find((k: { keyword: string }) => k.keyword === 'eid panjabi').volume).toBe(
        5400,
      );
    });

    it('is not visible to another business', async () => {
      await R()
        .get(url(`/seo/keyword-lists/${listId}`, rivalOrgId))
        .expect(404);
      await R()
        .post(url(`/seo/keyword-lists/${listId}/keywords`, rivalOrgId))
        .send({ keywords: [{ keyword: 'x' }] })
        .expect(404);
    });
  });

  describe('SEO audit and the bulk optimiser', () => {
    it('scores every active product and the store', async () => {
      const a = (await O().get(url('/seo/audit')).expect(200)).body;
      expect(a.products.count).toBeGreaterThanOrEqual(4);
      expect(a.products.items[0].score).toBeLessThanOrEqual(a.products.items.at(-1).score);
      expect(a.products.issues.meta_description).toBeGreaterThan(0);
      expect(a.stores[0]).toMatchObject({
        open: true,
        sitemapUrl: `https://${host}/sitemap.xml`,
      });
      const dupes = (await O().get(url('/seo/duplicates?title=jamdani%20saree')).expect(200)).body;
      expect(dupes).toEqual({ sameTitle: 1, sameMeta: 0 });
    });

    it('writes suggestions one by one and applies the chosen fields after review', async () => {
      const jamdani = (
        (await O().get(url('/products?q=jamdani')).expect(200)).body.items as ProductDto[]
      )[0]!;
      const run = (
        await O()
          .post(url('/seo/bulk'))
          .send({ productIds: [jamdani.id], language: 'bn' })
          .expect(201)
      ).body;
      expect(run.status).toBe('queued');
      await O().post(url('/seo/bulk')).send({ language: 'bn' }).expect(409);
      const job = await queue().getJob(`seo-bulk-${run.id}`);
      expect(job?.name).toBe(SEO_JOBS.bulk);
      await job!.remove();

      ai.then(FakeAnthropic.json(suggestion({ imageAlts: [] })));
      await t.app.get(SeoAuditService).processBulk(orgId, run.id);
      const done = (
        await O()
          .get(url(`/seo/bulk/${run.id}`))
          .expect(200)
      ).body;
      expect(done.status).toBe('done');
      expect(done.items[0]).toMatchObject({ status: 'written' });
      expect(done.items[0].scoreAfter).toBeGreaterThan(done.items[0].scoreBefore);
      // Nothing is saved until the business applies it.
      expect(
        (
          (
            await O()
              .get(url(`/products/${jamdani.id}`))
              .expect(200)
          ).body as ProductDto
        ).seo.title,
      ).toBe('');
      await O()
        .post(url(`/seo/bulk/${run.id}/items/${jamdani.id}/apply`))
        .send({ fields: ['title', 'meta', 'keywords', 'faq', 'slug'] })
        .expect(200);
      const after = (
        await O()
          .get(url(`/products/${jamdani.id}`))
          .expect(200)
      ).body as ProductDto;
      expect(after.seo.title).toBe(suggestion().seoTitle);
      expect(after.seo.keywords[0]).toBe('জামদানি শাড়ি');
      expect(after.slug).toBe('jamdani-saree-dhakai');
      expect(after.previousSlugs).toEqual(['jamdani-saree']);
      expect(after.description).toBe(jamdani.description);
      await O()
        .post(url(`/seo/bulk/${run.id}/items/${jamdani.id}/apply`))
        .send({})
        .expect(409);
    });

    it('stops the run when the wallet is empty', async () => {
      const run = (
        await O().post(url('/seo/bulk')).send({ language: 'en', below: 100 }).expect(201)
      ).body;
      await (await queue().getJob(`seo-bulk-${run.id}`))?.remove();
      const holds = await t.db.collection('wallets').findOne({});
      expect(holds).toBeTruthy();
      await t.db.collection('wallets').updateMany({}, { $set: { frozen: false } });
      // Spend the whole balance first (a hold the size of what is available).
      const wallet = (await O().get(url('/billing/wallet')).expect(200)).body as {
        availableMinor: number;
      };
      const { WalletService } = await import('../../src/modules/billing/wallet.service.js');
      await RequestContext.withTenant(orgId, () =>
        t.app.get(WalletService).hold(wallet.availableMinor),
      );
      await t.app.get(SeoAuditService).processBulk(orgId, run.id);
      const done = (
        await O()
          .get(url(`/seo/bulk/${run.id}`))
          .expect(200)
      ).body;
      expect(done.counts.failed).toBe(done.counts.total);
      expect(done.items[0].error).toContain('balance');
      expect(ai.requests).toHaveLength(0);
      await RequestContext.withTenant(orgId, () =>
        t.app.get(WalletService).release(wallet.availableMinor),
      );
    });
  });

  describe('Google Search Console', () => {
    const site = () => `https://${host}/`;

    it('connects with Google, verifies the address with a meta tag and submits the sitemap', async () => {
      const st = (await O().get(url('/seo/search-console')).expect(200)).body;
      expect(st).toMatchObject({ configured: true, connection: null, report: null });
      expect(st.stores).toEqual([{ id: storeId, name: 'Nakshi Ghor', url: site() }]);

      const start = (
        await O().post(url('/seo/search-console/connect')).send({ storeId }).expect(200)
      ).body.url as string;
      const consent = new URL(start);
      expect(consent.origin + consent.pathname).toBe(GOOGLE_TEST.auth);
      expect(consent.searchParams.get('scope')).toBe(SEO_GOOGLE_SCOPES.join(' '));
      expect(consent.searchParams.get('redirect_uri')).toBe(
        'http://api.test/v1/seo/google/callback',
      );
      const code = google.issueCode('owner@gmail.test', SEO_GOOGLE_SCOPES.join(' '));
      const back = await t
        .http()
        .get(
          `/v1/seo/google/callback?code=${code}&state=${encodeURIComponent(consent.searchParams.get('state')!)}`,
        )
        .expect(302);
      expect(back.headers.location).toMatch(
        new RegExp(`/app/${orgId}/seo/search-console\\?google=connected$`),
      );
      // The state works once.
      const replay = await t
        .http()
        .get(
          `/v1/seo/google/callback?code=x&state=${encodeURIComponent(consent.searchParams.get('state')!)}`,
        )
        .expect(302);
      expect(replay.headers.location).toMatch(/google=expired$/);

      const conn = await t.db.collection('seo_google').findOne({});
      expect(conn).toMatchObject({ email: 'owner@gmail.test', siteUrl: site(), step: 'verify' });
      expect(conn!.refreshTokenEnc).not.toContain('rt-');

      // Google "reads" the home page: the storefront's store data must carry the tag.
      google.verifier = async (siteUrl, token) => {
        const s = (await shop('/resolve').expect(200)).body as {
          seo: { googleVerification: string | null };
        };
        return siteUrl === site() && s.seo.googleVerification === token;
      };
      expect(await sc().setup(orgId)).toEqual({ step: 'done' });
      expect(google.sitemaps).toEqual([`${site()} ${site()}sitemap.xml`]);
      const status = (await O().get(url('/seo/search-console')).expect(200)).body.connection;
      expect(status).toMatchObject({ step: 'done', setupError: null });
      expect(status.verifiedAt).toBeTruthy();
      expect((await queue().getJobs(['waiting'])).map((j) => j.name)).toContain(SEO_JOBS.sync);
    });

    it('copies daily numbers and phrases, and finds opportunities', async () => {
      const today = new Date();
      const day = (n: number) => {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - n);
        return d.toISOString().slice(0, 10);
      };
      google.search.set(site(), {
        daily: Array.from({ length: 40 }, (_, i) => ({
          date: day(i + 1),
          clicks: i < 28 ? 10 : 5,
          impressions: 200,
          position: 8,
        })),
        rows: [
          {
            query: 'jamdani saree',
            page: `${site()}products/jamdani-saree-dhakai`,
            clicks: 6,
            impressions: 300,
            position: 7.4,
          },
          { query: 'nakshi ghor', page: site(), clicks: 60, impressions: 120, position: 1.1 },
          {
            query: 'muslin panjabi',
            page: `${site()}products/eid-muslin-panjabi`,
            clicks: 1,
            impressions: 500,
            position: 3,
          },
        ],
      });
      expect(await sc().sync(orgId)).toEqual({ days: 40, rows: 3 });
      const r = (await O().get(url('/seo/search-console?days=28')).expect(200)).body.report;
      expect(r.ready).toBe(true);
      expect(r.totals).toMatchObject({ clicks: 280, impressions: 5600, position: 8 });
      expect(r.previous.clicks).toBe(60);
      expect(r.series).toHaveLength(28);
      expect(r.topQueries[0]).toMatchObject({ key: 'nakshi ghor', clicks: 60 });
      expect(r.opportunities).toEqual([
        expect.objectContaining({
          kind: 'almost_page_one',
          query: 'jamdani saree',
          product: expect.objectContaining({ name: 'Jamdani Saree' }),
        }),
        expect.objectContaining({
          kind: 'low_ctr',
          query: 'muslin panjabi',
          expectedCtr: 0.1,
          product: expect.objectContaining({ name: 'Muslin Panjabi (white)' }),
        }),
      ]);
      // A second sync replaces the phrases rather than adding to them.
      await sc().sync(orgId);
      expect(await t.db.collection('search_console_rows').countDocuments({})).toBe(3);
      // Another business sees none of it.
      expect(
        (await R().get(url('/seo/search-console', rivalOrgId)).expect(200)).body.connection,
      ).toBeNull();
    });

    it('marks the connection when Google access is removed', async () => {
      google.revokeAll();
      expect(await sc().sync(orgId)).toBeNull();
      const conn = (await O().get(url('/seo/search-console')).expect(200)).body.connection;
      expect(conn.status).toBe('revoked');
      await O().post(url('/seo/search-console/retry')).expect(409);
      await O().delete(url('/seo/search-console')).expect(204);
      expect(await t.db.collection('search_console_days').countDocuments({})).toBe(0);
    });

    it('refuses a consent that did not grant Search Console', async () => {
      const start = (
        await O().post(url('/seo/search-console/connect')).send({ storeId }).expect(200)
      ).body.url as string;
      const state = new URL(start).searchParams.get('state')!;
      const code = google.issueCode('owner@gmail.test', `openid email ${WEBMASTERS_SCOPE}`);
      const back = await t
        .http()
        .get(`/v1/seo/google/callback?code=${code}&state=${encodeURIComponent(state)}`)
        .expect(302);
      expect(back.headers.location).toMatch(/google=no_permission$/);
      expect(await t.db.collection('seo_google').countDocuments({})).toBe(0);
    });
  });

  describe('content studio', () => {
    it('writes ad copy versions and keeps them as a draft', async () => {
      ai.then(
        FakeAnthropic.json({
          variants: [
            {
              headline: 'Eid er jamdani',
              text: 'Haate bona jamdani.\nInbox korun.',
              hashtags: ['#x'],
            },
            { headline: 'Dhakai jamdani', text: 'Notun collection.', hashtags: [] },
          ],
        }),
      );
      const d = (
        await O()
          .post(url('/seo/content'))
          .send({
            kind: 'facebook_ad',
            source: 'Handwoven Dhakai jamdani saree, 4500 taka.',
            productName: 'Jamdani Saree',
            language: 'en',
            tone: 'urgent',
            variants: 2,
          })
          .expect(201)
      ).body;
      expect(d.variants).toHaveLength(2);
      expect(d.variants[0].hashtags).toEqual(['#x']);
      expect(JSON.stringify(ai.last().body.system)).toContain('energetic');
      const list = (await O().get(url('/seo/content')).expect(200)).body.items;
      expect(list[0].id).toBe(d.id);
      await R()
        .delete(url(`/seo/content/${d.id}`, rivalOrgId))
        .expect(404);
      await O()
        .delete(url(`/seo/content/${d.id}`))
        .expect(204);
    });
  });
});
