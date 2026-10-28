import { getQueueToken } from '@nestjs/bullmq';
import { Worker, type Job, type Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { ParcelsService, type CourierJob } from '../../src/modules/couriers/parcels.service.js';
import { CouriersProcessor } from '../../src/workers/couriers.processor.js';
import { FakeCouriers, PATHAO_SANDBOX } from '../helpers/fake-couriers.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface AccountDto {
  id: string;
  provider: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  status: string;
  statusReason: string | null;
  sandbox: boolean;
  credentialsHint: string;
  settings: { deliveryType: string | null; storeId: string | null; storeName: string | null };
  webhook: { url: string; secret: string | null; auth: string };
}

interface ParcelDto {
  id: string;
  orderId: string;
  invoice: string;
  attempt: number;
  status: string;
  current: boolean;
  providerStatus: string | null;
  consignmentId: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  codMinor: number;
  weightGrams: number;
  error: string | null;
  attention: string | null;
  events: { status: string; source: string; providerStatus: string | null; note: string | null }[];
  actions: { refresh: boolean; cancel: boolean; link: boolean; dismiss: boolean };
}

interface OrderDto {
  id: string;
  number: string;
  customerId: string;
  status: string;
  totalMinor: number;
  editable: boolean;
  allowedTransitions: string[];
  shipment: {
    parcelId: string;
    status: string;
    accountName: string;
    consignmentId: string | null;
    attention: string | null;
  } | null;
  history: { status: string; note: string | null; actor: { type: string; id: string } }[];
}

const STEADFAST = { apiKey: 'sf-api-key-0001', secretKey: 'sf-secret-key-0001' };
const PATHAO = {
  clientId: 'pathao-client-1',
  clientSecret: 'pathao-client-secret-1',
  username: 'shop@example.com',
  password: 'pathao-password-1',
};
const REDX_TOKEN = 'redx-token-abcdefghijklmnopqrstuvwxyz';

