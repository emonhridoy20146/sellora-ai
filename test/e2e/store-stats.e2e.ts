import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ProductDto {
  id: string;
  slug: string;
  variants: { id: string; priceMinor: number }[];
}

interface Summary {
  days: { day: string; visitors: number; orders: number; revenueMinor: number }[];
  total: {
    visitors: number;
    productViewers: number;
    cartVisitors: number;
    checkoutVisitors: number;
    orders: number;
    revenueMinor: number;
  };
  previous: { visitors: number; orders: number };
  conversionRate: number | null;
  funnel: { step: string; shoppers: number }[];
  sources: { source: string; visitors: number; orders: number }[];
  products: {
    productId: string;
    name: string | null;
    viewers: number;
    orders: number;
    units: number;
    revenueMinor: number;
  }[];
  currency: string;
}

describe('store visits and sales (ADR 0027)', () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let orgId: string;
  let otherOrgId: string;
  let platform: string;
  let key: string;
  let storeId: string;
  let panjabi: ProductDto;
  let saree: ProductDto;
  const host = 'nakshi-ghor.shops.test';

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;

  const shop = (path: string, ip = '203.0.113.7', preview?: string) => {
    const req = t
      .http()
      .post(`/v1/storefront${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', ip);
    return preview ? req.set('x-store-preview', preview) : req;
  };
  const event = (body: Record<string, unknown>, ip?: string) => shop('/events', ip).send(body);
  const summary = async (days = 7) =>
    (
      await O()
        .get(url(`/stores/${storeId}/stats?days=${days}`))
        .expect(200)
    ).body as Summary;

  const createProduct = async (body: Record<string, unknown>) =>
    (await O().post(url('/products')).send(body).expect(201)).body as ProductDto;

  beforeAll(async () => {
    t = await TestApp.create({ API_PUBLIC_URL: 'http://api.test' });
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor', category: 'fashion' })).id;
    other = await t.registerUser({ name: 'Someone else' });
    otherOrgId = (await t.createOrg(other, { name: 'Other Shop', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Store', 'Product', 'Customer', 'Order', 'StoreStat', 'StoreProductStat'].map((m) =>
        t.db.model(m).init(),
      ),
    );

    panjabi = await createProduct({
      name: 'Cotton Panjabi',
      variants: [{ priceMinor: 120_000, stock: 20 }],
    });
    saree = await createProduct({
      name: 'Silk Saree',
      variants: [{ priceMinor: 300_000, stock: 5 }],
    });
    await O()
      .patch(url('/shop-settings'))
      .send({
        deliveryZones: [{ id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 }],
        defaultZoneId: 'dhaka',
      })
      .expect(200);
    storeId = (
      (await O().post(url('/stores')).send({ name: 'Nakshi Ghor' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await O()
      .patch(url(`/stores/${storeId}`))
      .send({ contact: { phone: '01712345678' } })
      .expect(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('counts nothing before the store opens, nor in a preview', async () => {
    await event({ type: 'visit', visitorId: 'visitor-0000-pre' }).expect(404);
    await O()
      .post(url(`/stores/${storeId}/submit`))
      .expect(200);
    const preview = (await t.as(platform).get(`/v1/platform/stores/${storeId}`).expect(200)).body
      .preview.url as string;
    const token = new URL(preview).searchParams.get('token')!;
    // The reviewer's preview shows the shop but never counts as a shopper.
    await shop('/events', '203.0.113.7', token)
      .send({ type: 'visit', visitorId: 'visitor-0000-pre' })
      .expect(404);
    await t.as(platform).post(`/v1/platform/stores/${storeId}/approve`).send({}).expect(200);
    expect((await summary()).total.visitors).toBe(0);
  });

  it('counts each shopper once per step and day, with where they came from', async () => {
    const a = 'visitor-aaaa-0001';
    const b = 'visitor-bbbb-0002';
    expect(
      (
        await event({
          type: 'visit',
          visitorId: a,
          attribution: { utmSource: 'facebook', utmCampaign: 'eid' },
        }).expect(200)
      ).body.counted,
    ).toBe(true);
    expect((await event({ type: 'visit', visitorId: a }).expect(200)).body.counted).toBe(false);
    expect(
      (
        await event({
          type: 'visit',
          visitorId: b,
          attribution: { referrer: 'l.instagram.com' },
        }).expect(200)
      ).body.counted,
    ).toBe(true);
    // Without a browser id the shopper's address stands in.
    expect((await event({ type: 'visit' }, '198.51.100.9').expect(200)).body.counted).toBe(true);

    // Product views: per product and shopper; the store's step counts the shopper once.
    for (const [who, p] of [
      [a, panjabi],
      [a, panjabi],
      [a, saree],
      [b, panjabi],
    ] as const)
      await event({ type: 'product_view', visitorId: who, productId: p.id }).expect(200);
    expect(
      (
        await event({
          type: 'product_view',
          visitorId: a,
          productId: '0123456789abcdef01234567',
        }).expect(200)
      ).body.counted,
    ).toBe(false);
    await event({ type: 'cart_add', visitorId: a }).expect(200);
    await event({ type: 'cart_add', visitorId: a }).expect(200);
    await event({ type: 'checkout', visitorId: a }).expect(200);

    // Bad input is refused, not counted.
    await event({ type: 'visit', visitorId: '<script>' }).expect(422);
    await event({ type: 'teleport', visitorId: a }).expect(422);
    await event({ type: 'product_view', visitorId: a, productId: 'nope' }).expect(422);

    const s = await summary();
    expect(s.total).toMatchObject({
      visitors: 3,
      productViewers: 2,
      cartVisitors: 1,
      checkoutVisitors: 1,
      orders: 0,
    });
    expect(s.sources).toEqual(
      expect.arrayContaining([
        { source: 'facebook', visitors: 1, orders: 0 },
        { source: 'instagram', visitors: 1, orders: 0 },
        { source: 'direct', visitors: 1, orders: 0 },
      ]),
    );
    expect(s.products[0]).toMatchObject({
      productId: panjabi.id,
      name: 'Cotton Panjabi',
      viewers: 2,
    });
    expect(s.products[1]).toMatchObject({ productId: saree.id, viewers: 1 });
  });

  it('adds orders with their value, source and products, and the funnel ends with them', async () => {
    const res = await shop('/checkout')
      .set('idempotency-key', 'stats-order-0001')
      .send({
        items: [
          { productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 2 },
          { productId: saree.id, variantId: saree.variants[0]!.id, quantity: 1 },
        ],
        customer: { name: 'Rahima Akter', phone: '01911223344' },
        address: { line1: 'House 7, Road 2', city: 'Dhaka' },
        zoneId: 'dhaka',
        attribution: { utmSource: 'facebook', fbclid: 'IwAR0abc' },
      })
      .expect(201);
    // A retry with the same key is the same order and is not counted twice.
    await shop('/checkout')
      .set('idempotency-key', 'stats-order-0001')
      .send({
        items: [
          { productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 2 },
          { productId: saree.id, variantId: saree.variants[0]!.id, quantity: 1 },
        ],
        customer: { name: 'Rahima Akter', phone: '01911223344' },
        address: { line1: 'House 7, Road 2', city: 'Dhaka' },
        zoneId: 'dhaka',
        attribution: { utmSource: 'facebook', fbclid: 'IwAR0abc' },
      })
      .expect(201);

    const order = (
      await O()
        .get(url(`/orders?q=${res.body.orderNumber}`))
        .expect(200)
    ).body.items[0];
    expect(order.attribution).toMatchObject({ utmSource: 'facebook', fbclid: 'IwAR0abc' });

    const s = await summary();
    expect(s.total.orders).toBe(1);
    expect(s.total.revenueMinor).toBe(res.body.totalMinor);
    expect(s.conversionRate).toBeCloseTo(1 / 3);
    expect(s.funnel.map((f) => f.shoppers)).toEqual([3, 2, 1, 1, 1]);
    expect(s.sources.find((x) => x.source === 'facebook')).toEqual({
      source: 'facebook',
      visitors: 1,
      orders: 1,
    });
    expect(s.products.find((p) => p.productId === panjabi.id)).toMatchObject({
      viewers: 2,
      orders: 1,
      units: 2,
      revenueMinor: 240_000,
    });
    expect(s.products.find((p) => p.productId === saree.id)).toMatchObject({
      orders: 1,
      units: 1,
      revenueMinor: 300_000,
    });
    expect(s.days).toHaveLength(7);
    expect(s.days.at(-1)).toMatchObject({ visitors: 3, orders: 1 });
    expect(s.previous).toMatchObject({ visitors: 0, orders: 0 });
    expect(s.currency).toBe('BDT');
  });

  it('keeps each business to its own numbers', async () => {
    // Another business cannot see this store from its own account, nor reach this business.
    await t.as(other.token).get(`/v1/orgs/${otherOrgId}/stores/${storeId}/stats`).expect(404);
    await t.as(other.token).get(`/v1/orgs/${orgId}/stores/${storeId}/stats`).expect(404);
  });

  it('asks for a sensible period', async () => {
    await O()
      .get(url(`/stores/${storeId}/stats?days=3`))
      .expect(422);
    expect((await summary(30)).days).toHaveLength(30);
  });
});
