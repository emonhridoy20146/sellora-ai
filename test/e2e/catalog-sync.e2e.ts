import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogSyncRunner } from '../../src/modules/catalog-sync/catalog-sync.runner.js';
import { FakeAnthropic } from '../helpers/fake-anthropic.js';
import {
  FakeShops,
  SHOPIFY_TOKEN,
  WOO_KEY,
  WOO_SECRET,
  type FakeShopifyProduct,
  type FakeWooProduct,
} from '../helpers/fake-shops.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface SourceDto {
  id: string;
  kind: string;
  name: string;
  status: string;
  url: string | null;
  title: string | null;
  credentialsHint: string | null;
  intervalMinutes: number;
  nextSyncAt: string | null;
  running: boolean;
  lastRun: { id: string; status: string; counts: Counts; error: string | null } | null;
  failures: number;
  productCount: number;
}

interface Counts {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  restored: number;
  failed: number;
}

interface RunDto {
  id: string;
  status: string;
  trigger: string;
  counts: Counts;
  problems: { ref: string; message: string }[];
  error: string | null;
}

interface ProductDto {
  id: string;
  name: string;
  description: string;
  status: string;
  categoryId: string | null;
  tags: string[];
  images: { url: string; fileId: string | null }[];
  options: { name: string; values: string[] }[];
  variants: {
    id: string;
    title: string;
    sku: string | null;
    priceMinor: number;
    compareAtPriceMinor: number | null;
    trackStock: boolean;
    stock: number;
  }[];
  sync: { sourceId: string; archivedBySync: boolean } | null;
}

const shopifyProducts = (shops: FakeShops): FakeShopifyProduct[] => [
  {
    id: 'gid://shopify/Product/1001',
    title: 'Jamdani Saree',
    descriptionHtml:
      '<p>Hand-woven <b>Dhakai</b> jamdani.</p><ul><li>6 yards</li><li>Cotton</li></ul>',
    status: 'ACTIVE',
    productType: 'Sarees',
    tags: ['saree', 'jamdani'],
    options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
    images: [shops.photo('saree-1'), shops.photo('saree-2')],
    variants: [
      {
        id: 'gid://shopify/ProductVariant/1',
        sku: 'JAM-RED',
        price: '3200.00',
        compareAtPrice: '3800.00',
        inventoryQuantity: 7,
        tracked: true,
        options: { Colour: 'Red' },
      },
      {
        id: 'gid://shopify/ProductVariant/2',
        sku: 'JAM-BLUE',
        price: '3200.00',
        inventoryQuantity: 2,
        tracked: true,
        options: { Colour: 'Blue' },
      },
    ],
  },
  {
    id: 'gid://shopify/Product/1002',
    title: 'Nakshi Kantha Cushion',
    descriptionHtml: 'Embroidered cushion cover.',
    status: 'ACTIVE',
    productType: '',
    tags: [],
    options: [{ name: 'Title', values: ['Default Title'] }],
    images: [shops.photo('cushion')],
    variants: [
      {
        id: 'gid://shopify/ProductVariant/3',
        sku: 'KAN-CUSH',
        price: '850.00',
        inventoryQuantity: null,
        tracked: false,
        options: { Title: 'Default Title' },
      },
    ],
  },
  {
    id: 'gid://shopify/Product/1003',
    title: 'Winter Shawl (draft)',
    descriptionHtml: '',
    status: 'DRAFT',
    productType: '',
    tags: [],
    options: [{ name: 'Title', values: ['Default Title'] }],
    images: [],
    variants: [
      {
        id: 'gid://shopify/ProductVariant/4',
        sku: null,
        price: '1500.00',
        inventoryQuantity: 3,
        tracked: true,
        options: { Title: 'Default Title' },
      },
    ],
  },
];

