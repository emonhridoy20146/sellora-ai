import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ProductDto {
  id: string;
  variants: { id: string; priceMinor: number }[];
}

interface CouponDto {
  id: string;
  code: string;
  kind: string;
  percent: number | null;
  amountMinor: number | null;
  used: number;
  discountGivenMinor: number;
  state: string;
  active: boolean;
  perCustomerLimit: number | null;
}

interface CouponCheck {
  valid: boolean;
  code: string;
  reason?: string;
  discountMinor?: number;
  freeDelivery?: boolean;
  minOrderMinor?: number;
}

interface OrderDto {
  id: string;
  number: string;
  status: string;
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  totalMinor: number;
  coupon: {
    code: string;
    discountMinor: number;
    freeDelivery: boolean;
    released: boolean;
  } | null;
}

describe('coupons at store checkout and on landing pages (ADR 0031)', () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let orgId: string;
  let otherOrgId: string;
  let platform: string;
  let key: string;
  let storeId: string;
  let shirt: ProductDto;
  let page: { id: string; slug: string };
  let otherPage: { id: string; slug: string };
  const host = 'tanti-ghor.shops.test';
  let n = 10;

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  /** A new shopper: own address and phone, so the shop's own limits stay out of the way. */
  const shopper = () => {
    n += 1;
    return { ip: `198.51.100.${n}`, phone: `0181${String(1_000_000 + n).slice(-7)}` };
  };
  const shop = (path: string, ip: string) =>
    t
      .http()
      .post(`/v1/storefront${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', ip);

  const make = (body: Record<string, unknown>) => O().post(url('/coupons')).send(body);
  const coupon = async (code: string) =>
    ((await O().get(url('/coupons')).expect(200)).body as { items: CouponDto[] }).items.find(
      (c) => c.code === code,
    )!;

  const quote = async (
    code: string | undefined,
    who = shopper(),
    opts: { quantity?: number; phone?: string } = {},
  ) =>
    (
      await shop('/cart', who.ip)
        .send({
          items: [
            { productId: shirt.id, variantId: shirt.variants[0]!.id, quantity: opts.quantity ?? 1 },
          ],
          zoneId: 'outside',
          ...(code ? { couponCode: code } : {}),
          ...(opts.phone ? { phone: opts.phone } : {}),
        })
        .expect(200)
    ).body as {
      couponBox: boolean;
      subtotalMinor: number;
      discountMinor: number;
      deliveryChargeMinor: number;
      totalMinor: number;
      coupon: CouponCheck | null;
    };

  const checkout = (code: string | undefined, who = shopper(), quantity = 1) =>
    shop('/checkout', who.ip)
      .set('idempotency-key', `cpn-${Date.now()}-${n}-${Math.random().toString(36).slice(2)}`)
      .send({
        items: [{ productId: shirt.id, variantId: shirt.variants[0]!.id, quantity }],
        customer: { name: 'Shirin Akter', phone: who.phone },
        address: { line1: 'House 4, Road 2', city: 'Sylhet' },
        zoneId: 'outside',
        ...(code ? { couponCode: code } : {}),
      });

  const orderByNumber = async (number: string) => {
    const list = (
      await O()
        .get(url(`/orders?q=${encodeURIComponent(number)}`))
        .expect(200)
    ).body.items as { id: string }[];
    return (
      await O()
        .get(url(`/orders/${list[0]!.id}`))
        .expect(200)
    ).body as OrderDto;
  };

  const lp = (slug: string, path: string, ip: string) =>
    t
      .http()
      .post(`/v1/storefront/landing-pages/${slug}${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', ip);

  beforeAll(async () => {
    // Real per-address limits: the guessing test needs the coupon limit as it is in production.
    t = await TestApp.create({ API_PUBLIC_URL: 'http://api.test', RATE_LIMIT_IP_MULTIPLIER: '1' });
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Tanti Ghor', category: 'fashion' })).id;
    other = await t.registerUser({ name: 'Someone else' });
    otherOrgId = (await t.createOrg(other, { name: 'Other Shop', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Store', 'Product', 'Customer', 'Order', 'Coupon', 'CouponUse', 'LandingPage'].map((m) =>
        t.db.model(m).init(),
      ),
    );
    shirt = (
      await O()
        .post(url('/products'))
        .send({ name: 'Khadi Shirt', variants: [{ priceMinor: 120_000, stock: 100 }] })
        .expect(201)
    ).body as ProductDto;
    await O()
      .patch(url('/shop-settings'))
      .send({
        deliveryZones: [
          { id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 },
          { id: 'outside', name: 'Outside Dhaka', chargeMinor: 12_000 },
        ],
        defaultZoneId: 'dhaka',
      })
      .expect(200);
    storeId = (
      (await O().post(url('/stores')).send({ name: 'Tanti Ghor' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await O()
      .patch(url(`/stores/${storeId}`))
      .send({ contact: { phone: '01712345678' } })
      .expect(200);
    await O()
      .post(url(`/stores/${storeId}/submit`))
      .expect(200);
    await t.as(platform).post(`/v1/platform/stores/${storeId}/approve`).send({}).expect(200);
    await t
      .as(platform)
      .patch('/v1/platform/settings')
      .send({ stores: { autoApproveLandingPages: true } })
      .expect(200);
    const makePage = async (name: string) => {
      const p = (
        await O()
          .post(url('/landing-pages'))
          .send({ storeId, name, productId: shirt.id, template: 'quick_order' })
          .expect(201)
      ).body as { id: string; slug: string };
      await O()
        .post(url(`/landing-pages/${p.id}/submit`))
        .expect(200);
      return p;
    };
    page = await makePage('Khadi Eid offer');
    otherPage = await makePage('Khadi winter offer');
  });
  afterAll(async () => {
    await t.close();
  });

  describe('making coupons', () => {
    it('makes percent, amount and free-delivery coupons and checks what is typed', async () => {
      // No coupon yet: the checkout and the order form show no code box.
      expect((await quote(undefined)).couponBox).toBe(false);
      const view = async (slug: string) =>
        (
          await t
            .http()
            .get(`/v1/storefront/landing-pages/${slug}`)
            .set('x-storefront-key', key)
            .set('x-store-host', host)
            .expect(200)
        ).body as { couponBox: boolean };
      expect((await view(page.slug)).couponBox).toBe(false);
      const eid = (
        await make({
          code: ' eid 10 ',
          kind: 'percent',
          percent: 10,
          maxDiscountMinor: 20_000,
        }).expect(201)
      ).body as CouponDto;
      expect(eid).toMatchObject({
        code: 'EID10',
        kind: 'percent',
        percent: 10,
        used: 0,
        state: 'active',
        perCustomerLimit: 1,
      });
      const save50 = (
        await make({
          code: 'SAVE50',
          kind: 'amount',
          amountMinor: 5_000,
          minOrderMinor: 200_000,
          usageLimit: 2,
          perCustomerLimit: null,
        }).expect(201)
      ).body as CouponDto;
      await make({
        code: 'FREESHIP',
        kind: 'free_delivery',
        store: false,
        landing: 'chosen',
        landingPageIds: [page.id],
      }).expect(201);
      const turn = (c: CouponDto, active: boolean) =>
        O()
          .patch(url(`/coupons/${c.id}`))
          .send({ active })
          .expect(200);
      // Only FREESHIP on: its page shows the box; the other page and the store do not.
      await turn(eid, false);
      await turn(save50, false);
      expect((await view(page.slug)).couponBox).toBe(true);
      expect((await view(otherPage.slug)).couponBox).toBe(false);
      expect((await quote(undefined)).couponBox).toBe(false);
      await turn(save50, true);
      expect((await quote(undefined)).couponBox).toBe(true);
      expect((await view(otherPage.slug)).couponBox).toBe(true);
      await turn(eid, true);

      const dup = await make({ code: 'eid10', kind: 'free_delivery' }).expect(409);
      expect(dup.body.code).toBe('code_taken');
      const bad = await make({ code: 'a!', kind: 'percent', percent: 10 }).expect(422);
      expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(['code']);
      await make({ code: 'TOOMUCH', kind: 'percent', percent: 95 }).expect(422);
      await make({ code: 'NOPAGES', kind: 'amount', amountMinor: 100, landing: 'chosen' }).expect(
        422,
      );
      await make({
        code: 'NOWHERE',
        kind: 'amount',
        amountMinor: 100,
        store: false,
        landing: 'none',
      }).expect(422);
      await make({
        code: 'PAST',
        kind: 'amount',
        amountMinor: 100,
        endsAt: new Date(Date.now() - 60_000).toISOString(),
      }).expect(422);
      await make({ code: 'NOAMOUNT', kind: 'amount' }).expect(422);
      await make({
        code: 'LATER',
        kind: 'amount',
        amountMinor: 2_000,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      }).expect(201);

      const list = (await O().get(url('/coupons')).expect(200)).body as {
        items: CouponDto[];
        landingPages: { id: string }[];
      };
      expect(list.items.map((c) => c.code).sort()).toEqual([
        'EID10',
        'FREESHIP',
        'LATER',
        'SAVE50',
      ]);
      expect(list.items.find((c) => c.code === 'LATER')!.state).toBe('scheduled');
      expect(list.landingPages.map((p) => p.id).sort()).toEqual([page.id, otherPage.id].sort());
    });

    it('keeps another business out', async () => {
      const eid = await coupon('EID10');
      const theirs = t.as(other.token);
      expect(
        (
          (await theirs.get(`/v1/orgs/${otherOrgId}/coupons`).expect(200)).body as {
            items: unknown[];
          }
        ).items,
      ).toEqual([]);
      await theirs
        .patch(`/v1/orgs/${otherOrgId}/coupons/${eid.id}`)
        .send({ active: false })
        .expect(404);
      await theirs.delete(`/v1/orgs/${otherOrgId}/coupons/${eid.id}`).expect(404);
      // A page of another business cannot be chosen.
      await theirs
        .post(`/v1/orgs/${otherOrgId}/coupons`)
        .send({
          code: 'STEAL',
          kind: 'amount',
          amountMinor: 100,
          landing: 'chosen',
          landingPageIds: [page.id],
        })
        .expect(422);
      await theirs.get(`/v1/orgs/${orgId}/coupons`).expect(404);
    });
  });

  describe('store checkout', () => {
    it('prices the cart with a code, or says why it does not work', async () => {
      const plain = await quote(undefined);
      expect(plain).toMatchObject({
        subtotalMinor: 120_000,
        discountMinor: 0,
        deliveryChargeMinor: 12_000,
        totalMinor: 132_000,
        coupon: null,
      });
      expect(await quote('eid10')).toMatchObject({
        discountMinor: 12_000,
        totalMinor: 120_000,
        coupon: { valid: true, code: 'EID10', discountMinor: 12_000, freeDelivery: false },
      });
      // 10% of three shirts is ৳360, held to the ৳200 cap.
      expect((await quote('EID10', shopper(), { quantity: 3 })).discountMinor).toBe(20_000);
      expect((await quote('NOPE')).coupon).toMatchObject({ valid: false, reason: 'invalid' });
      expect((await quote('SAVE50')).coupon).toMatchObject({
        valid: false,
        reason: 'min_order',
        minOrderMinor: 200_000,
      });
      expect((await quote('SAVE50', shopper(), { quantity: 2 })).discountMinor).toBe(5_000);
      expect((await quote('FREESHIP')).coupon).toMatchObject({ valid: false, reason: 'not_here' });
      expect((await quote('LATER')).coupon).toMatchObject({ valid: false, reason: 'not_started' });
    });

    it('stops one address from guessing codes, but not from asking about the same code again', async () => {
      const who = shopper();
      for (let i = 0; i < 25; i += 1) await quote('EID10', who);
      for (let i = 0; i < 19; i += 1) await quote(`GUESS${i}`, who);
      const res = await shop('/cart', who.ip)
        .send({
          items: [{ productId: shirt.id, variantId: shirt.variants[0]!.id, quantity: 1 }],
          zoneId: 'outside',
          couponCode: 'GUESS99',
        })
        .expect(429);
      expect(res.body.code).toBe('rate_limited');
    });

    it('takes the coupon off the order and counts the use; one use per phone', async () => {
      const who = shopper();
      const placed = (await checkout('EID10', who).expect(201)).body as {
        orderNumber: string;
        totalMinor: number;
      };
      expect(placed.totalMinor).toBe(120_000);
      const order = await orderByNumber(placed.orderNumber);
      expect(order).toMatchObject({
        subtotalMinor: 120_000,
        discountMinor: 12_000,
        deliveryChargeMinor: 12_000,
        totalMinor: 120_000,
        coupon: { code: 'EID10', discountMinor: 12_000, freeDelivery: false, released: false },
      });
      expect(await coupon('EID10')).toMatchObject({ used: 1, discountGivenMinor: 12_000 });
      // The same phone again: the coupon allows one order per customer.
      const again = await checkout('EID10', { ...shopper(), phone: who.phone }).expect(422);
      expect(again.body).toMatchObject({ code: 'coupon_invalid', reason: 'customer_limit' });
      expect((await quote('EID10', shopper(), { phone: who.phone })).coupon).toMatchObject({
        valid: false,
        reason: 'customer_limit',
      });
      // A bad code fails the order instead of silently charging the full price.
      expect((await checkout('NOPE').expect(422)).body.reason).toBe('invalid');
    });

    it('gives the use back when the order is cancelled', async () => {
      const who = shopper();
      const placed = (await checkout('EID10', who).expect(201)).body as { orderNumber: string };
      expect((await coupon('EID10')).used).toBe(2);
      const order = await orderByNumber(placed.orderNumber);
      const cancelled = (
        await O()
          .post(url(`/orders/${order.id}/cancel`))
          .send({ reason: 'Customer changed mind' })
          .expect(200)
      ).body as OrderDto;
      expect(cancelled.coupon).toMatchObject({ code: 'EID10', released: true });
      expect(await coupon('EID10')).toMatchObject({ used: 1, discountGivenMinor: 12_000 });
      // The phone may use it again.
      await checkout('EID10', { ...shopper(), phone: who.phone }).expect(201);
      expect((await coupon('EID10')).used).toBe(2);
    });

    it('never lets a limited coupon be used more often than allowed, even at the same moment', async () => {
      await make({ code: 'ONLYONE', kind: 'amount', amountMinor: 10_000, usageLimit: 1 }).expect(
        201,
      );
      const results = await Promise.all([
        checkout('ONLYONE'),
        checkout('ONLYONE'),
        checkout('ONLYONE'),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 422, 422]);
      for (const r of results.filter((x) => x.status === 422))
        expect(r.body.reason).toBe('used_up');
      expect(await coupon('ONLYONE')).toMatchObject({ used: 1, state: 'used_up' });
      // The losing orders were not made.
      const orders = (await O().get(url('/orders?pageSize=100')).expect(200)).body.items as {
        id: string;
      }[];
      const withCoupon = [];
      for (const o of orders) {
        const full = (
          await O()
            .get(url(`/orders/${o.id}`))
            .expect(200)
        ).body as OrderDto;
        if (full.coupon?.code === 'ONLYONE') withCoupon.push(full);
      }
      expect(withCoupon).toHaveLength(1);
    });

    it('switching a coupon off stops it; a used one cannot be removed or renamed', async () => {
      const eid = await coupon('EID10');
      await O()
        .patch(url(`/coupons/${eid.id}`))
        .send({ active: false })
        .expect(200);
      expect((await quote('EID10')).coupon).toMatchObject({ valid: false, reason: 'invalid' });
      expect((await coupon('EID10')).state).toBe('off');
      expect(
        (
          await O()
            .delete(url(`/coupons/${eid.id}`))
            .expect(409)
        ).body.code,
      ).toBe('coupon_used');
      expect(
        (
          await O()
            .patch(url(`/coupons/${eid.id}`))
            .send({ code: 'EID11' })
            .expect(409)
        ).body.code,
      ).toBe('coupon_used');
      await O()
        .patch(url(`/coupons/${eid.id}`))
        .send({ usageLimit: 1 })
        .expect(422);
      const later = await coupon('LATER');
      await O()
        .delete(url(`/coupons/${later.id}`))
        .expect(204);
    });
  });

  describe('landing pages', () => {
    const selection = {
      packageId: null,
      variantId: '',
      quantity: 1,
      addOn: false,
      zoneId: 'outside',
    };

    it('checks a code against the order form’s choice', async () => {
      const who = shopper();
      const res = (
        await lp(page.slug, '/coupon', who.ip)
          .send({ ...selection, variantId: shirt.variants[0]!.id, code: 'freeship' })
          .expect(200)
      ).body as {
        coupon: CouponCheck;
        goodsMinor: number;
        discountMinor: number;
        deliveryChargeMinor: number;
        totalMinor: number;
      };
      expect(res).toMatchObject({
        coupon: { valid: true, code: 'FREESHIP', discountMinor: 0, freeDelivery: true },
        goodsMinor: 120_000,
        deliveryChargeMinor: 0,
        totalMinor: 120_000,
      });
      // FREESHIP works only on the page it was made for.
      const elsewhere = (
        await lp(otherPage.slug, '/coupon', who.ip)
          .send({ ...selection, variantId: shirt.variants[0]!.id, code: 'FREESHIP' })
          .expect(200)
      ).body as { coupon: CouponCheck; deliveryChargeMinor: number };
      expect(elsewhere.coupon).toMatchObject({ valid: false, reason: 'not_here' });
      expect(elsewhere.deliveryChargeMinor).toBe(12_000);
    });

    it('places a landing page order with the coupon', async () => {
      const who = shopper();
      const placed = (
        await lp(page.slug, '/orders', who.ip)
          .set('idempotency-key', `lp-cpn-${Date.now()}-abcdef`)
          .send({
            ...selection,
            variantId: shirt.variants[0]!.id,
            customer: { name: 'Nasrin Sultana', phone: who.phone },
            address: { line1: 'Flat 3B, Road 11', city: 'Khulna' },
            couponCode: 'FREESHIP',
          })
          .expect(201)
      ).body as { orderNumber: string; totalMinor: number };
      expect(placed.totalMinor).toBe(120_000);
      const order = await orderByNumber(placed.orderNumber);
      expect(order).toMatchObject({
        deliveryChargeMinor: 0,
        discountMinor: 0,
        totalMinor: 120_000,
        coupon: { code: 'FREESHIP', freeDelivery: true },
      });
      expect((await coupon('FREESHIP')).used).toBe(1);
      // On the other page the same code fails the order.
      const refused = await lp(otherPage.slug, '/orders', shopper().ip)
        .set('idempotency-key', `lp-cpn-${Date.now()}-b-abcdef`)
        .send({
          ...selection,
          variantId: shirt.variants[0]!.id,
          customer: { name: 'Nasrin Sultana', phone: shopper().phone },
          address: { line1: 'Flat 3B, Road 11', city: 'Khulna' },
          couponCode: 'FREESHIP',
        })
        .expect(422);
      expect(refused.body).toMatchObject({ code: 'coupon_invalid', reason: 'not_here' });
    });
  });
});
