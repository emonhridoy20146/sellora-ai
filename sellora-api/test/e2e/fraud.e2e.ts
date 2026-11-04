import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { ParcelsService } from '../../src/modules/couriers/parcels.service.js';
import { FakeCouriers } from '../helpers/fake-couriers.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface CheckDto {
  phone: string;
  localPhone: string;
  level: string;
  successRate: number | null;
  outcomes: number;
  reasons: string[];
  customer: { id: string; name: string; blocked: boolean } | null;
  own: { orders: number; delivered: number; returned: number; cancelled: number };
  network: { businesses: number; delivered: number; returned: number } | null;
  networkStatus: string;
}

const STEADFAST = { apiKey: 'fraud-sf-key-01', secretKey: 'fraud-sf-secret-01' };

describe('Fraud check', () => {
  const couriers = new FakeCouriers();
  let t: TestApp;
  let platform: string;

  interface Shop {
    owner: Session;
    orgId: string;
    productId: string;
    variantId: string;
  }
  let shopA: Shop;
  let shopB: Shop;
  let fulfillment: Session;

  const url = (shop: Shop, path: string) => `/v1/orgs/${shop.orgId}${path}`;
  const as = (shop: Shop) => t.as(shop.owner.token);

  const newShop = async (): Promise<Shop> => {
    const owner = await t.registerUser();
    const orgId = (await t.createOrg(owner)).id;
    const product = await t
      .as(owner.token)
      .post(`/v1/orgs/${orgId}/products`)
      .send({ name: 'Kurti', variants: [{ priceMinor: 80_000, stock: 100 }] })
      .expect(201);
    return {
      owner,
      orgId,
      productId: product.body.id as string,
      variantId: product.body.variants[0].id as string,
    };
  };

  const order = async (
    shop: Shop,
    phone: string,
    final?: 'delivered' | 'returned' | 'cancelled',
  ) => {
    const res = await as(shop)
      .post(url(shop, '/orders'))
      .send({
        customer: { name: `Customer ${phone.slice(-4)}`, phone },
        shippingAddress: { line1: 'House 4, Road 8, Gulshan', city: 'Dhaka' },
        items: [{ productId: shop.productId, variantId: shop.variantId, quantity: 1 }],
      })
      .expect(201);
    const id = res.body.id as string;
    if (final === 'cancelled')
      await as(shop)
        .post(url(shop, `/orders/${id}/cancel`))
        .send({})
        .expect(200);
    if (final === 'delivered' || final === 'returned') {
      await as(shop)
        .post(url(shop, `/orders/${id}/status`))
        .send({ status: 'shipped' })
        .expect(200);
      await as(shop)
        .post(url(shop, `/orders/${id}/status`))
        .send({ status: 'delivered' })
        .expect(200);
      if (final === 'returned')
        await as(shop)
          .post(url(shop, `/orders/${id}/status`))
          .send({ status: 'returned' })
          .expect(200);
    }
    return id;
  };

  const check = async (shop: Shop, phone: string, session = shop.owner) =>
    (
      await t
        .as(session.token)
        .get(url(shop, `/fraud-check?phone=${encodeURIComponent(phone)}`))
        .expect(200)
    ).body as CheckDto;

  beforeAll(async () => {
    couriers.steadfastAccounts.set(STEADFAST.apiKey, {
      secretKey: STEADFAST.secretKey,
      balance: 0,
    });
    t = await TestApp.create(
      { FRAUD_NETWORK_SECRET: 'fraud-network-secret-for-tests-0123456789' },
      { courierFetch: couriers.fetch },
    );
    platform = (await t.platformOwner()).token;
    shopA = await newShop();
    shopB = await newShop();
    fulfillment = await t.addMember(shopA.owner, shopA.orgId, 'fulfillment');
  });

  afterAll(async () => {
    await t?.close();
  });

  it('rates a number by the business’s own delivery record', async () => {
    const phone = '01811000001';
    expect(await check(shopA, phone)).toMatchObject({
      phone: '+8801811000001',
      localPhone: '01811000001',
      level: 'new',
      successRate: null,
      customer: null,
      own: { orders: 0, delivered: 0, returned: 0, cancelled: 0 },
      network: null,
      networkStatus: 'unavailable',
    });

    await order(shopA, phone, 'delivered');
    await order(shopA, phone, 'delivered');
    await order(shopA, phone, 'returned');
    await order(shopA, phone);
    const r = await check(shopA, '+880 1811-000001', fulfillment);
    expect(r).toMatchObject({
      level: 'medium',
      successRate: 67,
      outcomes: 3,
      own: { orders: 4, delivered: 2, returned: 1, cancelled: 0 },
    });
    expect(r.reasons).toEqual([
      'Here: 4 orders, 2 delivered, 1 returned, 0 cancelled.',
      '67% of 3 parcels delivered.',
    ]);

    // Another business sees nothing of it.
    expect((await check(shopB, phone)).level).toBe('new');
  });

  it('marks blocked customers and frequent cancellers', async () => {
    const phone = '01811000002';
    await order(shopA, phone, 'cancelled');
    await order(shopA, phone, 'cancelled');
    await order(shopA, phone, 'cancelled');
    let r = await check(shopA, phone);
    expect(r.level).toBe('medium');
    expect(r.reasons).toContain('Cancelled 3 orders here, more than were delivered.');

    await as(shopA)
      .patch(url(shopA, `/customers/${r.customer!.id}`))
      .send({ blocked: true })
      .expect(200);
    r = await check(shopA, phone);
    expect(r).toMatchObject({ level: 'high', customer: { blocked: true } });
    expect(r.reasons[0]).toBe('Blocked by your team.');
  });

  it('answers many numbers at once for list badges', async () => {
    const res = await as(shopA)
      .post(url(shopA, '/fraud-check/batch'))
      .send({ phones: ['01811000001', '+8801811000002', '01811000009', '01811000001'] })
      .expect(200);
    expect(res.body).toEqual({
      networkStatus: 'unavailable',
      items: [
        { phone: '+8801811000001', level: 'medium', successRate: 67, outcomes: 3 },
        { phone: '+8801811000002', level: 'high', successRate: null, outcomes: 0 },
        { phone: '+8801811000009', level: 'new', successRate: null, outcomes: 0 },
      ],
    });
    await as(shopA)
      .post(url(shopA, '/fraud-check/batch'))
      .send({ phones: ['12'] })
      .expect(422);
    await as(shopA).get(url(shopA, '/fraud-check?phone=abc')).expect(422);
  });

  it('shares courier-confirmed outcomes only when the platform and both businesses opt in', async () => {
    // Off by default: a business cannot start sharing.
    await as(shopA)
      .patch(url(shopA, '/fraud-check/settings'))
      .send({ shareOutcomes: true })
      .expect(422);
    const switched = await t
      .as(platform)
      .patch('/v1/platform/settings')
      .send({ fraudNetwork: { enabled: true } })
      .expect(200);
    expect(switched.body.fraudNetwork).toEqual({ enabled: true, configured: true });
    // Only the switch is stored; whether the secret is set comes from the server's env.
    await t
      .as(platform)
      .patch('/v1/platform/settings')
      .send({ fraudNetwork: { configured: false } })
      .expect(422);
    expect((await as(shopA).get(url(shopA, '/fraud-check/settings')).expect(200)).body).toEqual({
      shareOutcomes: false,
      sharedSince: null,
      networkAvailable: true,
    });
    await t
      .as(fulfillment.token)
      .patch(url(shopA, '/fraud-check/settings'))
      .send({ shareOutcomes: true })
      .expect(403);
    await as(shopB)
      .patch(url(shopB, '/fraud-check/settings'))
      .send({ shareOutcomes: true })
      .expect(200);

    // Shop B ships with Steadfast; the courier returns the parcel.
    const phone = '01911000003';
    await as(shopB)
      .post(url(shopB, '/couriers/accounts'))
      .send({ provider: 'steadfast', name: 'Steadfast', credentials: STEADFAST })
      .expect(201);
    const orderId = await order(shopB, phone);
    const parcel = (
      await as(shopB)
        .post(url(shopB, `/orders/${orderId}/parcels`))
        .send({})
        .expect(201)
    ).body as {
      id: string;
      consignmentId: string;
    };
    couriers.setStatus(parcel.consignmentId, 'pending');
    const parcels = t.app.get(ParcelsService);
    const run = (fn: () => Promise<unknown>) =>
      RequestContext.withTenant(shopB.orgId, fn, { type: 'system', id: 'test' });
    await run(() => parcels.check(parcel.id, 'poll'));
    couriers.setStatus(parcel.consignmentId, 'cancelled');
    await run(() => parcels.check(parcel.id, 'poll'));
    await vi.waitFor(async () =>
      expect(await t.db.collection('delivery_outcomes').countDocuments({})).toBe(1),
    );
    const row = await t.db.collection('delivery_outcomes').findOne({});
    expect(row).toMatchObject({ outcome: 'returned' });
    // Only a keyed hash of the number is shared.
    expect(JSON.stringify(row)).not.toMatch(/1911000003/);
    expect(row!.phoneHash).toMatch(/^[0-9a-f]{64}$/);

    // Shop A does not share, so it does not see the network.
    let r = await check(shopA, phone);
    expect(r).toMatchObject({ networkStatus: 'not_sharing', network: null, level: 'new' });
    await as(shopA)
      .patch(url(shopA, '/fraud-check/settings'))
      .send({ shareOutcomes: true })
      .expect(200);
    r = await check(shopA, phone);
    expect(r).toMatchObject({
      networkStatus: 'on',
      network: { businesses: 1, delivered: 0, returned: 1 },
      level: 'medium',
      successRate: 0,
    });
    expect(r.reasons).toContain('Other shops on Sellora (1): 0 delivered, 1 returned.');
    // A business's own outcomes are not counted twice.
    expect((await check(shopB, phone)).network).toBeNull();

    // Stopping deletes what the business shared.
    await as(shopB)
      .patch(url(shopB, '/fraud-check/settings'))
      .send({ shareOutcomes: false })
      .expect(200);
    expect(await t.db.collection('delivery_outcomes').countDocuments({})).toBe(0);
    expect((await check(shopA, phone)).network).toBeNull();
    await t
      .as(platform)
      .patch('/v1/platform/settings')
      .send({ fraudNetwork: { enabled: false } })
      .expect(200);
    expect((await check(shopA, phone)).networkStatus).toBe('unavailable');
  });

  it('answers 402 when the plan has no fraud check', async () => {
    await t
      .as(platform)
      .put(`/v1/platform/billing/tenants/${shopA.orgId}/subscription/overrides`)
      .send({ removeModules: ['fraud'], note: 'fraud test' })
      .expect(200);
    await as(shopA).get(url(shopA, '/fraud-check?phone=01811000001')).expect(402);
  });
});