const wooProducts = (shops: FakeShops): FakeWooProduct[] => [
  {
    id: 11,
    name: 'Clay Pot',
    type: 'simple',
    status: 'publish',
    description: '<p>Hand-made pot from Bogura.</p>',
    sku: 'POT-1',
    price: '450',
    regular_price: '500',
    sale_price: '450',
    manage_stock: true,
    stock_quantity: 12,
    stock_status: 'instock',
    categories: [{ name: 'Home' }],
    images: [shops.photo('pot')],
    attributes: [],
    variations: [],
  },
  {
    id: 12,
    name: 'Panjabi',
    type: 'variable',
    status: 'publish',
    description: 'Cotton panjabi.',
    sku: '',
    price: '1800',
    regular_price: '',
    sale_price: '',
    manage_stock: true,
    stock_quantity: 9,
    stock_status: 'instock',
    categories: [{ name: 'Uncategorized' }],
    images: [],
    attributes: [{ name: 'Size', options: ['M', 'L', 'XL'], variation: true }],
    variations: [
      {
        id: 121,
        sku: 'PJ-M',
        price: '1800',
        regular_price: '1800',
        sale_price: '',
        manage_stock: true,
        stock_quantity: 4,
        stock_status: 'instock',
        attributes: [{ name: 'Size', option: 'M' }],
      },
      {
        id: 122,
        sku: 'PJ-L',
        price: '1900',
        regular_price: '1900',
        sale_price: '',
        manage_stock: 'parent',
        stock_quantity: null,
        stock_status: 'instock',
        attributes: [{ name: 'Size', option: 'L' }],
      },
      {
        id: 123,
        sku: 'PJ-XL',
        price: '1900',
        regular_price: '1900',
        sale_price: '',
        manage_stock: false,
        stock_quantity: null,
        stock_status: 'outofstock',
        attributes: [{ name: 'Size', option: 'XL' }],
      },
    ],
  },
  {
    id: 13,
    name: 'Affiliate Book',
    type: 'external',
    status: 'publish',
    description: '',
    sku: '',
    price: '300',
    regular_price: '300',
    sale_price: '',
    manage_stock: false,
    stock_quantity: null,
    stock_status: 'instock',
    categories: [],
    images: [],
    attributes: [],
    variations: [],
  },
];

