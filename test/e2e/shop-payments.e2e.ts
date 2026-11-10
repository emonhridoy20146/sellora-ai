import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShopPaymentsService } from '../../src/modules/shop-payments/shop-payments.service.js';
import { FakeShopGateways } from '../helpers/fake-shop-gateways.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ProductDto {
  id: string;
  variants: { id: string; priceMinor: number }[];
}

interface Account {
  id: string;
  gateway: string;
  enabled: boolean;
  sandbox: boolean;
  credentialsHint: string;
  lastCheck: { checked: boolean; summary: string };
  lastError: { message: string } | null;
}

interface Start {
  gateway: string;
  amountMinor: number;
  redirectUrl: string | null;
  error: string | null;
}

interface Placed {
  orderNumber: string;
  totalMinor: number;
  receipt: string;
  payment: Start | null;
}

interface OrderDto {
  id: string;
  number: string;
  totalMinor: number;
  payment: {
    method: string;
    status: string;
    paidMinor: number;
    reference: string | null;
    online: {
      gateway: string;
      purpose: string;
      dueMinor: number;
      status: string;
      sandbox: boolean;
    } | null;
  };
}

describe('payments at checkout with the business’s own gateways (ADR 0029)', () => {
  let t: TestApp;
  const fake = new FakeShopGateways();
  let owner: Session;
  let other: Session;
  let orgId: string;
  let otherOrgId: string;
  let platform: string;
  let key: string;
  let storeId: string;
  let panjabi: ProductDto;
  const host = 'kumartuli-crafts.shops.test';
  let ip = 10;

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  // Each order from its own address and phone, so the shop's rate limits stay out of the way.
  const shopper = () => {
    ip += 1;
    return { ip: `203.0.113.${ip}`, phone: `0171${String(1_000_000 + ip).slice(-7)}` };
  };
  const shop = (method: 'get' | 'post', path: string, from = '203.0.113.200') =>
    t
      .http()
      [method](`/v1/storefront${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', from);

  const checkout = async (
    payment: Record<string, unknown> | undefined,
    opts: { zoneId?: string; quantity?: number; expect?: number } = {},
  ) => {
    const who = shopper();
    const res = await shop('post', '/checkout', who.ip)
      .set('idempotency-key', `idem-${Date.now()}-${ip}-abcdef`)
      .send({
        items: [
          {
            productId: panjabi.id,
            variantId: panjabi.variants[0]!.id,
            quantity: opts.quantity ?? 1,
          },
        ],
        customer: { name: 'Rahima Akter', phone: who.phone },
        address: { line1: 'House 12, Road 5', city: 'Rajshahi' },
        zoneId: opts.zoneId ?? 'outside',
        ...(payment ? { payment } : {}),
      })
      .expect(opts.expect ?? 201);
    return res.body as Placed;
  };
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
  const receipt = async (token: string) =>
    (await shop('get', `/orders/receipt?receipt=${encodeURIComponent(token)}`).expect(200))
      .body as {
      payment: {
        method: string;
        status: string;
        paidMinor: number;
        dueMinor: number;
        online: { gateway: string; status: string; purpose: string; sandbox: boolean } | null;
        payNow: { amountMinor: number; gateways: { key: string }[] } | null;
      };
    };
  /** The shopper comes back from the gateway the way that gateway sends them. */
  const comeBack = async (gateway: string, ref: string, outcome = 'paid') => {
    const a = fake.attempts.get(ref)!;
    let req;
    if (gateway === 'bkash')
      req = t
        .http()
        .get(
          `/v1/shop-payments/${ref}/return/done?paymentID=${a.sessionId}&status=${outcome === 'paid' ? 'success' : 'cancel'}&signature=x`,
        );
    else if (gateway === 'nagad')
      req = t
        .http()
        .get(
          `/v1/shop-payments/${ref}/return/done?merchant=1&order_id=${ref}&payment_ref_id=${a.sessionId}&status=${outcome === 'paid' ? 'Success' : 'Aborted'}&status_code=00_0000_000`,
        );
    else if (gateway === 'sslcommerz')
      req = t
        .http()
        .post(`/v1/shop-payments/${ref}/return/${outcome === 'paid' ? 'success' : 'cancel'}`)
        .type('form')
        .send({ tran_id: ref, val_id: a.valId ?? 'none', status: 'VALID' });
    else if (gateway === 'aamarpay')
      req =
        outcome === 'paid'
          ? t
              .http()
              .post(`/v1/shop-payments/${ref}/return/success`)
              .type('form')
              .send({ mer_txnid: ref, pay_status: 'Successful' })
          : t.http().get(`/v1/shop-payments/${ref}/return/cancel`);
    else
      req = t
        .http()
        .get(
          `/v1/shop-payments/${ref}/return/${outcome === 'paid' ? 'done' : 'cancel'}?order_id=${a.sessionId}`,
        );
    const res = await req.expect(303);
    return new URL(res.headers.location as string);
  };
  const connect = (
    gateway: keyof FakeShopGateways['credentials'],
    extra: Record<string, unknown> = {},
  ) =>
    O()
      .post(url('/shop-payments/accounts'))
      .send({ gateway, credentials: { ...fake.credentials[gateway], ...extra }, sandbox: true });

  beforeAll(async () => {
    t = await TestApp.create({ API_PUBLIC_URL: 'http://api.test' }, { gatewayFetch: fake.fetch });
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Kumartuli Crafts', category: 'fashion' })).id;
    other = await t.registerUser({ name: 'Someone else' });
    otherOrgId = (await t.createOrg(other, { name: 'Other Shop', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      [
        'Store',
        'Product',
        'Customer',
        'Order',
        'ShopPayment',
        'ShopPaymentAccount',
        'ShopPaymentSettings',
      ].map((m) => t.db.model(m).init()),
    );
    panjabi = (
      await O()
        .post(url('/products'))
        .send({ name: 'Cotton Panjabi', variants: [{ priceMinor: 150_000, stock: 50 }] })
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
      (await O().post(url('/stores')).send({ name: 'Kumartuli Crafts' }).expect(201)).body as {
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
  });
  afterAll(async () => {
    await t.close();
  });

  describe('connecting gateways', () => {
    it('offers only cash on delivery before any gateway is connected', async () => {
      const quote = (
        await shop('post', '/cart')
          .send({
            items: [{ productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 1 }],
            zoneId: 'outside',
          })
          .expect(200)
      ).body as { payments: unknown };
      expect(quote.payments).toEqual({
        cod: true,
        fullOnline: false,
        gateways: [],
        advanceMinor: 0,
      });
      await checkout({ method: 'online', gateway: 'bkash' }, { expect: 422 });
      const placed = await checkout(undefined);
      expect(placed.payment).toBeNull();
    });

    it('checks keys with the gateway where it can, and never returns them', async () => {
      const bad = await connect('bkash', { appSecret: 'wrong' }).expect(422);
      expect(bad.body.code).toBe('payment_account_check_failed');
      const bkash = (await connect('bkash').expect(201)).body.account as Account;
      expect(bkash).toMatchObject({ gateway: 'bkash', enabled: true, sandbox: true });
      expect(bkash.lastCheck.checked).toBe(true);
      expect(bkash.credentialsHint).toContain('shop01');

      await connect('sslcommerz', { storePassword: 'nope' }).expect(422);
      expect(
        ((await connect('sslcommerz').expect(201)).body.account as Account).lastCheck.checked,
      ).toBe(true);
      await connect('nagad', { privateKey: 'not a key at all' }).expect(422);
      const nagad = (await connect('nagad').expect(201)).body.account as Account;
      expect(nagad.lastCheck.checked).toBe(false);
      const aamar = (await connect('aamarpay').expect(201)).body.account as Account;
      expect(aamar.lastCheck).toMatchObject({ checked: false });
      await connect('shurjopay', { password: 'wrong' }).expect(422);
      await connect('shurjopay').expect(201);
      await connect('bkash').expect(409);

      const overview = (await O().get(url('/shop-payments')).expect(200)).body as {
        accounts: Account[];
        gateways: { key: string }[];
      };
      expect(overview.gateways.map((g) => g.key)).toEqual([
        'bkash',
        'nagad',
        'sslcommerz',
        'aamarpay',
        'shurjopay',
      ]);
      expect(overview.accounts).toHaveLength(5);
      const text = JSON.stringify(overview);
      for (const secret of [
        fake.credentials.bkash.appSecret,
        fake.credentials.bkash.password,
        fake.credentials.sslcommerz.storePassword,
        fake.credentials.aamarpay.signatureKey,
        'BEGIN PRIVATE KEY',
        fake.credentials.shurjopay.password,
      ])
        expect(text).not.toContain(secret);
      // Stored encrypted, not as typed.
      const raw = await t.db.collection('shoppaymentaccounts').find({}).toArray();
      expect(JSON.stringify(raw)).not.toContain(fake.credentials.aamarpay.signatureKey);
    });

    it('keeps another business out', async () => {
      const { accounts } = (await O().get(url('/shop-payments')).expect(200)).body as {
        accounts: Account[];
      };
      await t
        .as(other.token)
        .get(`/v1/orgs/${orgId}/shop-payments`)
        .expect((r) => expect([403, 404]).toContain(r.status));
      await t
        .as(other.token)
        .patch(`/v1/orgs/${otherOrgId}/shop-payments/accounts/${accounts[0]!.id}`)
        .send({ enabled: false })
        .expect(404);
      expect(
        (
          (await t.as(other.token).get(`/v1/orgs/${otherOrgId}/shop-payments`).expect(200))
            .body as {
            accounts: Account[];
          }
        ).accounts,
      ).toEqual([]);
    });

    it('refuses to turn cash on delivery off unless full online payment stays on', async () => {
      await O()
        .patch(url('/shop-payments/settings'))
        .send({ cod: false, fullOnline: false })
        .expect(422);
      await O()
        .patch(url('/shop-payments/settings'))
        .send({ advance: { mode: 'percent', percent: 0 } })
        .expect(422);
      await O()
        .patch(url('/shop-payments/settings'))
        .send({ advance: { mode: 'delivery', zoneIds: ['mars'] } })
        .expect(422);
      const s = (
        await O()
          .patch(url('/shop-payments/settings'))
          .send({ advance: { mode: 'delivery', zoneIds: ['outside'] } })
          .expect(200)
      ).body.settings as { cod: boolean; fullOnline: boolean; advance: { mode: string } };
      expect(s).toMatchObject({ cod: true, fullOnline: true, advance: { mode: 'delivery' } });
    });
  });

  describe('paying at the store’s checkout', () => {
    it('quotes the options and the advance for the delivery area', async () => {
      const quote = async (zoneId: string) =>
        (
          await shop('post', '/cart')
            .send({
              items: [{ productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 1 }],
              zoneId,
            })
            .expect(200)
        ).body as {
          payments: {
            cod: boolean;
            fullOnline: boolean;
            gateways: { key: string }[];
            advanceMinor: number;
          };
        };
      const outside = (await quote('outside')).payments;
      expect(outside).toMatchObject({ cod: true, fullOnline: true, advanceMinor: 12_000 });
      expect(outside.gateways.map((g) => g.key)).toEqual([
        'bkash',
        'nagad',
        'sslcommerz',
        'aamarpay',
        'shurjopay',
      ]);
      expect((await quote('dhaka')).payments.advanceMinor).toBe(0);
    });

    it('pays in full with bKash: verified with bKash, counted once', async () => {
      const placed = await checkout({ method: 'online', gateway: 'bkash' });
      expect(placed.payment).toMatchObject({ gateway: 'bkash', amountMinor: 162_000, error: null });
      expect(placed.payment!.redirectUrl).toContain('sandbox.payment.bkash.com');
      const before = await orderByNumber(placed.orderNumber);
      expect(before.payment).toMatchObject({
        method: 'bkash',
        status: 'unpaid',
        paidMinor: 0,
        online: {
          gateway: 'bkash',
          purpose: 'full',
          dueMinor: 162_000,
          status: 'awaiting',
          sandbox: true,
        },
      });

      const attempt = fake.last('bkash');
      expect(attempt.amount).toBe('1620.00');
      // A shopper who says "success" without paying gets nothing.
      const early = await comeBack('bkash', attempt.ref);
      expect(early.searchParams.get('payment')).toBe('pending');
      expect((await orderByNumber(placed.orderNumber)).payment.paidMinor).toBe(0);

      fake.pay(attempt.ref);
      const back = await comeBack('bkash', attempt.ref);
      expect(back.searchParams.get('payment')).toBe('paid');
      expect(back.searchParams.get('receipt')).toBe(placed.receipt);
      expect(back.pathname).toBe('/order');
      // The same return again (or a reload) does not count twice.
      await comeBack('bkash', attempt.ref);
      const after = await orderByNumber(placed.orderNumber);
      expect(after.payment).toMatchObject({
        status: 'paid',
        paidMinor: 162_000,
        reference: `TRX${attempt.ref.slice(-6)}`,
        online: { status: 'paid' },
      });
      const audit = await t.db
        .collection('audit_events')
        .find({ action: 'order.paid_online', 'target.id': after.id })
        .toArray();
      expect(audit).toHaveLength(1);
      expect((await receipt(placed.receipt)).payment).toMatchObject({
        status: 'paid',
        dueMinor: 0,
        payNow: null,
      });
      const attempts = (
        await O()
          .get(url(`/orders/${after.id}/online-payments`))
          .expect(200)
      ).body.items as { status: string; settled: boolean; gatewayRef: string }[];
      expect(attempts).toEqual([
        expect.objectContaining({
          status: 'succeeded',
          settled: true,
          gatewayRef: `TRX${attempt.ref.slice(-6)}`,
        }),
      ]);
    });

    it('asks the advance on cash on delivery outside Dhaka, paid with Nagad', async () => {
      await checkout({ method: 'cod' }, { expect: 422 });
      const placed = await checkout({ method: 'cod', gateway: 'nagad' });
      expect(placed.payment).toMatchObject({ gateway: 'nagad', amountMinor: 12_000 });
      expect(placed.payment!.redirectUrl).toContain('mynagad.com');
      const attempt = fake.last('nagad');
      expect(attempt.amount).toBe('120.00');
      // Nagad saw our signed, encrypted request with its own headers.
      const init = fake.calls.find((c) =>
        c.url.includes(`/check-out/initialize/683002007104225/${attempt.ref}`),
      )!;
      expect(init.headers['x-km-api-version']).toBe('v-0.2.0');
      expect(init.headers['x-km-client-type']).toBe('PC_WEB');

      fake.pay(attempt.ref);
      expect((await comeBack('nagad', attempt.ref)).searchParams.get('payment')).toBe('paid');
      const order = await orderByNumber(placed.orderNumber);
      expect(order.payment).toMatchObject({
        method: 'cod',
        status: 'partial',
        paidMinor: 12_000,
        online: { purpose: 'advance', status: 'paid' },
      });
      expect((await receipt(placed.receipt)).payment).toMatchObject({
        dueMinor: 150_000,
        online: { purpose: 'advance', status: 'paid' },
        payNow: null,
      });
      // No advance inside Dhaka.
      const dhaka = await checkout({ method: 'cod' }, { zoneId: 'dhaka' });
      expect(dhaka.payment).toBeNull();
      // Staff record the cash later; only a checkout payment is ever "paid online".
      const cod = await orderByNumber(dhaka.orderNumber);
      await O()
        .post(url(`/orders/${cod.id}/payment`))
        .send({ method: 'online', paidMinor: cod.totalMinor })
        .expect(422);
    });

    it('refuses a payment for a different amount than the order asked', async () => {
      const placed = await checkout({ method: 'online', gateway: 'sslcommerz' });
      const attempt = fake.last('sslcommerz');
      fake.pay(attempt.ref, '10.00');
      expect((await comeBack('sslcommerz', attempt.ref)).searchParams.get('payment')).toBe(
        'failed',
      );
      const order = await orderByNumber(placed.orderNumber);
      expect(order.payment).toMatchObject({
        status: 'unpaid',
        paidMinor: 0,
        online: { status: 'failed' },
      });
      expect(
        await t.db
          .collection('audit_events')
          .findOne({ action: 'shop_payment.mismatch', 'target.id': order.id }),
      ).toMatchObject({
        metadata: { expected: { amountMinor: 162_000 }, got: { amountMinor: 1_000 } },
      });
      // The receipt offers to pay again.
      expect((await receipt(placed.receipt)).payment.payNow?.amountMinor).toBe(162_000);
      // A shopper signed in to the dashboard in the same browser still gets back: the gateway's
      // form POST carries their cookies but no CSRF token, and the route reads no session.
      await t
        .http()
        .post(`/v1/shop-payments/${attempt.ref}/return/success`)
        .set('cookie', `sl_at=${owner.token}`)
        .set('origin', 'https://securepay.sslcommerz.com')
        .type('form')
        .send({ tran_id: attempt.ref, val_id: 'none', status: 'VALID' })
        .expect(303);
    });

    it('lets a shopper who cancelled pay again from the receipt with another gateway', async () => {
      const placed = await checkout({ method: 'online', gateway: 'aamarpay' });
      const first = fake.last('aamarpay');
      fake.cancel(first.ref);
      expect((await comeBack('aamarpay', first.ref, 'cancelled')).searchParams.get('payment')).toBe(
        'cancelled',
      );
      const r = await receipt(placed.receipt);
      expect(r.payment.online?.status).toBe('failed');
      expect(r.payment.payNow?.gateways.map((g) => g.key)).toContain('shurjopay');

      const again = (
        await shop('post', '/orders/pay')
          .send({ receipt: placed.receipt, gateway: 'shurjopay' })
          .expect(200)
      ).body as Start;
      expect(again).toMatchObject({ gateway: 'shurjopay', amountMinor: 162_000, error: null });
      const second = fake.last('shurjopay');
      fake.pay(second.ref);
      const back = await comeBack('shurjopay', second.ref);
      expect(back.searchParams.get('payment')).toBe('paid');
      // A retry goes back to the receipt without the thank-you message.
      expect(back.searchParams.get('new')).toBeNull();
      const order = await orderByNumber(placed.orderNumber);
      expect(order.payment).toMatchObject({
        method: 'online',
        status: 'paid',
        online: { gateway: 'shurjopay', status: 'paid' },
      });
      await shop('post', '/orders/pay')
        .send({ receipt: placed.receipt, gateway: 'bkash' })
        .expect(409);
    });

    it('finds payments whose shopper never came back', async () => {
      const placed = await checkout({ method: 'online', gateway: 'bkash' });
      const attempt = fake.last('bkash');
      fake.pay(attempt.ref);
      const svc = t.app.get(ShopPaymentsService);
      // Too early: the shopper may still be on the way back.
      expect((await svc.sweep()).paid).toBe(0);
      const later = await svc.sweep(new Date(Date.now() + 5 * 60_000));
      expect(later.paid).toBeGreaterThanOrEqual(1);
      expect((await orderByNumber(placed.orderNumber)).payment).toMatchObject({ status: 'paid' });
      // Then the shopper's late return changes nothing.
      expect((await comeBack('bkash', attempt.ref)).searchParams.get('payment')).toBe('paid');
      expect((await orderByNumber(placed.orderNumber)).payment.paidMinor).toBe(162_000);

      // A cancel the browser reported is settled by asking the gateway later.
      const p2 = await checkout({ method: 'online', gateway: 'aamarpay' });
      const a2 = fake.last('aamarpay');
      await comeBack('aamarpay', a2.ref, 'cancelled');
      fake.pay(a2.ref);
      await svc.sweep(new Date(Date.now() + 5 * 60_000));
      expect((await orderByNumber(p2.orderNumber)).payment).toMatchObject({ status: 'paid' });

      // Two days later an attempt nobody finished is given up.
      const p3 = await checkout({ method: 'online', gateway: 'sslcommerz' });
      await svc.sweep(new Date(Date.now() + 3 * 86_400_000));
      expect((await orderByNumber(p3.orderNumber)).payment.online?.status).toBe('failed');
    });

    it('keeps the order when the gateway cannot start, and shows it to the business', async () => {
      fake.failNextStart = true;
      const placed = await checkout({ method: 'online', gateway: 'shurjopay' });
      expect(placed.payment).toMatchObject({ redirectUrl: null });
      expect(placed.payment!.error).toContain('shurjoPay could not start the payment');
      const { accounts } = (await O().get(url('/shop-payments')).expect(200)).body as {
        accounts: Account[];
      };
      expect(accounts.find((a) => a.gateway === 'shurjopay')!.lastError?.message).toBeTruthy();
      expect((await receipt(placed.receipt)).payment.payNow?.amountMinor).toBe(162_000);
      // The next start that works clears it.
      await shop('post', '/orders/pay')
        .send({ receipt: placed.receipt, gateway: 'shurjopay' })
        .expect(200);
      const after = (await O().get(url('/shop-payments')).expect(200)).body as {
        accounts: Account[];
      };
      expect(after.accounts.find((a) => a.gateway === 'shurjopay')!.lastError).toBeNull();
    });

    it('offers no gateway that is switched off, and an unknown reference is not found', async () => {
      const { accounts } = (await O().get(url('/shop-payments')).expect(200)).body as {
        accounts: Account[];
      };
      const nagad = accounts.find((a) => a.gateway === 'nagad')!;
      await O()
        .patch(url(`/shop-payments/accounts/${nagad.id}`))
        .send({ enabled: false })
        .expect(200);
      await checkout({ method: 'online', gateway: 'nagad' }, { expect: 422 });
      await O()
        .patch(url(`/shop-payments/accounts/${nagad.id}`))
        .send({ enabled: true })
        .expect(200);
      await t.http().get('/v1/shop-payments/SPAAAAAAAAAAAAAA/return/done').expect(404);
      await t
        .http()
        .get('/v1/shop-payments/not-a-ref/return/done')
        .expect((r) => expect([400, 404, 422]).toContain(r.status));
      // Another business cannot read this order's attempts.
      const any = await orderByNumber((await checkout(undefined, { zoneId: 'dhaka' })).orderNumber);
      await t
        .as(other.token)
        .get(`/v1/orgs/${otherOrgId}/orders/${any.id}/online-payments`)
        .expect(404);
    });

    it('refuses to remove a gateway while its payments are still being checked', async () => {
      await checkout({ method: 'online', gateway: 'aamarpay' });
      const { accounts } = (await O().get(url('/shop-payments')).expect(200)).body as {
        accounts: Account[];
      };
      const aamar = accounts.find((a) => a.gateway === 'aamarpay')!;
      const res = await O()
        .delete(url(`/shop-payments/accounts/${aamar.id}`))
        .expect(409);
      expect(res.body.code).toBe('payment_account_in_use');
    });
  });
  describe('paying on a landing page', () => {
    it('shows the options on the page and sends the shopper back to its thank-you page', async () => {
      await t
        .as(platform)
        .patch('/v1/platform/settings')
        .send({ stores: { autoApproveLandingPages: true } })
        .expect(200);
      const page = (
        await O()
          .post(url('/landing-pages'))
          .send({
            storeId,
            name: 'Panjabi Eid offer',
            productId: panjabi.id,
            template: 'quick_order',
          })
          .expect(201)
      ).body as { id: string; slug: string };
      await O()
        .post(url(`/landing-pages/${page.id}/submit`))
        .expect(200);
      const lp = (method: 'get' | 'post', path: string, from = '203.0.113.220') =>
        t
          .http()
          [method](`/v1/storefront/landing-pages/${page.slug}${path}`)
          .set('x-storefront-key', key)
          .set('x-store-host', host)
          .set('x-shopper-ip', from);
      const view = (await lp('get', '').expect(200)).body as {
        packages: { id: string }[];
        payments: {
          cod: boolean;
          fullOnline: boolean;
          gateways: { key: string }[];
          advance: { mode: string; zoneIds: string[] } | null;
        };
      };
      expect(view.payments).toMatchObject({
        cod: true,
        fullOnline: true,
        advance: { mode: 'delivery', zoneIds: ['outside'] },
      });
      expect(view.payments.gateways.map((g) => g.key)).toContain('bkash');
      const who = shopper();
      const body = {
        packageId: view.packages[0]?.id ?? null,
        variantId: panjabi.variants[0]!.id,
        quantity: 1,
        addOn: false,
        customer: { name: 'Nasrin Sultana', phone: who.phone },
        address: { line1: 'Flat 3B, Road 11', city: 'Khulna' },
        zoneId: 'outside',
      };
      // Outside Dhaka the advance must be paid online.
      await lp('post', '/orders', who.ip)
        .set('idempotency-key', `lp-${Date.now()}-a-abcdef`)
        .send({ ...body, payment: { method: 'cod' } })
        .expect(422);
      const placed = (
        await lp('post', '/orders', who.ip)
          .set('idempotency-key', `lp-${Date.now()}-b-abcdef`)
          .send({ ...body, payment: { method: 'cod', gateway: 'bkash' } })
          .expect(201)
      ).body as Placed;
      expect(placed.payment).toMatchObject({ gateway: 'bkash', amountMinor: 12_000, error: null });
      const attempt = fake.last('bkash');
      fake.pay(attempt.ref);
      const back = await comeBack('bkash', attempt.ref);
      expect(back.pathname).toBe(`/${page.slug}/thanks`);
      expect(back.searchParams.get('receipt')).toBe(placed.receipt);
      expect(back.searchParams.get('payment')).toBe('paid');
      const thanks = (
        await lp('get', `/receipt?receipt=${encodeURIComponent(placed.receipt)}`).expect(200)
      ).body as {
        order: { payment: { status: string; paidMinor: number; online: { purpose: string } } };
      };
      expect(thanks.order.payment).toMatchObject({
        status: 'partial',
        paidMinor: 12_000,
        online: { purpose: 'advance' },
      });
    });
  });
});