describe('Couriers: accounts, booking, tracking', () => {
  const couriers = new FakeCouriers();
  let t: TestApp;
  let owner: Session;
  let fulfillment: Session;
  let agent: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let platform: string;
  let productId: string;
  let variantId: string;
  let steadfast: AccountDto;
  let pathao: AccountDto;
  let redx: AccountDto;

  const O = () => t.as(owner.token);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const queue = () => t.app.get<Queue<CourierJob>>(getQueueToken(QUEUES.couriers));
  const parcels = () => t.app.get(ParcelsService);
  const inTenant = <T>(fn: () => Promise<T>, org = orgId) =>
    RequestContext.withTenant(org, fn, { type: 'system', id: 'test' });

  /** Runs queued courier jobs the way the worker does; returns their names and results. */
  const runJobs = async () => {
    const processor = new CouriersProcessor(parcels(), queue());
    const done: { name: string; result: unknown }[] = [];
    for (let round = 0; round < 3; round += 1) {
      const jobs = await queue().getJobs(['waiting', 'delayed', 'prioritized']);
      if (!jobs.length) break;
      for (const job of jobs) {
        done.push({ name: job.name, result: await processor.process(job as Job<CourierJob>) });
        await job.remove();
      }
    }
    return done;
  };

  let phoneSeq = 0;
  const createOrder = async (
    extra: Record<string, unknown> = {},
    shipping: Record<string, unknown> = {},
  ): Promise<OrderDto> => {
    phoneSeq += 1;
    const res = await O()
      .post(url('/orders'))
      .send({
        customer: { name: `Rahim ${phoneSeq}`, phone: `0171${String(2_000_000 + phoneSeq)}` },
        shippingAddress: {
          line1: 'House 12, Road 5',
          area: 'Dhanmondi',
          city: 'Dhaka',
          ...shipping,
        },
        items: [{ productId, variantId, quantity: 2 }],
        ...extra,
      })
      .expect(201);
    return res.body as OrderDto;
  };
  const getOrder = async (id: string) =>
    (
      await O()
        .get(url(`/orders/${id}`))
        .expect(200)
    ).body as OrderDto;
  const orderParcels = async (id: string) =>
    (
      await O()
        .get(url(`/orders/${id}/parcels`))
        .expect(200)
    ).body.items as ParcelDto[];
  const book = (orderId: string, body: Record<string, unknown> = {}) =>
    O()
      .post(url(`/orders/${orderId}/parcels`))
      .send(body);
  const connect = (body: Record<string, unknown>, as = owner) =>
    t.as(as.token).post(url('/couriers/accounts')).send(body);
  const webhook = (key: string) => t.http().post(`/v1/webhooks/couriers/${key}`);
  const webhookKey = (a: AccountDto) => a.webhook.url.split('/').pop()!;

  beforeAll(async () => {
    couriers.steadfastAccounts.set(STEADFAST.apiKey, {
      secretKey: STEADFAST.secretKey,
      balance: 1520,
    });
    couriers.pathaoClients.push({
      ...PATHAO,
      stores: [
        { store_id: 7001, store_name: 'Dhanmondi warehouse', store_address: 'Road 27, Dhaka' },
      ],
    });
    couriers.redxTokens.set(REDX_TOKEN, [
      { id: 501, name: 'Main store', address: 'Mohammadpur' },
      { id: 502, name: 'Second store', address: 'Uttara' },
    ]);
    t = await TestApp.create({}, { courierFetch: couriers.fetch });
    platform = (await t.platformOwner()).token;
    owner = await t.registerUser();
    orgId = (await t.createOrg(owner)).id;
    fulfillment = await t.addMember(owner, orgId, 'fulfillment');
    agent = await t.addMember(owner, orgId, 'sales_agent');
    rival = await t.registerUser();
    rivalOrgId = (await t.createOrg(rival)).id;
    const product = await O()
      .post(url('/products'))
      .send({
        name: 'Red saree',
        variants: [{ priceMinor: 125_000, stock: 500, weightGrams: 400 }],
      })
      .expect(201);
    productId = product.body.id as string;
    variantId = product.body.variants[0].id as string;
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    couriers.reset();
  });

  describe('accounts', () => {
    it('checks credentials with the courier before saving, and never returns them', async () => {
      const wrong = await connect({
        provider: 'steadfast',
        name: 'Steadfast',
        credentials: { apiKey: STEADFAST.apiKey, secretKey: 'not-the-secret-key' },
      }).expect(422);
      expect(wrong.body).toMatchObject({ code: 'courier_check_failed' });
      expect(wrong.body.detail).toContain('Steadfast did not accept the API credentials');
      expect(await t.db.collection('courieraccounts').countDocuments({})).toBe(0);

      const res = await connect({
        provider: 'steadfast',
        name: 'Steadfast main',
        credentials: STEADFAST,
      }).expect(201);
      steadfast = res.body.account as AccountDto;
      expect(res.body.check).toMatchObject({
        ok: true,
        summary: 'Connected. Steadfast balance: ৳1520.',
      });
      expect(steadfast).toMatchObject({
        provider: 'steadfast',
        isDefault: true,
        enabled: true,
        status: 'active',
        credentialsHint: 'API key …0001',
        webhook: { auth: 'bearer' },
      });
      expect(steadfast.webhook.url).toMatch(/\/v1\/webhooks\/couriers\/cw_[A-Za-z0-9_-]{32}$/);
      expect(steadfast.webhook.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(JSON.stringify(res.body)).not.toContain(STEADFAST.secretKey);

      // Stored encrypted: neither key appears in the database document.
      const raw = await t.db.collection('courieraccounts').findOne({});
      expect(JSON.stringify(raw)).not.toContain(STEADFAST.secretKey);
      expect(JSON.stringify(raw)).not.toContain(STEADFAST.apiKey);
      expect(raw!.credentialsEnc).toMatch(/^v1\./);
    });

    it('connects Pathao and RedX, picking the only pickup store automatically', async () => {
      const bad = await connect({
        provider: 'pathao',
        name: 'Pathao',
        credentials: STEADFAST,
      }).expect(422);
      expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(
        expect.arrayContaining(['credentials.clientId', 'credentials.username']),
      );
      await connect({
        provider: 'steadfast',
        name: 'Sandbox?',
        credentials: STEADFAST,
        sandbox: true,
      }).expect(422);
      const wrong = await connect({
        provider: 'pathao',
        name: 'Pathao',
        credentials: { ...PATHAO, password: 'wrong-password' },
      }).expect(422);
      expect(wrong.body.detail).toContain('Pathao did not accept the API credentials');

      const p = await connect({ provider: 'pathao', name: 'Pathao', credentials: PATHAO }).expect(
        201,
      );
      pathao = p.body.account as AccountDto;
      expect(p.body.check.stores).toEqual([
        { id: '7001', name: 'Dhanmondi warehouse', address: 'Road 27, Dhaka' },
      ]);
      expect(pathao).toMatchObject({
        isDefault: false,
        credentialsHint: PATHAO.username,
        settings: { storeId: '7001', storeName: 'Dhanmondi warehouse' },
        webhook: { auth: 'secret_header' },
      });

      const r = await connect({
        provider: 'redx',
        name: 'RedX',
        credentials: { accessToken: REDX_TOKEN },
      }).expect(201);
      redx = r.body.account as AccountDto;
      // Two stores: RedX's own default is used until one is chosen.
      expect(r.body.check.stores).toHaveLength(2);
      expect(redx.settings.storeId).toBeNull();
      expect(redx.webhook.secret).toBeNull();
      expect(redx.credentialsHint).toBe('Token …wxyz');

      const list = await O().get(url('/couriers/accounts')).expect(200);
      expect(list.body.items.map((a: AccountDto) => a.name)).toEqual([
        'Steadfast main',
        'Pathao',
        'RedX',
      ]);
    });

    it('lets fulfillment staff see booking choices but not the accounts', async () => {
      const choices = await t.as(fulfillment.token).get(url('/couriers/choices')).expect(200);
      expect(choices.body.items).toEqual([
        expect.objectContaining({
          name: 'Steadfast main',
          isDefault: true,
          ready: true,
          location: 'none',
        }),
        expect.objectContaining({ name: 'Pathao', ready: true, location: 'city_zone_area' }),
        expect.objectContaining({
          name: 'RedX',
          ready: true,
          location: 'area',
          locationRequired: true,
        }),
      ]);
      expect(JSON.stringify(choices.body)).not.toContain('webhook');
      await t.as(fulfillment.token).get(url('/couriers/accounts')).expect(403);
      await t
        .as(fulfillment.token)
        .patch(url(`/couriers/accounts/${steadfast.id}`))
        .send({ name: 'x' })
        .expect(403);
      await t.as(agent.token).get(url('/couriers/choices')).expect(200);
      await t
        .as(agent.token)
        .post(url(`/orders/${steadfast.id}/parcels`))
        .send({})
        .expect(403);
    });

    it("keeps each business's accounts to itself", async () => {
      await t
        .as(rival.token)
        .get(url(`/couriers/accounts`, rivalOrgId))
        .expect(200)
        .expect(({ body }) => {
          expect(body.items).toEqual([]);
        });
      await t
        .as(rival.token)
        .patch(url(`/couriers/accounts/${steadfast.id}`, rivalOrgId))
        .send({ name: 'Mine' })
        .expect(404);
      // Not a member: the business does not exist as far as they can tell.
      await t.as(rival.token).get(url('/couriers/accounts', orgId)).expect(404);
      // Booking a rival order, or with another business's account, finds nothing.
      const rivalProduct = await t
        .as(rival.token)
        .post(url('/products', rivalOrgId))
        .send({ name: 'Panjabi', variants: [{ priceMinor: 90_000, stock: 10 }] })
        .expect(201);
      const rivalOrder = await t
        .as(rival.token)
        .post(url('/orders', rivalOrgId))
        .send({
          customer: { name: 'Karim', phone: '01812345678' },
          shippingAddress: { line1: 'House 1, Mirpur 10', city: 'Dhaka' },
          items: [
            {
              productId: rivalProduct.body.id,
              variantId: rivalProduct.body.variants[0].id,
              quantity: 1,
            },
          ],
        })
        .expect(201);
      await t
        .as(rival.token)
        .post(url(`/orders/${rivalOrder.body.id as string}/parcels`, rivalOrgId))
        .send({ accountId: steadfast.id })
        .expect(404)
        .expect(({ body }) => expect(body.code).toBe('courier_account_not_found'));
      await book(rivalOrder.body.id as string).expect(404);
    });

    it('updates settings, checks new credentials and makes another account the default', async () => {
      await O()
        .patch(url(`/couriers/accounts/${pathao.id}`))
        .send({ settings: { deliveryType: 'express' } })
        .expect(422);
      await O()
        .patch(url(`/couriers/accounts/${redx.id}`))
        .send({ settings: { storeId: '502' } })
        .expect(200)
        .expect(({ body }) =>
          expect(body.account.settings).toMatchObject({
            storeId: '502',
            storeName: 'Second store',
          }),
        );
      // A store is checked with the courier before it is saved.
      await O()
        .patch(url(`/couriers/accounts/${redx.id}`))
        .send({ settings: { storeId: '999' } })
        .expect(422)
        .expect(({ body }) => expect(body.errors[0]).toMatchObject({ path: 'settings.storeId' }));
      // Settings merge: changing the delivery type keeps the chosen pickup store.
      await O()
        .patch(url(`/couriers/accounts/${pathao.id}`))
        .send({ settings: { deliveryType: 'on_demand' } })
        .expect(200)
        .expect(({ body }) =>
          expect(body.account.settings).toEqual({
            deliveryType: 'on_demand',
            storeId: '7001',
            storeName: 'Dhanmondi warehouse',
          }),
        );
      await O()
        .patch(url(`/couriers/accounts/${pathao.id}`))
        .send({ settings: { deliveryType: 'normal' } })
        .expect(200);
      // null clears a setting (RedX then uses its own default store).
      await O()
        .patch(url(`/couriers/accounts/${redx.id}`))
        .send({ settings: { storeId: null } })
        .expect(200)
        .expect(({ body }) => expect(body.account.settings.storeId).toBeNull());
      await O()
        .patch(url(`/couriers/accounts/${redx.id}`))
        .send({ settings: { storeId: '502' } })
        .expect(200);
      await O()
        .patch(url(`/couriers/accounts/${steadfast.id}`))
        .send({ credentials: { apiKey: STEADFAST.apiKey, secretKey: 'changed-but-wrong' } })
        .expect(422);
      const made = await O()
        .patch(url(`/couriers/accounts/${pathao.id}`))
        .send({ isDefault: true })
        .expect(200);
      expect(made.body.account.isDefault).toBe(true);
      const list = (await O().get(url('/couriers/accounts')).expect(200)).body
        .items as AccountDto[];
      expect(list.filter((a) => a.isDefault).map((a) => a.name)).toEqual(['Pathao']);
      await O()
        .patch(url(`/couriers/accounts/${steadfast.id}`))
        .send({ isDefault: true })
        .expect(200);
    });
  });

  describe('booking with Steadfast', () => {
    it('books a confirmed order and follows it to delivery', async () => {
      const order = await createOrder();
      const res = await book(order.id, { note: 'Call before delivery' }).expect(201);
      const parcel = res.body as ParcelDto;
      const sent = couriers.bookings('steadfast')[0]!;
      expect(sent.body).toEqual({
        invoice: order.number,
        recipient_name: expect.stringMatching(/^Rahim/),
        recipient_phone: expect.stringMatching(/^01712\d{6}$/),
        recipient_address: 'House 12, Road 5, Dhanmondi, Dhaka',
        cod_amount: order.totalMinor / 100,
        note: 'Call before delivery',
        item_description: '2 × Red saree',
        total_lot: 2,
        delivery_type: 0,
      });
      expect(parcel).toMatchObject({
        invoice: order.number,
        attempt: 1,
        status: 'booked',
        current: true,
        providerStatus: 'in_review',
        codMinor: order.totalMinor,
        weightGrams: 800,
      });
      const fake = couriers.parcels.find((p) => p.invoice === order.number)!;
      expect(parcel.consignmentId).toBe(fake.id);
      expect(parcel.trackingUrl).toBe(`https://steadfast.com.bd/t/${fake.trackingCode}`);

      let o = await getOrder(order.id);
      expect(o.status).toBe('confirmed');
      expect(o.shipment).toMatchObject({
        status: 'booked',
        accountName: 'Steadfast main',
        consignmentId: fake.id,
      });
      // The order says so, so the app hides cancel and edit.
      expect(o.editable).toBe(false);
      expect(o.allowedTransitions).not.toContain('cancelled');

      // Nothing can change under a booked parcel.
      await book(order.id)
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe('parcel_exists'));
      const cancel = await O()
        .post(url(`/orders/${order.id}/cancel`))
        .send({})
        .expect(409);
      expect(cancel.body).toMatchObject({ code: 'parcel_booked' });
      expect(cancel.body.detail).toContain(`booked with Steadfast main (consignment ${fake.id})`);
      await O()
        .put(url(`/orders/${order.id}/items`))
        .send({ items: [{ productId, variantId, quantity: 1 }] })
        .expect(409);

      // The courier picks it up: the order ships.
      couriers.setStatus(fake.id, 'pending');
      const checked = await O()
        .post(url(`/parcels/${parcel.id}/refresh`))
        .expect(200);
      expect(checked.body).toMatchObject({ status: 'in_transit', providerStatus: 'pending' });
      o = await getOrder(order.id);
      expect(o.status).toBe('shipped');
      expect(o.history.at(-1)!.note).toContain('Steadfast main: pending');
      await O()
        .post(url(`/parcels/${parcel.id}/refresh`))
        .expect(429);

      // A webhook only makes Sellora ask: its body is not believed.
      await webhook(webhookKey(steadfast))
        .set('authorization', `Bearer ${steadfast.webhook.secret}`)
        .send({
          notification_type: 'delivery_status',
          consignment_id: Number(fake.id),
          invoice: order.number,
          status: 'delivered',
          cod_amount: 0,
        })
        .expect(200)
        .expect(({ body }) => expect(body).toEqual({ ok: true, parcels: 1 }));
      await runJobs();
      expect((await orderParcels(order.id))[0]!.status).toBe('in_transit');

      // When the courier really delivers, the next check moves the order.
      couriers.setStatus(fake.id, 'delivered');
      await webhook(webhookKey(steadfast))
        .set('authorization', `Bearer ${steadfast.webhook.secret}`)
        .send({ consignment_id: Number(fake.id), status: 'delivered' })
        .expect(200);
      const jobs = await runJobs();
      expect(jobs).toEqual([{ name: 'check', result: { status: 'delivered' } }]);
      o = await getOrder(order.id);
      expect(o.status).toBe('delivered');
      expect(o.history.at(-1)).toMatchObject({
        status: 'delivered',
        note: 'Delivered by Steadfast main',
      });
      expect(o.shipment!.status).toBe('delivered');
      const [final] = await orderParcels(order.id);
      expect(final!.events.map((e) => [e.status, e.source])).toEqual([
        ['queued', 'booking'],
        ['sending', 'booking'],
        ['booked', 'booking'],
        ['in_transit', 'staff'],
        ['delivered', 'webhook'],
      ]);
      expect(final!.actions).toEqual({
        refresh: false,
        cancel: false,
        link: false,
        dismiss: false,
      });
      const customer = await O()
        .get(url(`/customers/${o.customerId}`))
        .expect(200);
      expect(customer.body.stats.delivered).toBe(1);
    });

    it('follows each webhook, also one that comes right after a finished check', async () => {
      const order = await createOrder();
      await book(order.id).expect(201);
      const fake = couriers.parcels.find((p) => p.invoice === order.number)!;
      // A real worker, which keeps finished jobs (unlike runJobs, which removes them).
      const processor = new CouriersProcessor(parcels(), queue());
      const worker = new Worker<CourierJob>(QUEUES.couriers, (job) => processor.process(job), {
        connection: queue().opts.connection,
        prefix: queue().opts.prefix,
      });
      const settle = async () => {
        for (const job of await queue().getJobs(['delayed'])) await job.promote();
        await vi.waitFor(
          async () => {
            const counts = await queue().getJobCounts('waiting', 'delayed', 'active');
            expect(counts).toEqual({ waiting: 0, delayed: 0, active: 0 });
          },
          { timeout: 10_000, interval: 100 },
        );
      };
      const send = () =>
        webhook(webhookKey(steadfast))
          .set('authorization', `Bearer ${steadfast.webhook.secret}`)
          .send({ consignment_id: Number(fake.id) })
          .expect(200);
      try {
        couriers.setStatus(fake.id, 'pending');
        await send();
        await send(); // folds into the waiting check
        expect(await queue().getJobCounts('delayed')).toEqual({ delayed: 1 });
        await settle();
        expect((await orderParcels(order.id))[0]!.status).toBe('in_transit');
        couriers.setStatus(fake.id, 'delivered');
        await send();
        await settle();
        expect((await orderParcels(order.id))[0]!.status).toBe('delivered');
        expect((await getOrder(order.id)).status).toBe('delivered');
      } finally {
        await worker.close();
        await queue().clean(0, 1_000, 'completed');
      }
    });

    it('refuses webhooks without the secret', async () => {
      await webhook(webhookKey(steadfast)).send({ consignment_id: 1 }).expect(401);
      await webhook(webhookKey(steadfast))
        .set('authorization', 'Bearer wrong')
        .send({})
        .expect(401);
      await webhook(`cw_${'x'.repeat(32)}`)
        .send({})
        .expect(404);
      await webhook('not-a-key').send({}).expect(422);
    });

    it('shows the courier’s reason when it refuses a booking, and books again after a fix', async () => {
      const order = await createOrder({}, { line1: 'REJECT this address please' });
      const res = await book(order.id).expect(422);
      expect(res.body).toMatchObject({
        code: 'courier_refused',
        detail: 'Steadfast: The recipient address is invalid.',
      });
      let [failed] = await orderParcels(order.id);
      expect(failed).toMatchObject({
        status: 'failed',
        current: false,
        error: 'Steadfast: The recipient address is invalid.',
      });
      expect((await getOrder(order.id)).shipment!.status).toBe('failed');

      await O()
        .patch(url(`/orders/${order.id}`))
        .send({ shippingAddress: { line1: 'House 9, Road 2', city: 'Dhaka' } })
        .expect(200);
      const again = await book(order.id).expect(201);
      expect(again.body).toMatchObject({
        invoice: `${order.number}-2`,
        attempt: 2,
        status: 'booked',
      });
      [, failed] = await orderParcels(order.id);
      expect(failed!.status).toBe('failed');
      expect((await getOrder(order.id)).shipment!.parcelId).toBe(again.body.id);
    });

    it('checks the order before calling the courier', async () => {
      const pending = await createOrder({ status: 'pending' });
      await book(pending.id)
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe('order_not_ready_for_courier'));
      const noPhone = await O()
        .post(url('/orders'))
        .send({
          customer: { name: 'No phone' },
          shippingAddress: { line1: 'House 3, Banani', city: 'Dhaka' },
          items: [{ productId, variantId, quantity: 1 }],
        })
        .expect(201);
      await book(noPhone.body.id as string)
        .expect(422)
        .expect(({ body }) => expect(body.code).toBe('courier_phone_invalid'));
      const order = await createOrder();
      await book(order.id, { codMinor: 12_350 })
        .expect(422)
        .expect(({ body }) => expect(body.code).toBe('cod_not_whole_taka'));
      await book(order.id, { codMinor: 0 })
        .expect(201)
        .expect(({ body }) => expect(body.codMinor).toBe(0));
      expect(couriers.bookings('steadfast')).toHaveLength(1);
    });

    it('never books twice after a lost reply, and finds the booking by invoice', async () => {
      const order = await createOrder();
      couriers.failNextBooking('steadfast', 'lose-reply');
      const res = await book(order.id).expect(201);
      expect(res.body).toMatchObject({ status: 'sending', current: true, consignmentId: null });
      expect(res.body.attention).toContain('Sellora is checking whether the booking went through');
      await book(order.id).expect(409);
      await O()
        .post(url(`/orders/${order.id}/cancel`))
        .send({})
        .expect(409);

      const found = await inTenant(() => parcels().check(res.body.id as string, 'poll'));
      expect(found).toMatchObject({ status: 'booked', providerStatus: 'in_review', current: true });
      expect(found.attention).toBeUndefined();
      expect(couriers.bookings('steadfast')).toHaveLength(1);

      // Tracking goes on by invoice, as Steadfast gave no consignment id.
      couriers.setStatus(order.number, 'pending');
      await inTenant(() => parcels().check(res.body.id as string, 'poll'));
      expect((await getOrder(order.id)).status).toBe('shipped');
    });

    it('concludes a booking never arrived when the courier has no such invoice', async () => {
      const order = await createOrder();
      couriers.failNextBooking('steadfast', 'timeout');
      const res = await book(order.id).expect(201);
      expect(res.body.status).toBe('sending');
      // Too soon to tell: ask again later.
      let p = await inTenant(() => parcels().check(res.body.id as string, 'poll'));
      expect(p.status).toBe('sending');
      await t.db
        .collection('parcels')
        .updateOne({ _id: p._id }, { $set: { sendStartedAt: new Date(Date.now() - 11 * 60_000) } });
      p = await inTenant(() => parcels().check(res.body.id as string, 'poll'));
      expect(p).toMatchObject({ status: 'failed', current: false });
      expect(p.error).toContain(`has no booking with invoice ${order.number}`);
      await book(order.id)
        .expect(201)
        .expect(({ body }) => expect(body.invoice).toBe(`${order.number}-2`));
    });

    it('marks the account when Steadfast stops accepting the credentials', async () => {
      const order = await createOrder();
      couriers.steadfastAccounts.get(STEADFAST.apiKey)!.secretKey = 'rotated-on-steadfast';
      const res = await book(order.id).expect(422);
      expect(res.body.detail).toContain('Steadfast did not accept the API credentials');
      let account = (
        (await O().get(url('/couriers/accounts')).expect(200)).body.items as AccountDto[]
      ).find((a) => a.id === steadfast.id)!;
      expect(account).toMatchObject({ status: 'error' });
      couriers.steadfastAccounts.get(STEADFAST.apiKey)!.secretKey = STEADFAST.secretKey;
      const check = await O()
        .post(url(`/couriers/accounts/${steadfast.id}/check`))
        .expect(200);
      expect(check.body.check.ok).toBe(true);
      account = check.body.account as AccountDto;
      expect(account.status).toBe('active');
    });
  });

  describe('booking with Pathao', () => {
    it('books with the pickup store and location, reusing and renewing the token', async () => {
      const cities = await O()
        .get(url(`/couriers/accounts/${pathao.id}/locations?kind=city`))
        .expect(200);
      expect(cities.body.items).toEqual([
        { id: 1, name: 'Dhaka' },
        { id: 2, name: 'Chattogram' },
      ]);
      const zones = await t
        .as(fulfillment.token)
        .get(url(`/couriers/accounts/${pathao.id}/locations?kind=zone&parent=1`))
        .expect(200);
      expect(zones.body.items.map((z: { name: string }) => z.name)).toEqual([
        'Dhanmondi',
        'Mirpur',
      ]);
      const areas = await O()
        .get(url(`/couriers/accounts/${pathao.id}/locations?kind=area&parent=11&q=jiga`))
        .expect(200);
      expect(areas.body.items).toEqual([{ id: 112, name: 'Jigatola', hint: 'No home delivery' }]);

      const issued = couriers.pathaoTokensIssued;
      const order = await createOrder();
      const res = await book(order.id, {
        accountId: pathao.id,
        location: {
          cityId: 1,
          cityName: 'Dhaka',
          zoneId: 11,
          zoneName: 'Dhanmondi',
          areaId: 111,
          areaName: 'Road 27',
        },
      }).expect(201);
      expect(couriers.pathaoTokensIssued).toBe(issued);
      expect(couriers.bookings('pathao')[0]!.body).toMatchObject({
        store_id: 7001,
        merchant_order_id: order.number,
        recipient_city: 1,
        recipient_zone: 11,
        recipient_area: 111,
        delivery_type: 48,
        item_type: 2,
        item_quantity: 2,
        item_weight: 0.8,
        amount_to_collect: order.totalMinor / 100,
      });
      expect(res.body).toMatchObject({ status: 'booked', providerStatus: 'Pending' });
      expect(res.body.trackingUrl).toContain(`consignment_id=${res.body.consignmentId as string}`);

      // An expired token is renewed once and the call goes through.
      couriers.expirePathaoTokens();
      couriers.setStatus(res.body.consignmentId as string, 'Picked');
      await t
        .as(fulfillment.token)
        .post(url(`/parcels/${res.body.id as string}/refresh`))
        .expect(200)
        .expect(({ body }) => expect(body.status).toBe('picked_up'));
      expect(couriers.pathaoTokensIssued).toBe(issued + 1);
      expect((await getOrder(order.id)).status).toBe('shipped');
    });

    it('answers Pathao’s webhook check and follows a pickup cancellation', async () => {
      const key = webhookKey(pathao);
      await webhook(key).send({ event: 'webhook_integration' }).expect(401);
      const handshake = await webhook(key)
        .set('x-pathao-signature', pathao.webhook.secret!)
        .send({ event: 'webhook_integration' })
        .expect(202);
      expect(handshake.headers['x-pathao-merchant-webhook-integration-secret']).toBe(
        pathao.webhook.secret,
      );

      const order = await createOrder();
      const booked = (await book(order.id, { accountId: pathao.id }).expect(201)).body as ParcelDto;
      couriers.setStatus(booked.consignmentId!, 'Pickup_Cancelled');
      await webhook(key)
        .set('x-pathao-signature', pathao.webhook.secret!)
        .send({
          consignment_id: booked.consignmentId,
          merchant_order_id: order.number,
          event: 'order.pickup-cancelled',
        })
        .expect(202);
      await runJobs();
      const [p] = await orderParcels(order.id);
      expect(p).toMatchObject({ status: 'cancelled', current: false });
      expect(p!.attention).toContain('cancelled the booking before pickup');
      const o = await getOrder(order.id);
      expect(o.status).toBe('confirmed');
      expect(o.shipment).toMatchObject({ status: 'cancelled' });
      // Not tied up any more: the order can be cancelled or booked again.
      await book(order.id, { accountId: pathao.id }).expect(201);
    });

    it('leaves a lost Pathao reply to staff, who link the consignment or mark it not booked', async () => {
      const a = await createOrder();
      couriers.failNextBooking('pathao', 'lose-reply');
      const lost = (await book(a.id, { accountId: pathao.id }).expect(201)).body as ParcelDto;
      expect(lost.status).toBe('sending');
      expect(lost.attention).toContain(`Look for invoice ${a.number} in the Pathao panel`);
      expect(lost.actions).toMatchObject({ link: true, cancel: true });
      // Pathao cannot be asked by invoice, so tracking leaves it alone.
      const same = await inTenant(() => parcels().check(lost.id, 'poll'));
      expect(same.status).toBe('sending');
      const made = couriers.parcels.find((p) => p.invoice === a.number)!;
      const linked = await O()
        .post(url(`/parcels/${lost.id}/link`))
        .send({ consignmentId: made.id })
        .expect(200);
      expect(linked.body).toMatchObject({
        status: 'booked',
        consignmentId: made.id,
        attention: null,
      });
      expect(await runJobs()).toEqual([{ name: 'check', result: { status: 'booked' } }]);

      const b = await createOrder();
      couriers.failNextBooking('pathao', 'network');
      const lost2 = (await book(b.id, { accountId: pathao.id }).expect(201)).body as ParcelDto;
      await O()
        .post(url(`/parcels/${lost2.id}/cancel`))
        .send({})
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ status: 'cancelled', current: false }));
      expect((await orderParcels(b.id))[0]!.events.at(-1)).toMatchObject({
        source: 'staff',
        note: 'Marked not booked',
      });
      await O()
        .post(url(`/orders/${b.id}/cancel`))
        .send({ reason: 'Customer changed mind' })
        .expect(200);
    });
  });

  describe('booking with RedX', () => {
    it('needs a delivery area, and is followed by scheduled checks', async () => {
      const order = await createOrder();
      await book(order.id, { accountId: redx.id })
        .expect(422)
        .expect(({ body }) => expect(body.code).toBe('courier_location_required'));
      const areas = await O()
        .get(url(`/couriers/accounts/${redx.id}/locations?kind=area&q=dhan`))
        .expect(200);
      expect(areas.body.items).toEqual([{ id: 2, name: 'Dhanmondi', hint: 'Dhaka · 1209' }]);
      const res = await book(order.id, {
        accountId: redx.id,
        location: { areaId: 2, areaName: 'Dhanmondi' },
        weightGrams: 1500,
      }).expect(201);
      expect(couriers.bookings('redx')[0]!.body).toMatchObject({
        delivery_area: 'Dhanmondi',
        delivery_area_id: 2,
        merchant_invoice_id: order.number,
        cash_collection_amount: String(order.totalMinor / 100),
        parcel_weight: 1500,
        value: order.totalMinor / 100,
        pickup_store_id: 502,
      });
      const parcel = res.body as ParcelDto;
      expect(parcel.trackingUrl).toBe(
        `https://redx.com.bd/track-parcel/?trackingId=${parcel.trackingCode!}`,
      );

      // The schedule picks up parcels whose next check is due.
      couriers.setStatus(parcel.consignmentId!, 'agent-returning');
      await t.db
        .collection('parcels')
        .updateOne(
          { invoice: order.number },
          { $set: { nextCheckAt: new Date(Date.now() - 1000) } },
        );
      expect(await parcels().queueDueChecks()).toBeGreaterThanOrEqual(1);
      await runJobs();
      let [p] = await orderParcels(order.id);
      expect(p).toMatchObject({ status: 'returning' });
      expect(p!.attention).toContain('RedX is bringing the parcel back');
      expect((await getOrder(order.id)).status).toBe('shipped');

      // A status Sellora does not know is recorded and changes nothing.
      couriers.setStatus(parcel.consignmentId!, 'agent-teleported');
      await inTenant(() => parcels().check(parcel.id, 'poll'));
      [p] = await orderParcels(order.id);
      expect(p).toMatchObject({ status: 'returning', providerStatus: 'agent-teleported' });
      expect(p!.attention).toContain('reported "agent-teleported"');

      couriers.setStatus(parcel.consignmentId!, 'returned');
      await inTenant(() => parcels().check(parcel.id, 'poll'));
      [p] = await orderParcels(order.id);
      expect(p!.status).toBe('returned');
      expect(p!.attention).toContain('mark the order returned');
      expect((await getOrder(order.id)).shipment!.attention).toContain('mark the order returned');
      // Returns are left to staff (restocking needs a person); then the note goes away.
      expect((await getOrder(order.id)).status).toBe('shipped');
      await O()
        .post(url(`/orders/${order.id}/status`))
        .send({ status: 'returned', restock: true })
        .expect(200);
      await vi.waitFor(async () =>
        expect((await getOrder(order.id)).shipment!.attention).toBeNull(),
      );
      expect((await orderParcels(order.id))[0]!.attention).toBeNull();
    });
  });

  describe('bulk booking', () => {
    it('queues the orders that can go and explains the rest', async () => {
      const ok1 = await createOrder();
      const ok2 = await createOrder();
      const pending = await createOrder({ status: 'pending' });
      const booked = await createOrder();
      await book(booked.id).expect(201);
      const res = await t
        .as(fulfillment.token)
        .post(url('/parcels/bulk'))
        .send({ orderIds: [ok1.id, ok2.id, pending.id, booked.id] })
        .expect(202);
      expect(res.body.accountId).toBe(steadfast.id);
      expect(res.body.queued.map((q: { number: string }) => q.number)).toEqual([
        ok1.number,
        ok2.number,
      ]);
      expect(res.body.skipped).toEqual([
        {
          orderId: pending.id,
          number: pending.number,
          reason: expect.stringContaining('is pending'),
        },
        {
          orderId: booked.id,
          number: booked.number,
          reason: `${booked.number} is already booked with a courier.`,
        },
      ]);
      expect((await getOrder(ok1.id)).shipment!.status).toBe('queued');

      // One send job per order; a second run finds nothing to send.
      const jobs = await runJobs();
      expect(jobs).toEqual([
        { name: 'send', result: { status: 'booked' } },
        { name: 'send', result: { status: 'booked' } },
      ]);
      expect((await getOrder(ok2.id)).shipment!.status).toBe('booked');
      expect(couriers.bookings('steadfast')).toHaveLength(3);

      const viaRedx = await O()
        .post(url('/parcels/bulk'))
        .send({ orderIds: [ok1.id], accountId: redx.id })
        .expect(202);
      expect(viaRedx.body.queued).toEqual([]);
      expect(viaRedx.body.skipped[0].reason).toContain('RedX needs a delivery area');
    });

    it('does not send a queued parcel whose order was cancelled meanwhile', async () => {
      const order = await createOrder();
      const res = await O()
        .post(url('/parcels/bulk'))
        .send({ orderIds: [order.id] })
        .expect(202);
      await O()
        .post(url(`/parcels/${res.body.queued[0].parcelId as string}/cancel`))
        .send({})
        .expect(200);
      await O()
        .post(url(`/orders/${order.id}/cancel`))
        .send({})
        .expect(200);
      await runJobs();
      expect(couriers.bookings('steadfast')).toHaveLength(0);
      expect((await orderParcels(order.id))[0]!.status).toBe('cancelled');
    });
  });

  describe('account removal and plan', () => {
    it('keeps accounts with parcels on the way, and turned-off accounts cannot book', async () => {
      const onTheWay = await createOrder();
      await book(onTheWay.id, {
        accountId: redx.id,
        location: { areaId: 1, areaName: 'Mohammadpur' },
      }).expect(201);
      const del = await O()
        .delete(url(`/couriers/accounts/${redx.id}`))
        .expect(409);
      expect(del.body.code).toBe('courier_account_in_use');
      await O()
        .patch(url(`/couriers/accounts/${redx.id}`))
        .send({ enabled: false })
        .expect(200);
      const order = await createOrder();
      await book(order.id, { accountId: redx.id, location: { areaId: 2, areaName: 'Dhanmondi' } })
        .expect(422)
        .expect(({ body }) => expect(body.code).toBe('courier_account_disabled'));
    });

    it('summarises orders by courier status and lists those ready to send', async () => {
      const all = (await O().get(url('/orders?limit=100')).expect(200)).body.items as OrderDto[];
      expect(all.length).toBeLessThan(100);
      const summary = (await O().get(url('/parcels/summary')).expect(200)).body as {
        ready: number;
        attention: number;
        byStatus: Record<string, number>;
        withCouriers: { orders: number; toCollectMinor: number };
      };
      const tally: Record<string, number> = {};
      for (const o of all)
        if (o.shipment) tally[o.shipment.status] = (tally[o.shipment.status] ?? 0) + 1;
      for (const [status, n] of Object.entries(summary.byStatus))
        expect(n).toBe(tally[status] ?? 0);
      expect(summary.attention).toBe(all.filter((o) => o.shipment?.attention).length);

      const live = ['queued', 'sending', 'booked', 'picked_up', 'in_transit', 'on_hold'];
      const unbooked = (o: OrderDto) =>
        !o.shipment || ['failed', 'cancelled'].includes(o.shipment.status);
      const ready = all.filter((o) => ['confirmed', 'packed'].includes(o.status) && unbooked(o));
      expect(ready.length).toBeGreaterThan(0);
      expect(summary.ready).toBe(ready.length);
      const listed = (await O().get(url('/orders?shipment=ready&limit=100')).expect(200)).body
        .items as OrderDto[];
      expect(listed.map((o) => o.id).sort()).toEqual(ready.map((o) => o.id).sort());
      // With a status, the two filters narrow each other.
      const shippedReady = (await O().get(url('/orders?shipment=ready&status=shipped')).expect(200))
        .body.items as OrderDto[];
      expect(shippedReady).toEqual([]);

      const out = all.filter(
        (o) =>
          o.shipment &&
          live.includes(o.shipment.status) &&
          !['cancelled', 'returned', 'delivered'].includes(o.status),
      );
      expect(summary.withCouriers.orders).toBe(out.length);
    });

    it('answers 402 when the plan has no courier booking', async () => {
      await t
        .as(platform)
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ removeModules: ['couriers'], note: 'courier test' })
        .expect(200);
      await O().get(url('/couriers/accounts')).expect(402);
      const order = await createOrder();
      await book(order.id).expect(402);
      // The order itself still shows its parcel.
      expect((await getOrder(order.id)).shipment).toBeNull();
      await t
        .as(platform)
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ removeModules: [], note: 'courier test' })
        .expect(200);
      await O().get(url('/couriers/accounts')).expect(200);
    });
  });

  it('uses the sandbox address for sandbox accounts', async () => {
    const res = await connect({
      provider: 'pathao',
      name: 'Pathao test',
      credentials: PATHAO,
      sandbox: true,
    }).expect(201);
    expect(res.body.account.sandbox).toBe(true);
    expect(couriers.requests.map((r) => [r.base, r.path])).toEqual([
      [PATHAO_SANDBOX, '/aladdin/api/v1/issue-token'],
      [PATHAO_SANDBOX, '/aladdin/api/v1/stores'],
    ]);
  });
});