describe('Catalog sync: Shopify, WooCommerce, sheets and CSV into products (ADR 0023)', () => {
  const shops = new FakeShops();
  const ai = new FakeAnthropic();
  let t: TestApp;
  let owner: Session;
  let sales: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;

  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const O = () => t.as(owner.token);
  const runner = () => t.app.get(CatalogSyncRunner);
  const run = async (runId: string) => {
    await runner().run(orgId, runId);
    return (
      await O()
        .get(url(`/catalog-sources/${sourceOf.get(runId)}/runs/${runId}`))
        .expect(200)
    ).body as RunDto;
  };
  const sourceOf = new Map<string, string>();
  const syncNow = async (sourceId: string) => {
    const r = (
      await O()
        .post(url(`/catalog-sources/${sourceId}/sync`))
        .expect(202)
    ).body as RunDto;
    sourceOf.set(r.id, sourceId);
    return run(r.id);
  };
  const products = async (query = '?status=all') =>
    (
      await O()
        .get(url(`/products${query}&limit=100`))
        .expect(200)
    ).body.items as ProductDto[];
  const byName = async (name: string) => {
    const p = (await products()).find((x) => x.name === name);
    if (!p) throw new Error(`No product ${name}`);
    return p;
  };
  const addSource = async (body: Record<string, unknown>) => {
    const res = await O().post(url('/catalog-sources')).send(body).expect(201);
    const { source, runId } = res.body as { source: SourceDto; runId: string };
    sourceOf.set(runId, source.id);
    return { source, runId };
  };
  const shopifySource = () => ({
    kind: 'shopify',
    url: `${shops.base}/shopify`,
    credentials: { accessToken: SHOPIFY_TOKEN },
  });

  beforeAll(async () => {
    await shops.start();
    t = await TestApp.create(
      { SYNC_ALLOW_PRIVATE_NETWORK: 'true', AI_ANTHROPIC_API_KEY: 'sk-ant-test-key' },
      { aiFetch: ai.fetch },
    );
    owner = await t.registerUser({ name: 'Owner Rahman' });
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor' })).id;
    sales = await t.addMember(owner, orgId, 'sales_agent');
    rival = await t.registerUser({ name: 'Rival Owner' });
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Bazar' })).id;
    await Promise.all(
      ['Product', 'CatalogSource', 'CatalogSyncRun'].map((m) => t.db.model(m).init()),
    );
  });

  afterAll(async () => {
    await t?.close();
    await shops.stop();
  });

  beforeEach(() => {
    shops.shopify.products = shopifyProducts(shops);
    shops.shopify.throttle = 0;
    shops.shopify.failWith = null;
    ai.reset();
  });

  describe('Shopify', () => {
    let sourceId: string;

    it('checks the shop before saving: a wrong token is refused, the right one shows a sample', async () => {
      const wrong = await O()
        .post(url('/catalog-sources/check'))
        .send({
          ...shopifySource(),
          credentials: { accessToken: 'shpat_wrongwrongwrongwrongwrong' },
        })
        .expect(422);
      expect(wrong.body.code).toBe('source_auth');
      expect(wrong.body.detail).toMatch(/refused the key/);

      const ok = await O().post(url('/catalog-sources/check')).send(shopifySource()).expect(200);
      expect(ok.body).toMatchObject({
        title: 'Nakshi Shopify',
        currency: 'BDT',
        currencyOk: true,
        productCount: 3,
      });
      expect(ok.body.sample.map((p: { name: string }) => p.name)).toEqual([
        'Jamdani Saree',
        'Nakshi Kantha Cushion',
        'Winter Shawl (draft)',
      ]);
      // Nothing was saved by a check.
      expect((await O().get(url('/catalog-sources')).expect(200)).body.items).toEqual([]);
    });

    it('refuses a shop in another currency (prices are not converted)', async () => {
      shops.shopify.currency = 'USD';
      try {
        const res = await O()
          .post(url('/catalog-sources'))
          .send({ source: shopifySource() })
          .expect(422);
        expect(res.body.code).toBe('source_currency');
      } finally {
        shops.shopify.currency = 'BDT';
      }
    });

    it('imports products, variants, stock, categories and photos; drafts are not imported', async () => {
      const { source, runId } = await addSource({ source: shopifySource(), intervalMinutes: 60 });
      sourceId = source.id;
      expect(source).toMatchObject({
        kind: 'shopify',
        name: 'Nakshi Shopify',
        credentialsHint: '…0001',
        intervalMinutes: 60,
      });
      // The token is stored encrypted and never sent back.
      const raw = await t.db.collection('catalog_sources').findOne({});
      expect(raw!.credentialsEnc).toBeTruthy();
      expect(JSON.stringify(raw)).not.toContain(SHOPIFY_TOKEN);
      expect(JSON.stringify(source)).not.toContain(SHOPIFY_TOKEN);

      const result = await run(runId);
      expect(result).toMatchObject({
        status: 'succeeded',
        trigger: 'first',
        counts: { seen: 3, created: 2, unchanged: 1, failed: 0 },
      });

      const saree = await byName('Jamdani Saree');
      expect(saree).toMatchObject({
        status: 'active',
        description: 'Hand-woven Dhakai jamdani.\n\n• 6 yards\n• Cotton',
        tags: ['saree', 'jamdani'],
        options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
        sync: { sourceId, archivedBySync: false },
      });
      expect(saree.variants).toMatchObject([
        {
          title: 'Red',
          sku: 'JAM-RED',
          priceMinor: 320_000,
          compareAtPriceMinor: 380_000,
          trackStock: true,
          stock: 7,
        },
        {
          title: 'Blue',
          sku: 'JAM-BLUE',
          priceMinor: 320_000,
          compareAtPriceMinor: null,
          stock: 2,
        },
      ]);
      expect(saree.categoryId).toBeTruthy();
      const categories = (await O().get(url('/categories')).expect(200)).body as { name: string }[];
      expect(categories.map((c) => c.name)).toContain('Sarees');
      // Photos are copied into the business's storage, not linked to Shopify.
      expect(saree.images).toHaveLength(2);
      for (const img of saree.images) {
        expect(img.fileId).toBeTruthy();
        expect(img.url).not.toContain(shops.base);
      }
      const cushion = await byName('Nakshi Kantha Cushion');
      expect(cushion.options).toEqual([]);
      expect(cushion.variants).toMatchObject([
        { title: 'Default', priceMinor: 85_000, trackStock: false },
      ]);
      expect((await products()).some((p) => p.name.startsWith('Winter Shawl'))).toBe(false);

      const list = (await O().get(url('/catalog-sources')).expect(200)).body.items as SourceDto[];
      expect(list[0]).toMatchObject({
        productCount: 2,
        failures: 0,
        lastRun: { status: 'succeeded' },
      });
      expect(new Date(list[0]!.nextSyncAt!).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    });

    it('a sync with nothing changed writes nothing and fetches no photo again', async () => {
      const hits = shops.photoHits.get('/img/saree-1.png');
      const before = await byName('Jamdani Saree');
      const result = await syncNow(sourceId);
      expect(result.counts).toMatchObject({ seen: 3, created: 0, updated: 0, unchanged: 3 });
      expect(shops.photoHits.get('/img/saree-1.png')).toBe(hits);
      expect((await byName('Jamdani Saree')).images).toEqual(before.images);
    });

    it('a change at the source updates the product, keeps variant ids and moves stock through the ledger', async () => {
      const before = await byName('Jamdani Saree');
      const p = shops.shopify.products[0]!;
      p.variants[0]!.price = '2950.00';
      p.variants[0]!.inventoryQuantity = 4;
      p.options[0]!.values.push('Green');
      p.variants.push({
        id: 'gid://shopify/ProductVariant/9',
        sku: 'JAM-GREEN',
        price: '3400.00',
        inventoryQuantity: 5,
        tracked: true,
        options: { Colour: 'Green' },
      });
      p.images = [shops.photo('saree-2'), shops.photo('saree-3')];
      const hits1 = shops.photoHits.get('/img/saree-1.png');
      const result = await syncNow(sourceId);
      expect(result.counts).toMatchObject({ updated: 1, unchanged: 2, failed: 0 });

      const after = await byName('Jamdani Saree');
      expect(after.variants.map((v) => v.id).slice(0, 2)).toEqual(before.variants.map((v) => v.id));
      expect(after.variants).toMatchObject([
        { sku: 'JAM-RED', priceMinor: 295_000, stock: 4 },
        { sku: 'JAM-BLUE', stock: 2 },
        { sku: 'JAM-GREEN', priceMinor: 340_000, stock: 5 },
      ]);
      // saree-2 was kept (same address), saree-3 fetched, saree-1 dropped and not fetched.
      expect(after.images[0]!.fileId).toBe(before.images[1]!.fileId);
      expect(after.images).toHaveLength(2);
      expect(shops.photoHits.get('/img/saree-1.png')).toBe(hits1);
      const history = (
        await O()
          .get(url(`/stock-movements?productId=${after.id}`))
          .expect(200)
      ).body.items as { reason: string; delta: number; note: string | null }[];
      expect(history).toContainEqual(
        expect.objectContaining({ reason: 'sync', delta: -3, note: 'Synced from Shopify' }),
      );
    });

    it('the AI sales agent quotes the new price straight after the sync (the exit test)', async () => {
      ai.then(FakeAnthropic.text('Red jamdani ৳2,950.'));
      await O()
        .post(url('/ai-agent/preview'))
        .send({ messages: [{ from: 'customer', text: 'Jamdani saree dam koto?' }] })
        .expect(200);
      const system = JSON.stringify(ai.requests[0]!.body.system);
      expect(system).toContain('Jamdani Saree');
      expect(system).toContain('৳2,950');
      expect(system).toContain('Nakshi Kantha Cushion');
    });

    it('a product gone from the source is archived, and comes back when it returns', async () => {
      shops.shopify.products = shops.shopify.products.filter(
        (p) => p.id !== 'gid://shopify/Product/1002',
      );
      let result = await syncNow(sourceId);
      expect(result.counts.archived).toBe(1);
      expect(await byName('Nakshi Kantha Cushion')).toMatchObject({
        status: 'archived',
        sync: { archivedBySync: true },
      });

      shops.shopify.products = shopifyProducts(shops);
      result = await syncNow(sourceId);
      expect(result.counts.restored).toBe(1);
      expect((await byName('Nakshi Kantha Cushion')).status).toBe('active');
    });

    it('a product the merchant archived stays archived', async () => {
      const cushion = await byName('Nakshi Kantha Cushion');
      await O()
        .patch(url(`/products/${cushion.id}`))
        .send({ status: 'archived' })
        .expect(200);
      shops.shopify.products[1]!.variants[0]!.price = '900.00';
      const result = await syncNow(sourceId);
      expect(result.counts.updated).toBeGreaterThanOrEqual(1);
      expect(await byName('Nakshi Kantha Cushion')).toMatchObject({
        status: 'archived',
        variants: [{ priceMinor: 90_000 }],
      });
      await O()
        .patch(url(`/products/${cushion.id}`))
        .send({ status: 'active' })
        .expect(200);
    });

    it('an empty answer from a shop that had products archives nothing and fails the run', async () => {
      shops.shopify.products = [];
      const result = await syncNow(sourceId);
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/answered with no products.*nothing was archived/);
      expect((await products('?status=active')).length).toBeGreaterThanOrEqual(2);
      const source = (
        await O()
          .get(url(`/catalog-sources/${sourceId}`))
          .expect(200)
      ).body as SourceDto;
      expect(source).toMatchObject({ failures: 1, lastRun: { status: 'failed' } });
    });

    it('waits out Shopify throttling; an outage fails the run and the next try waits longer', async () => {
      shops.shopify.throttle = 1;
      let result = await syncNow(sourceId);
      expect(result.status).toBe('succeeded');

      shops.shopify.failWith = 500;
      const startedAt = Date.now();
      result = await syncNow(sourceId);
      expect(result).toMatchObject({
        status: 'failed',
        error: 'Shopify had a problem (HTTP 500).',
      });
      await syncNow(sourceId);
      const source = (
        await O()
          .get(url(`/catalog-sources/${sourceId}`))
          .expect(200)
      ).body as SourceDto;
      expect(source.failures).toBe(2);
      // Two failures in a row: the next try waits two intervals.
      expect(new Date(source.nextSyncAt!).getTime()).toBeGreaterThan(startedAt + 115 * 60_000);
      shops.shopify.failWith = null;
      result = await syncNow(sourceId);
      expect(result.status).toBe('succeeded');
      expect(
        (
          (
            await O()
              .get(url(`/catalog-sources/${sourceId}`))
              .expect(200)
          ).body as SourceDto
        ).failures,
      ).toBe(0);
    });

    it('a second "Sync now" while one is queued is refused', async () => {
      await O()
        .post(url(`/catalog-sources/${sourceId}/sync`))
        .expect(202);
      const again = await O()
        .post(url(`/catalog-sources/${sourceId}/sync`))
        .expect(409);
      expect(again.body.code).toBe('sync_queued');
      const runs = (
        await O()
          .get(url(`/catalog-sources/${sourceId}/runs`))
          .expect(200)
      ).body.items as RunDto[];
      const queued = runs.find((r) => r.status === 'queued')!;
      sourceOf.set(queued.id, sourceId);
      await run(queued.id);
    });

    it('the sweep queues due sources once and skips paused ones', async () => {
      await t.db
        .collection('catalog_sources')
        .updateOne({}, { $set: { nextSyncAt: new Date(Date.now() - 1000) } });
      expect((await runner().sweep()).queued).toBe(1);
      expect((await runner().sweep()).queued).toBe(0);
      const runs = (
        await O()
          .get(url(`/catalog-sources/${sourceId}/runs`))
          .expect(200)
      ).body.items as RunDto[];
      const scheduled = runs.find((r) => r.trigger === 'schedule' && r.status === 'queued')!;
      expect(scheduled).toBeTruthy();
      sourceOf.set(scheduled.id, sourceId);
      expect((await run(scheduled.id)).status).toBe('succeeded');

      await O()
        .patch(url(`/catalog-sources/${sourceId}`))
        .send({ status: 'paused' })
        .expect(200);
      await t.db
        .collection('catalog_sources')
        .updateOne({}, { $set: { nextSyncAt: new Date(Date.now() - 1000) } });
      expect((await runner().sweep()).queued).toBe(0);
      const paused = (
        await O()
          .get(url(`/catalog-sources/${sourceId}`))
          .expect(200)
      ).body as SourceDto;
      expect(paused).toMatchObject({ status: 'paused', nextSyncAt: null });
      await O()
        .patch(url(`/catalog-sources/${sourceId}`))
        .send({ status: 'active' })
        .expect(200);
    });

    it('another business cannot see, change or sync the source; staff without catalog.manage cannot add one', async () => {
      await t
        .as(rival.token)
        .get(url(`/catalog-sources/${sourceId}`, rivalOrgId))
        .expect(404);
      await t
        .as(rival.token)
        .post(url(`/catalog-sources/${sourceId}/sync`, rivalOrgId))
        .expect(404);
      await t.as(rival.token).get(url('/catalog-sources')).expect(404);
      expect(
        (await t.as(rival.token).get(url('/catalog-sources', rivalOrgId)).expect(200)).body.items,
      ).toEqual([]);
      expect(
        (
          (await t.as(rival.token).get(url('/products?status=all', rivalOrgId)).expect(200)).body
            .items as unknown[]
        ).length,
      ).toBe(0);

      await t.as(sales.token).get(url('/catalog-sources')).expect(200);
      await t
        .as(sales.token)
        .post(url('/catalog-sources'))
        .send({ source: shopifySource() })
        .expect(403);
      await t
        .as(sales.token)
        .post(url(`/catalog-sources/${sourceId}/sync`))
        .expect(403);
    });

    it('removing the source keeps its products as ordinary products', async () => {
      const res = await O()
        .delete(url(`/catalog-sources/${sourceId}`))
        .expect(200);
      expect(res.body.products).toBeGreaterThanOrEqual(2);
      const saree = await byName('Jamdani Saree');
      expect(saree).toMatchObject({ status: 'active', sync: null });
      expect(await t.db.collection('catalog_sync_runs').countDocuments({})).toBe(0);
    });
  });

  describe('WooCommerce', () => {
    it('imports simple and variable products with sale prices and stock; external products are skipped', async () => {
      shops.woo.products = wooProducts(shops);
      const bad = await O()
        .post(url('/catalog-sources/check'))
        .send({
          kind: 'woocommerce',
          url: `${shops.base}/woo`,
          credentials: {
            consumerKey: WOO_KEY,
            consumerSecret: 'cs_1111111111111111111111111111111111111111',
          },
        })
        .expect(422);
      expect(bad.body.code).toBe('source_auth');

      const { source, runId } = await addSource({
        source: {
          kind: 'woocommerce',
          url: `${shops.base}/woo/wp-admin/`,
          credentials: { consumerKey: WOO_KEY, consumerSecret: WOO_SECRET },
        },
        newProductStatus: 'draft',
      });
      expect(source).toMatchObject({ name: 'Nakshi Woo', url: `${shops.base}/woo` });
      const result = await run(runId);
      // The external product is left out, so the run ends "partial" and says why.
      expect(result).toMatchObject({
        status: 'partial',
        counts: { seen: 2, created: 2, failed: 1 },
      });
      expect(result.problems).toContainEqual({
        ref: 'Affiliate Book',
        message: 'External products are not imported.',
      });
      const pot = await byName('Clay Pot');
      expect(pot).toMatchObject({
        status: 'draft',
        description: 'Hand-made pot from Bogura.',
        variants: [
          {
            sku: 'POT-1',
            priceMinor: 45_000,
            compareAtPriceMinor: 50_000,
            trackStock: true,
            stock: 12,
          },
        ],
      });
      const panjabi = await byName('Panjabi');
      expect(panjabi.categoryId).toBeNull();
      expect(panjabi.options).toEqual([{ name: 'Size', values: ['M', 'L', 'XL'] }]);
      expect(panjabi.variants).toMatchObject([
        { sku: 'PJ-M', priceMinor: 180_000, trackStock: true, stock: 4 },
        { sku: 'PJ-L', priceMinor: 190_000, trackStock: true, stock: 9 },
        { sku: 'PJ-XL', trackStock: true, stock: 0 },
      ]);
    });
  });

  describe('Google Sheets and CSV', () => {
    const sheet = [
      'Handle,Name,Price,Old price,SKU,Stock,Size,Category,Image',
      'punjabi-1,Eid Panjabi,"৳2,450",2900,EP-M,5,M,Panjabi,' + '{photo}',
      'punjabi-1,,"2,450",,EP-L,3,L,,',
      'punjabi-1,,২৫৫০,,EP-XL,০,XL,,',
      ',Lungi,abc,,LG-1,10,,,',
      ',Gamchha,120 টাকা,,GM-1,in stock,,Home,',
    ].join('\n');

    it('explains a sheet that is not shared', async () => {
      const res = await O()
        .post(url('/catalog-sources/check'))
        .send({ kind: 'sheet', url: `${shops.base}/private-sheet` })
        .expect(422);
      expect(res.body.code).toBe('source_auth');
      expect(res.body.detail).toMatch(/Anyone with the link/);
    });

    it('matches columns, groups rows into variants, reads Bangla prices and reports bad rows', async () => {
      shops.sheet = sheet.replace('{photo}', shops.photo('panjabi'));
      const check = await O()
        .post(url('/catalog-sources/check'))
        .send({ kind: 'sheet', url: `${shops.base}/sheet.csv` })
        .expect(200);
      expect(check.body.title).toBe('Catalog - Sheet1');
      expect(check.body.columns).toEqual(
        expect.arrayContaining([
          { field: 'handle', header: 'Handle' },
          { field: 'price', header: 'Price' },
          { field: 'compareAt', header: 'Old price' },
          { field: 'option', header: 'Size' },
        ]),
      );
      expect(check.body.problems).toContainEqual({
        ref: 'Row 5 (Lungi)',
        message: 'The price "abc" is not a number.',
      });

      const { runId } = await addSource({
        source: { kind: 'sheet', url: `${shops.base}/sheet.csv` },
        intervalMinutes: 15,
      });
      const result = await run(runId);
      // The Lungi row's price is not a number: skipped, so the run ends "partial".
      expect(result).toMatchObject({ status: 'partial', counts: { created: 2, failed: 1 } });
      const panjabi = await byName('Eid Panjabi');
      expect(panjabi.options).toEqual([{ name: 'Size', values: ['M', 'L', 'XL'] }]);
      expect(panjabi.variants).toMatchObject([
        { sku: 'EP-M', priceMinor: 245_000, compareAtPriceMinor: 290_000, stock: 5 },
        { sku: 'EP-L', priceMinor: 245_000, stock: 3 },
        { sku: 'EP-XL', priceMinor: 255_000, stock: 0 },
      ]);
      expect(panjabi.images).toHaveLength(1);
      expect(await byName('Gamchha')).toMatchObject({
        variants: [{ priceMinor: 12_000, trackStock: false }],
      });
    });

    it('a CSV upload creates a source; a new version updates the same products and archives the rest', async () => {
      const v1 = 'Name,Price,SKU\nBamboo Basket,650,BB-1\nJute Bag,300,JB-1\n';
      const { source, runId } = await addSource({
        source: { kind: 'csv', filename: 'catalog.csv', csv: v1 },
      });
      expect(source).toMatchObject({
        kind: 'csv',
        name: 'catalog.csv',
        intervalMinutes: 0,
        nextSyncAt: null,
      });
      expect((await run(runId)).counts.created).toBe(2);
      await O()
        .post(url(`/catalog-sources/${source.id}/sync`))
        .expect(422);

      const v2 = 'Name,Price,SKU\nBamboo Basket,700,BB-1\n';
      const upload = (
        await O()
          .post(url(`/catalog-sources/${source.id}/upload`))
          .send({ filename: 'catalog-v2.csv', csv: v2 })
          .expect(202)
      ).body as RunDto;
      sourceOf.set(upload.id, source.id);
      const result = await run(upload.id);
      expect(result.counts).toMatchObject({ updated: 1, archived: 1 });
      expect((await byName('Bamboo Basket')).variants[0]!.priceMinor).toBe(70_000);
      expect((await byName('Jute Bag')).status).toBe('archived');
      // The file is not kept once it has been read.
      expect(
        await t.db.collection('catalog_sync_runs').countDocuments({ csv: { $exists: true } }),
      ).toBe(0);
    });

    it('an SKU the business already uses on its own product is reported and skipped', async () => {
      await O()
        .post(url('/products'))
        .send({
          name: 'Own Mat',
          description: '',
          categoryId: null,
          tags: [],
          status: 'active',
          images: [],
          options: [],
          variants: [{ optionValues: [], sku: 'MAT-1', priceMinor: 10_000, trackStock: false }],
        })
        .expect(201);
      const { runId } = await addSource({
        source: {
          kind: 'csv',
          filename: 'mats.csv',
          csv: 'Name,Price,SKU\nSynced Mat,200,MAT-1\nOther Mat,250,MAT-2\n',
        },
      });
      const result = await run(runId);
      expect(result).toMatchObject({ status: 'partial', counts: { created: 1, failed: 1 } });
      expect(result.problems).toContainEqual({
        ref: 'Synced Mat',
        message: 'SKU MAT-1 is already used by Own Mat.',
      });
    });
  });
});
