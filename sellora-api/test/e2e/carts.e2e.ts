import { getQueueToken } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { RateLimitService } from '../../src/modules/auth/core/rate-limit.service.js';
import {
  ABANDONED_AFTER_MS,
  SAME_PHONE_GAP_MS,
  SMS_OFF_RETRY_MS,
  inQuietHours,
  quietHoursEnd,
} from '../../src/modules/carts/cart-templates.js';
import { CartsService } from '../../src/modules/carts/carts.service.js';
import { SmsService, type SmsJob } from '../../src/modules/sms/sms.service.js';
import { SmsProcessor } from '../../src/workers/sms.processor.js';
import { FakeSmsProviders } from '../helpers/fake-sms.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface CartDto {
  id: string;
  source: string;
  store: { id: string; name: string };
  customer: { name: string; phone: string };
  items: { productId: string; quantity: number; name: string; unitPriceMinor: number }[];
  totalMinor: number;
  status: string;
  state: string;
  link: string;
  nextReminderAt: string | null;
  lastSkip: { reason: string } | null;
  reminders: {
    step: number;
    manual: boolean;
    skipped: string | null;
    message: { id: string; status: string } | null;
  }[];
  manualRemindersLeft: number;
  clicks: number;
  order: { id: string; number: string; totalMinor: number } | null;
  recovered: boolean;
}

interface SettingsDto {
  enabled: boolean;
  language: string;
  steps: {
    step: number;
    enabled: boolean;
    delayMinutes: number;
    text: string;
    preview: { text: string; parts: number; priceMinor: number | null };
  }[];
  minTotalMinor: number;
  quietHours: { enabled: boolean; startHour: number; endHour: number };
  included: boolean;
  sms: { mode: string; ready: boolean };
  samples: Record<'en' | 'bn', Record<string, string>>;
  stopSuffix: Record<'en' | 'bn', string>;
}

const BULK_KEY = 'bulk-api-key-0001';
const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);
const token = () => `tok_${new Types.ObjectId().toHexString()}`;

describe('Abandoned carts: saving, reminders, the restore link and recovered orders', () => {
  const fake = new FakeSmsProviders();
  let t: TestApp;
  let platform: string;
  let owner: Session;
  let viewer: Session;
  let agent: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let key: string;
  let storeId: string;
  let saree: { id: string; variants: { id: string }[] };
  let shawl: { id: string; variants: { id: string }[] };
  let pot: { id: string; variants: { id: string }[] };

  const handle = 'nakshi-ghor';
  const host = `${handle}.shops.test`;
  const rivalHost = 'rival-bazar.shops.test';
  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const carts = () => t.app.get(CartsService);
  const smsQueue = () => t.app.get<Queue<SmsJob>>(getQueueToken(QUEUES.sms));
  const inTenant = <T>(fn: () => Promise<T>, org = orgId) =>
    RequestContext.withTenant(org, fn, { type: 'system', id: 'test' });

  /** A shop request as the storefront app makes it. */
  const shop = (method: 'get' | 'post', path: string, h = host) =>
    t
      .http()
      [method](`/v1/storefront${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', h)
      .set('x-shopper-ip', '203.0.113.21');

  const save = (body: Record<string, unknown>, h = host) => shop('post', '/carts', h).send(body);
  const cartBody = (tok: string, phone: string, extra: Record<string, unknown> = {}) => ({
    token: tok,
    items: [
      { productId: saree.id, variantId: saree.variants[0]!.id, quantity: 2 },
      { productId: shawl.id, variantId: shawl.variants[0]!.id, quantity: 1 },
    ],
    customer: { name: 'Rahim Uddin', phone },
    ...extra,
  });
  const checkout = (phone: string, cartToken?: string) =>
    shop('post', '/checkout')
      .set('idempotency-key', `idem-${new Types.ObjectId().toHexString()}`)
      .send({
        items: [{ productId: saree.id, variantId: saree.variants[0]!.id, quantity: 2 }],
        customer: { name: 'Rahim Uddin', phone },
        address: { line1: 'House 12, Road 5', area: 'Dhanmondi', city: 'Dhaka' },
        zoneId: null,
        ...(cartToken ? { cartToken } : {}),
      });

  const getSettings = async (as = owner) =>
    (await t.as(as.token).get(url('/carts/settings')).expect(200)).body as SettingsDto;
  const patchSettings = (body: Record<string, unknown>, as = owner) =>
    t.as(as.token).patch(url('/carts/settings')).send(body);
  const list = async (query = '', org = orgId, as = owner) =>
    (
      await t
        .as(as.token)
        .get(`${url('/carts', org)}${query}`)
        .expect(200)
    ).body.items as CartDto[];
  const cartByPhone = async (phone: string, view = 'all') => {
    const items = await list(`?view=${view}&phone=${phone}`);
    expect(items.length).toBeGreaterThan(0);
    return items[0]!;
  };
  const rawCart = (id: string) => t.db.collection('carts').findOne({ _id: new Types.ObjectId(id) });
  /** Moves a cart's last change into the past, as if the shopper left `ms` ago. */
  const age = (id: string, ms: number) =>
    t.db.collection('carts').updateOne(
      { _id: new Types.ObjectId(id) },
      {
        $set: {
          lastActivityAt: new Date(Date.now() - ms),
          createdAt: new Date(Date.now() - ms),
          nextReminderAt: new Date(Date.now() - ms + 60 * MIN),
        },
      },
    );

  /** Runs queued SMS jobs the way the worker does. */
  const runSmsJobs = async () => {
    const processor = new SmsProcessor(t.app.get(SmsService), smsQueue());
    for (const job of await smsQueue().getJobs(['waiting', 'delayed', 'prioritized'])) {
      if (job.name !== 'send') continue;
      await processor.process(job as Job<SmsJob>);
      await job.remove();
    }
  };

  beforeAll(async () => {
    fake.bulkKeys.set(BULK_KEY, { balance: 100, senders: ['8809617000000'] });
    t = await TestApp.create(
      { API_PUBLIC_URL: 'https://api.sellora.test', LOG_LEVEL: 'error' },
      { smsFetch: fake.fetch },
    );
    key = t.env.STOREFRONT_API_KEY!;
    platform = (await t.platformOwner()).token;
    owner = await t.registerUser();
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor', category: 'handicrafts' })).id;
    viewer = await t.addMember(owner, orgId, 'viewer');
    agent = await t.addMember(owner, orgId, 'sales_agent');
    rival = await t.registerUser();
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Bazar' })).id;
    await Promise.all(
      ['Store', 'Product', 'Customer', 'Order', 'Cart', 'CartSettings', 'SmsMessage'].map((m) =>
        t.db.model(m).init(),
      ),
    );
    saree = (
      await O()
        .post(url('/products'))
        .send({ name: 'Red saree', variants: [{ priceMinor: 125_000, stock: 50 }] })
        .expect(201)
    ).body;
    shawl = (
      await O()
        .post(url('/products'))
        .send({ name: 'Kantha shawl', variants: [{ priceMinor: 80_000, stock: 50 }] })
        .expect(201)
    ).body;
    pot = (
      await t
        .as(rival.token)
        .post(url('/products', rivalOrgId))
        .send({ name: 'Clay pot', variants: [{ priceMinor: 30_000, stock: 5 }] })
        .expect(201)
    ).body;
    const open = async (session: Session, org: string, name: string, h: string) => {
      const store = (
        await t
          .as(session.token)
          .post(`/v1/orgs/${org}/stores`)
          .send({ name, handle: h })
          .expect(201)
      ).body as { id: string };
      await t
        .as(session.token)
        .patch(`/v1/orgs/${org}/stores/${store.id}`)
        .send({ contact: { phone: '01700000000' } })
        .expect(200);
      await t.as(session.token).post(`/v1/orgs/${org}/stores/${store.id}/submit`).expect(200);
      await P().post(`/v1/platform/stores/${store.id}/approve`).send({}).expect(200);
      return store.id;
    };
    storeId = await open(owner, orgId, 'Nakshi Ghor', handle);
    await open(rival, rivalOrgId, 'Rival Bazar', 'rival-bazar');
    // Reminders go out through the business's own BulkSMSBD account (free of charge here).
    await O()
      .put(url('/sms/gateway'))
      .send({
        provider: 'bulksmsbd',
        credentials: { apiKey: BULK_KEY },
        senderId: '8809617000000',
      })
      .expect(200);
    await O().patch(url('/sms')).send({ mode: 'own' }).expect(200);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    fake.reset();
    for (const job of await smsQueue().getJobs(['waiting', 'delayed', 'prioritized']))
      await job.remove();
    const limits = t.app.get(RateLimitService);
    for (const name of ['cart-capture:ip', 'cart-restore:ip', 'checkout:ip'])
      await limits.reset(name, '203.0.113.21');
  });

  describe('settings', () => {
    it('start switched off, with an hour-later reminder written in the business language', async () => {
      const s = await getSettings();
      expect(s).toMatchObject({
        enabled: false,
        language: 'en',
        minTotalMinor: 0,
        quietHours: { enabled: true, startHour: 22, endHour: 9 },
        included: true,
        sms: { mode: 'own', ready: true },
      });
      expect(s.steps.map((x) => [x.step, x.enabled, x.delayMinutes])).toEqual([
        [1, true, 60],
        [2, false, 1440],
      ]);
      // The preview fills in sample values and always ends with the stop link.
      expect(s.steps[0]!.preview.text).toMatch(
        /^Hi Rahim, you left Red saree and 1 more at Nakshi Ghor\. Order here: https:\/\/your-shop\.shops\.test\/r\/\w{10} Stop: http:\/\/localhost:3000\/u\/\w+$/,
      );
      expect(s.steps[0]!.preview).toMatchObject({ parts: 1, priceMinor: 0 });
      // The same values in both languages, for previews of texts not saved yet.
      expect(s.samples.en).toMatchObject({ name: 'Rahim', items: 'Red saree and 1 more' });
      expect(s.samples.bn).toMatchObject({ name: 'রহিম', shop: 'Nakshi Ghor' });
      expect(s.samples.bn.link).toBe(s.samples.en.link);
      expect(s.stopSuffix.en).toMatch(/^ Stop: http:\/\/localhost:3000\/u\/\w+$/);
      expect(s.stopSuffix.bn).toMatch(/^ বন্ধ করতে: /);
    });

    it('only marketing staff change them; a viewer can look, a sales agent cannot', async () => {
      await getSettings(viewer);
      await patchSettings({ enabled: true }, viewer).expect(403);
      await t.as(agent.token).get(url('/carts/settings')).expect(403);
      await t.as(agent.token).get(url('/carts')).expect(403);
    });

    it('refuses texts without the link, unknown placeholders, and a second step before the first', async () => {
      const s = await getSettings();
      const steps = s.steps.map(({ enabled, delayMinutes, text }) => ({
        enabled,
        delayMinutes,
        text,
      }));
      const noLink = await patchSettings({
        steps: [{ ...steps[0]!, text: 'Come back to {shop}!' }, steps[1]!],
      }).expect(422);
      expect(noLink.body.errors).toEqual([
        expect.objectContaining({
          path: 'steps.0.text',
          message: expect.stringContaining('{link}'),
        }),
      ]);
      const unknown = await patchSettings({
        steps: [{ ...steps[0]!, text: 'Use {coupon} at {link}' }, steps[1]!],
      }).expect(422);
      expect(unknown.body.errors[0]).toMatchObject({ path: 'steps.0.text' });
      expect(unknown.body.errors[0].message).toContain('{coupon}');
      const order = await patchSettings({
        steps: [steps[0]!, { ...steps[1]!, enabled: true, delayMinutes: 30 }],
      }).expect(422);
      expect(order.body.errors).toEqual([
        expect.objectContaining({ path: 'steps.1.delayMinutes' }),
      ]);
      const odd = await patchSettings({ steps: [{ ...steps[0]!, delayMinutes: 45 }, steps[1]!] });
      expect(odd.status).toBe(422);
      const none = await patchSettings({
        enabled: true,
        steps: [{ ...steps[0]!, enabled: false }, steps[1]!],
      }).expect(422);
      expect(none.body.errors).toEqual([expect.objectContaining({ path: 'steps' })]);
      const long = await patchSettings({
        steps: [{ ...steps[0]!, text: `${'Very long words. '.repeat(28)}{link}` }, steps[1]!],
      }).expect(422);
      expect(long.body.errors[0]).toMatchObject({ path: 'steps.0.text' });
      expect((await getSettings()).enabled).toBe(false);
    });
  });

  describe('saving carts from the store', () => {
    it('saves nothing while reminders are off, and the checkout shows no notice', async () => {
      const quote = await shop('post', '/cart')
        .send({ items: [{ productId: saree.id, variantId: saree.variants[0]!.id, quantity: 1 }] })
        .expect(200);
      expect(quote.body.cartReminders).toBe(false);
      const res = await save(cartBody(token(), '01712345678')).expect(200);
      expect(res.body).toEqual({ saved: false });
      expect(await t.db.collection('carts').countDocuments()).toBe(0);
    });

    it('once on, saves the cart with store prices and updates it by its token', async () => {
      await patchSettings({
        enabled: true,
        quietHours: { enabled: false, startHour: 22, endHour: 9 },
      }).expect(200);
      const quote = await shop('post', '/cart')
        .send({ items: [{ productId: saree.id, variantId: saree.variants[0]!.id, quantity: 1 }] })
        .expect(200);
      expect(quote.body.cartReminders).toBe(true);

      const tok = token();
      // Half a number is not saved; the shopper is still typing.
      expect((await save(cartBody(tok, '01712')).expect(200)).body).toEqual({ saved: false });
      expect((await save(cartBody(tok, '01712345678')).expect(200)).body).toEqual({ saved: true });
      expect(
        (
          await save({
            ...cartBody(tok, '01712345678'),
            items: [{ productId: saree.id, variantId: saree.variants[0]!.id, quantity: 3 }],
            customer: { name: 'Rahim', phone: '+880 1712-345678' },
          }).expect(200)
        ).body,
      ).toEqual({ saved: true });

      const [cart, ...rest] = await list('?view=all');
      expect(rest).toHaveLength(0);
      expect(cart).toMatchObject({
        source: 'store',
        store: { id: storeId, name: 'Nakshi Ghor' },
        customer: { name: 'Rahim', phone: '+8801712345678' },
        items: [{ productId: saree.id, quantity: 3, name: 'Red saree', unitPriceMinor: 125_000 }],
        totalMinor: 375_000,
        status: 'open',
        state: 'shopping',
        reminders: [],
        manualRemindersLeft: 3,
      });
      expect(cart!.link).toMatch(/^https:\/\/nakshi-ghor\.shops\.test\/r\/[A-Za-z0-9]{10}$/);
      // The first reminder is planned an hour after the last change.
      expect(new Date(cart!.nextReminderAt!).getTime() - Date.now()).toBeGreaterThan(59 * MIN);
      // Not shown as left until the shopper has been gone a while.
      expect(await list('?view=abandoned')).toHaveLength(0);
    });

    it('needs the marketing module in the plan', async () => {
      await P()
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ note: 'cart test', removeModules: ['marketing'] })
        .expect(200);
      expect((await save(cartBody(token(), '01755555555')).expect(200)).body).toEqual({
        saved: false,
      });
      const blocked = await O().get(url('/carts/settings')).expect(402);
      expect(blocked.body.code).toBe('module_not_in_plan');
      await P()
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ note: 'cart test', removeModules: [] })
        .expect(200);
    });
  });

  describe('reminders', () => {
    it('sends the first reminder an hour after the shopper left, with the cart link and the stop link', async () => {
      const cart = await cartByPhone('01712345678');
      await age(cart.id, 61 * MIN);
      expect(await list('?view=abandoned')).toEqual([expect.objectContaining({ id: cart.id })]);

      const counts = await carts().sweep(new Date());
      expect(counts).toMatchObject({ sent: 1 });
      await runSmsJobs();
      expect(fake.sent).toHaveLength(1);
      const sms = fake.sent[0]!;
      expect(sms.to).toBe('8801712345678');
      expect(sms.text).toBe(
        `Hi Rahim, you left 3 × Red saree at Nakshi Ghor. Order here: ${cart.link} Stop: ${sms.text.split('Stop: ')[1]}`,
      );
      expect(sms.text).toMatch(/Stop: http:\/\/localhost:3000\/u\/\w+$/);

      const after = await cartByPhone('01712345678');
      expect(after.reminders).toEqual([
        expect.objectContaining({
          step: 1,
          manual: false,
          message: expect.objectContaining({ status: 'sent' }),
        }),
      ]);
      // Only one step is on, so nothing else is planned.
      expect(after.nextReminderAt).toBeNull();
      // A second sweep sends nothing more.
      expect(await carts().sweep(later(5 * MIN))).toEqual({});
      const messages = (await O().get(url('/sms/messages?purpose=cart_recovery')).expect(200)).body
        .items as { ref: { type: string; id: string } }[];
      expect(messages).toEqual([
        expect.objectContaining({ ref: expect.objectContaining({ type: 'cart', id: cart.id }) }),
      ]);
    });

    it('the link restores the cart on its own store only, and counts the click', async () => {
      const cart = await cartByPhone('01712345678');
      const code = cart.link.split('/r/')[1]!;
      const restored = await shop('get', `/carts/${code}`).expect(200);
      expect(restored.body).toMatchObject({
        kind: 'store',
        status: 'open',
        items: [{ productId: saree.id, variantId: saree.variants[0]!.id, quantity: 3 }],
        customer: { name: 'Rahim', phone: '01712345678' },
      });
      expect(restored.body.token).toMatch(/^tok_/);
      await shop('get', `/carts/${code}`, rivalHost).expect(404);
      await shop('get', '/carts/AAAAAAAAAA').expect(404);
      expect((await cartByPhone('01712345678')).clicks).toBe(1);
    });

    it('an order from the cart closes it as recovered', async () => {
      const cart = await cartByPhone('01712345678');
      const raw = await rawCart(cart.id);
      const placed = await checkout('01712345678', raw!.token as string).expect(201);
      const done = await vi.waitFor(
        async () => {
          const c = await cartByPhone('01712345678');
          expect(c.status).toBe('ordered');
          return c;
        },
        { timeout: 3000, interval: 50 },
      );
      expect(done).toMatchObject({
        recovered: true,
        order: { number: placed.body.orderNumber, totalMinor: placed.body.totalMinor },
        nextReminderAt: null,
      });
      expect(await list('?view=recovered')).toEqual([expect.objectContaining({ id: cart.id })]);
      // The restored link no longer hands out the token.
      const code = cart.link.split('/r/')[1]!;
      const again = await shop('get', `/carts/${code}`).expect(200);
      expect(again.body).toMatchObject({ status: 'ordered', token: null });
    });

    it('any order for the number closes its carts; without a reminder it is not counted as recovered', async () => {
      await save(cartBody(token(), '01812345678')).expect(200);
      await O()
        .post(url('/orders'))
        .send({
          customer: { name: 'Karim', phone: '01812345678' },
          shippingAddress: { line1: 'House 3, Road 1', city: 'Dhaka' },
          items: [{ productId: shawl.id, variantId: shawl.variants[0]!.id, quantity: 1 }],
        })
        .expect(201);
      const closed = await vi.waitFor(
        async () => {
          const c = await cartByPhone('01812345678');
          expect(c.status).toBe('ordered');
          return c;
        },
        { timeout: 3000, interval: 50 },
      );
      expect(closed.recovered).toBe(false);
    });

    it('sends at most one cart reminder a day to the same number', async () => {
      const first = token();
      const second = token();
      await save(cartBody(first, '01912345678')).expect(200);
      await save(cartBody(second, '01912345678')).expect(200);
      const [b, a] = await list('?view=all&phone=01912345678');
      await age(a!.id, 70 * MIN);
      await age(b!.id, 65 * MIN);
      const counts = await carts().sweep(new Date());
      expect(counts).toMatchObject({ sent: 1, 'skipped:recent_reminder': 1 });
      const waiting = (await list('?view=all&phone=01912345678')).find(
        (c) => c.reminders.length === 0,
      )!;
      expect(waiting.lastSkip).toMatchObject({ reason: 'recent_reminder' });
      const wait = new Date(waiting.nextReminderAt!).getTime() - Date.now();
      expect(wait).toBeGreaterThan(SAME_PHONE_GAP_MS - 5 * MIN);
    });

    it('waits through quiet hours in the business time zone', async () => {
      await patchSettings({ quietHours: { enabled: true, startHour: 22, endHour: 9 } }).expect(200);
      const tok = token();
      await save(cartBody(tok, '01312345678')).expect(200);
      const cart = await cartByPhone('01312345678');
      await age(cart.id, 61 * MIN);
      // The first moment within the next 11 hours that falls in quiet hours in Dhaka.
      const q = { enabled: true, startHour: 22, endHour: 9 };
      let at = new Date();
      while (!inQuietHours(at, q, 'Asia/Dhaka')) at = new Date(at.getTime() + 15 * MIN);
      const outcome = await inTenant(() => carts().evaluate(new Types.ObjectId(cart.id), at));
      expect(outcome).toBe('skipped:quiet_hours');
      const raw = await rawCart(cart.id);
      expect(raw!.nextReminderAt).toEqual(quietHoursEnd(at, q, 'Asia/Dhaka'));
      expect(raw!.reminders).toEqual([]);
      await patchSettings({ quietHours: { enabled: false, startHour: 22, endHour: 9 } }).expect(
        200,
      );
    });

    it('skips numbers that opted out, carts below the minimum, and waits while SMS is off', async () => {
      // Opted out: no reminder and none planned.
      await inTenant(() => t.app.get(SmsService).stop('+8801312345678', 'staff'));
      const opted = await cartByPhone('01312345678');
      expect(await inTenant(() => carts().evaluate(new Types.ObjectId(opted.id)))).toBe(
        'skipped:opted_out',
      );
      expect((await rawCart(opted.id))!.nextReminderAt).toBeNull();

      // Below the minimum total.
      await patchSettings({ minTotalMinor: 500_000 }).expect(200);
      await save(cartBody(token(), '01412345678')).expect(200);
      const small = await cartByPhone('01412345678');
      await age(small.id, 61 * MIN);
      expect(await inTenant(() => carts().evaluate(new Types.ObjectId(small.id)))).toBe(
        'skipped:below_minimum',
      );
      await patchSettings({ minTotalMinor: 0 }).expect(200);

      // SMS switched off: looked at again in half an hour.
      await O().patch(url('/sms')).send({ mode: 'off' }).expect(200);
      expect(await inTenant(() => carts().evaluate(new Types.ObjectId(small.id)))).toBe(
        'skipped:sms_off',
      );
      const raw = await rawCart(small.id);
      expect((raw!.nextReminderAt as Date).getTime() - Date.now()).toBeGreaterThan(
        SMS_OFF_RETRY_MS - MIN,
      );
      await O().patch(url('/sms')).send({ mode: 'own' }).expect(200);
      expect(fake.sent).toHaveLength(0);
    });

    it('follows changed delays, sends the second step later, and skips steps long past', async () => {
      const s = await getSettings();
      await patchSettings({
        steps: [
          { enabled: true, delayMinutes: 30, text: s.steps[0]!.text },
          {
            enabled: true,
            delayMinutes: 120,
            text: '{name}, still thinking? {total} at {shop}: {link}',
          },
        ],
      }).expect(200);
      const small = await cartByPhone('01412345678');
      // Saving the settings asked the sweep to look at waiting carts again.
      expect((await rawCart(small.id))!.nextReminderAt.getTime()).toBeLessThanOrEqual(Date.now());
      await t.db
        .collection('carts')
        .updateOne(
          { _id: new Types.ObjectId(small.id) },
          { $set: { lastActivityAt: new Date(Date.now() - 31 * MIN) } },
        );
      expect(await inTenant(() => carts().evaluate(new Types.ObjectId(small.id)))).toBe('sent');
      let raw = await rawCart(small.id);
      expect(raw!.nextStep).toBe(1);
      // Step 2 comes 120 minutes after the last change (89 minutes from now).
      const step2 = (raw!.nextReminderAt as Date).getTime() - Date.now();
      expect(step2).toBeGreaterThan(88 * MIN);
      expect(step2).toBeLessThan(91 * MIN);
      expect(
        await inTenant(() => carts().evaluate(new Types.ObjectId(small.id), later(90 * MIN))),
      ).toBe('sent');
      await runSmsJobs();
      // The worker sends them in its own order; both went out once.
      const texts = fake.to('8801412345678').map((m) => m.text.split(' Stop:')[0]);
      expect(texts).toHaveLength(2);
      expect(texts).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^Hi Rahim Uddin, you left 2 × Red saree and 1 more at Nakshi Ghor\. Order here: https:\/\/nakshi-ghor\.shops\.test\/r\/\w{10}$/,
          ),
          expect.stringMatching(
            /^Rahim Uddin, still thinking\? Tk 3,300 at Nakshi Ghor: https:\/\/nakshi-ghor\.shops\.test\/r\/\w{10}$/,
          ),
        ]),
      );
      raw = await rawCart(small.id);
      expect(raw!.nextReminderAt).toBeNull();

      // A cart whose first step passed more than 12 hours ago gets the second, not the first.
      await save(cartBody(token(), '01512345678')).expect(200);
      const old = await cartByPhone('01512345678');
      await t.db
        .collection('carts')
        .updateOne(
          { _id: new Types.ObjectId(old.id) },
          { $set: { lastActivityAt: new Date(Date.now() - 13 * 60 * MIN) } },
        );
      expect(await inTenant(() => carts().evaluate(new Types.ObjectId(old.id)))).toBe('sent');
      expect((await rawCart(old.id))!.reminders).toEqual([
        expect.objectContaining({ step: 2, manual: false }),
      ]);
      // One whose steps all passed more than 12 hours ago gets nothing.
      await save(cartBody(token(), '01512345670')).expect(200);
      const older = await cartByPhone('01512345670');
      await t.db
        .collection('carts')
        .updateOne(
          { _id: new Types.ObjectId(older.id) },
          { $set: { lastActivityAt: new Date(Date.now() - 15 * 60 * MIN) } },
        );
      expect(await inTenant(() => carts().evaluate(new Types.ObjectId(older.id)))).toBe('no_step');
      expect((await rawCart(older.id))!.nextReminderAt).toBeNull();
    });

    it('turning reminders off stops waiting carts', async () => {
      await save(cartBody(token(), '01612345678')).expect(200);
      await patchSettings({ enabled: false }).expect(200);
      const cart = await cartByPhone('01612345678');
      expect(cart.nextReminderAt).toBeNull();
      expect((await save(cartBody(token(), '01612345670')).expect(200)).body).toEqual({
        saved: false,
      });
      await patchSettings({ enabled: true }).expect(200);
      expect((await cartByPhone('01612345678')).nextReminderAt).not.toBeNull();
    });
  });

  describe('by hand', () => {
    it('staff send a reminder now (at most three) and can stop a cart', async () => {
      const cart = await cartByPhone('01612345678');
      const sent = (
        await O()
          .post(url(`/carts/${cart.id}/remind`))
          .expect(200)
      ).body as CartDto;
      expect(sent.reminders).toEqual([
        expect.objectContaining({
          step: 0,
          manual: true,
          message: expect.objectContaining({ status: 'queued' }),
        }),
      ]);
      expect(sent.manualRemindersLeft).toBe(2);
      await runSmsJobs();
      expect(fake.to('8801612345678')).toHaveLength(1);
      await t
        .as(viewer.token)
        .post(url(`/carts/${cart.id}/remind`))
        .expect(403);
      await O()
        .post(url(`/carts/${cart.id}/remind`))
        .expect(200);
      await O()
        .post(url(`/carts/${cart.id}/remind`))
        .expect(200);
      const limit = await O()
        .post(url(`/carts/${cart.id}/remind`))
        .expect(409);
      expect(limit.body.code).toBe('manual_limit');

      const stopped = (
        await O()
          .post(url(`/carts/${cart.id}/dismiss`))
          .expect(200)
      ).body as CartDto;
      expect(stopped).toMatchObject({ status: 'dismissed', nextReminderAt: null });
      expect(
        (
          await O()
            .post(url(`/carts/${cart.id}/dismiss`))
            .expect(409)
        ).body.code,
      ).toBe('cart_closed');
      expect(await list('?view=dismissed')).toEqual([expect.objectContaining({ id: cart.id })]);
    });

    it('refuses while SMS is off or the number opted out', async () => {
      await save(cartBody(token(), '01712000000')).expect(200);
      const cart = await cartByPhone('01712000000');
      await O().patch(url('/sms')).send({ mode: 'off' }).expect(200);
      expect(
        (
          await O()
            .post(url(`/carts/${cart.id}/remind`))
            .expect(422)
        ).body.code,
      ).toBe('sms_off');
      await O().patch(url('/sms')).send({ mode: 'own' }).expect(200);
      await inTenant(() => t.app.get(SmsService).stop('+8801712000000', 'staff'));
      expect(
        (
          await O()
            .post(url(`/carts/${cart.id}/remind`))
            .expect(422)
        ).body.code,
      ).toBe('opted_out');
    });
  });

  describe('the 30-day summary', () => {
    it('counts carts left, reminded and recovered, with the value', async () => {
      const s = (await O().get(url('/carts/summary')).expect(200)).body as Record<string, unknown>;
      expect(s).toMatchObject({
        days: 30,
        currency: 'BDT',
        recovered: 1,
        dismissed: 1,
        smsSpentMinor: 0,
      });
      // Five carts got a reminder that was not refused; four of those texts were sent (the
      // others were still queued when their test ended).
      expect(s.reminded).toBe(5);
      expect(s.smsSent).toBe(4);
      expect(s.recoveryRate).toBeCloseTo(1 / (s.reminded as number));
      expect((s.recoveredMinor as number) > 0).toBe(true);
      expect(ABANDONED_AFTER_MS).toBe(30 * MIN);
    });
  });

  describe('tenancy', () => {
    it('another business cannot see, remind, stop or restore these carts', async () => {
      const cart = await cartByPhone('01712000000');
      // Not a member: the business is not even there for them.
      await t.as(rival.token).get(url('/carts')).expect(404);
      await t
        .as(rival.token)
        .get(url(`/carts/${cart.id}`))
        .expect(404);
      // From its own business, the cart does not exist.
      await t
        .as(rival.token)
        .get(url(`/carts/${cart.id}`, rivalOrgId))
        .expect(404);
      await t
        .as(rival.token)
        .post(url(`/carts/${cart.id}/remind`, rivalOrgId))
        .expect(404);
      await t
        .as(rival.token)
        .post(url(`/carts/${cart.id}/dismiss`, rivalOrgId))
        .expect(404);
      expect(await list('?view=all', rivalOrgId, rival)).toEqual([]);
      const code = cart.link.split('/r/')[1]!;
      await shop('get', `/carts/${code}`, rivalHost).expect(404);
      // The same token on another business's store makes a separate cart there.
      await t
        .as(rival.token)
        .patch(url('/carts/settings', rivalOrgId))
        .send({ enabled: true })
        .expect(200);
      const tok = (await rawCart(cart.id))!.token as string;
      const rivalSave = await save(
        {
          token: tok,
          items: [{ productId: pot.id, variantId: pot.variants[0]!.id, quantity: 1 }],
          customer: { name: 'Rahim', phone: '01712000000' },
        },
        rivalHost,
      ).expect(200);
      expect(rivalSave.body).toEqual({ saved: true });
      const theirs = await list('?view=all', rivalOrgId, rival);
      expect(theirs).toEqual([
        expect.objectContaining({ items: [expect.objectContaining({ name: 'Clay pot' })] }),
      ]);
      expect(theirs[0]!.id).not.toBe(cart.id);
      // Products of one business never price a cart on another's store.
      const mixed = await save(cartBody(token(), '01712000001'), rivalHost).expect(200);
      expect(mixed.body).toEqual({ saved: false });
      expect((await rawCart(cart.id))!.orgId.toHexString()).toBe(orgId);
    });
  });
});
