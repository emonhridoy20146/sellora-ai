import { getQueueToken } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { RateLimitService } from '../../src/modules/auth/core/rate-limit.service.js';
import { WalletService } from '../../src/modules/billing/wallet.service.js';
import { OrderSmsListener } from '../../src/modules/sms/order-sms.listener.js';
import { SmsService, type SmsJob } from '../../src/modules/sms/sms.service.js';
import { SmsProcessor } from '../../src/workers/sms.processor.js';
import { FakeSmsProviders, type FakeSms } from '../helpers/fake-sms.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface MessageDto {
  id: string;
  to: string;
  body: string;
  purpose: string;
  route: string;
  provider: string | null;
  senderId: string;
  encoding: string;
  parts: number;
  priceMinor: number;
  status: string;
  failure: string | null;
  error: string | null;
  ref: { type: string; id: string; label?: string } | null;
}

interface SettingsDto {
  mode: string;
  language: string;
  own: {
    provider: string;
    credentialsHint: string;
    senderId: string;
    lastCheck: { summary: string } | null;
    lastError: { message: string } | null;
  } | null;
  sellora: { available: boolean; price: { perPartMinor: number } | null };
  senderName: { name: string; status: string; reason: string | null } | null;
  useSenderName: boolean;
  route:
    | {
        ready: true;
        route: string;
        providerName: string;
        senderId: string;
        pricePerPartMinor: number;
      }
    | { ready: false; route: string; failure: string; message: string };
  orderTemplates: { event: string; enabled: boolean; text: string }[];
  dailyLimit: number;
  providers: { key: string }[];
}

const API = 'https://api.sellora.test';
const BULK_KEY = 'bulk-api-key-0001';
const ALPHA_KEY = 'alpha-platform-key-0001';
const TWILIO_SID = `AC${'b'.repeat(32)}`;
const TWILIO_TOKEN = 'twilio-auth-token-0001';
const CUSTOMER = '01712345678';
const CUSTOMER_E164 = '+8801712345678';

describe('SMS: providers, order messages, Sellora SMS and opt-outs', () => {
  const fake = new FakeSmsProviders();
  let t: TestApp;
  let platform: string;
  let owner: Session;
  let agent: Session;
  let accountant: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let shopName: string;
  let productId: string;
  let variantId: string;

  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}/sms${path}`;
  const queue = () => t.app.get<Queue<SmsJob>>(getQueueToken(QUEUES.sms));
  const sms = () => t.app.get(SmsService);
  const inTenant = <T>(fn: () => Promise<T>, org = orgId) =>
    RequestContext.withTenant(org, fn, { type: 'system', id: 'test' });

  /** Runs queued SMS jobs the way the worker does. `final` plays the last attempt. */
  const runJobs = async (opts: { final?: boolean } = {}) => {
    const processor = new SmsProcessor(sms(), queue());
    const done: { result?: unknown; error?: string }[] = [];
    const jobs = await queue().getJobs(['waiting', 'delayed', 'prioritized']);
    for (const job of jobs) {
      if (job.name !== 'send') continue;
      const played = Object.assign(Object.create(Object.getPrototypeOf(job) as object), job, {
        attemptsMade: opts.final ? 4 : 0,
      }) as Job<SmsJob>;
      try {
        done.push({ result: await processor.process(played) });
        await job.remove();
      } catch (err) {
        done.push({ error: (err as Error).message });
        if (opts.final) await job.remove();
      }
    }
    return done;
  };
  const clearJobs = async () => {
    for (const job of await queue().getJobs(['waiting', 'delayed', 'prioritized']))
      await job.remove();
  };

  const settings = async (org = orgId, as = owner) =>
    (await t.as(as.token).get(url('', org)).expect(200)).body as SettingsDto;
  const patch = (body: Record<string, unknown>, org = orgId, as = owner) =>
    t.as(as.token).patch(url('', org)).send(body);
  const test = (to: string, text?: string, org = orgId, as = owner) =>
    t
      .as(as.token)
      .post(url('/test', org))
      .send({ to, ...(text ? { text } : {}) });
  const messages = async (query = '', org = orgId) =>
    (
      await t
        .as(owner.token)
        .get(`${url('/messages', org)}${query}`)
        .expect(200)
    ).body.items as MessageDto[];
  const wallet = async (org = orgId, as = owner) =>
    (await t.as(as.token).get(`/v1/orgs/${org}/billing/wallet`).expect(200)).body as {
      balanceMinor: number;
      heldMinor: number;
      bonusMinor: number;
    };
  const credit = (org: string, amountMinor: number) =>
    P()
      .post(`/v1/platform/billing/tenants/${org}/wallet/adjust`)
      .send({
        direction: 'credit',
        type: 'topup',
        amountMinor,
        note: 'bank transfer',
        idempotencyKey: `k-${new Types.ObjectId().toHexString()}`,
      })
      .expect(200);
  const createOrder = async (phone = CUSTOMER, status: 'pending' | 'confirmed' = 'pending') =>
    (
      await O()
        .post(`/v1/orgs/${orgId}/orders`)
        .send({
          status,
          customer: { name: 'Rahim Uddin', phone },
          shippingAddress: { line1: 'House 12, Road 5', area: 'Dhanmondi', city: 'Dhaka' },
          items: [{ productId, variantId, quantity: 2 }],
        })
        .expect(201)
    ).body as { id: string; number: string; totalMinor: number };
  const setStatus = (orderId: string, status: string) =>
    O().post(`/v1/orgs/${orgId}/orders/${orderId}/status`).send({ status }).expect(200);
  /** Waits for the order listener (it runs after the response) to write the message down. */
  const orderMessages = (orderId: string, count: number) =>
    vi.waitFor(
      async () => {
        const items = await messages(`?orderId=${orderId}`);
        expect(items).toHaveLength(count);
        return items;
      },
      { timeout: 3000, interval: 50 },
    );

  beforeAll(async () => {
    fake.bulkKeys.set(BULK_KEY, { balance: 100, senders: ['8809617000000'] });
    fake.alphaKeys.set(ALPHA_KEY, { balance: 100 });
    fake.twilioAccounts.set(TWILIO_SID, { authToken: TWILIO_TOKEN, from: ['+15005550006'] });
    t = await TestApp.create({ API_PUBLIC_URL: API, LOG_LEVEL: 'error' }, { smsFetch: fake.fetch });
    platform = (await t.platformOwner()).token;
    owner = await t.registerUser();
    shopName = 'Nakshi Ghor';
    orgId = (await t.createOrg(owner, { name: shopName })).id;
    agent = await t.addMember(owner, orgId, 'sales_agent');
    accountant = await t.addMember(owner, orgId, 'accountant');
    rival = await t.registerUser();
    rivalOrgId = (await t.createOrg(rival)).id;
    const product = await O()
      .post(`/v1/orgs/${orgId}/products`)
      .send({ name: 'Red saree', variants: [{ priceMinor: 125_000, stock: 500 }] })
      .expect(201);
    productId = product.body.id as string;
    variantId = product.body.variants[0].id as string;
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    fake.reset();
    await clearJobs();
    // Ten test messages an hour is the real limit; this suite sends more than that.
    for (const org of [orgId, rivalOrgId])
      await t.app.get(RateLimitService).reset('sms-test:org', org);
  });

  describe('settings', () => {
    it('start switched off, with the order texts written but not sent', async () => {
      const s = await settings();
      expect(s).toMatchObject({
        mode: 'off',
        language: 'en',
        own: null,
        sellora: { available: false },
        senderName: null,
        useSenderName: false,
        route: { ready: false, failure: 'not_configured' },
        dailyLimit: 1000,
      });
      expect(s.providers.map((p) => p.key)).toEqual([
        'bulksmsbd',
        'alpha_sms',
        'ssl_wireless',
        'twilio',
      ]);
      expect(s.orderTemplates.map((x) => [x.event, x.enabled])).toEqual([
        ['order_placed', false],
        ['order_confirmed', false],
        ['order_shipped', false],
        ['order_delivered', false],
        ['order_cancelled', false],
      ]);
      expect(s.orderTemplates[0]!.text).toContain('{order}');
    });

    it('only people who manage integrations change them; the accountant can look', async () => {
      await t.as(agent.token).get(url('')).expect(403);
      await settings(orgId, accountant);
      await patch({ language: 'bn' }, orgId, accountant).expect(403);
      await t.as(agent.token).post(url('/test')).send({ to: CUSTOMER }).expect(403);
    });

    it('nothing is sent while SMS is off', async () => {
      const res = await test(CUSTOMER).expect(422);
      expect(res.body.code).toBe('sms_off');
      const placed = await inTenant(() =>
        sms().enqueue({ to: CUSTOMER_E164, text: 'Hi', purpose: 'order_placed', key: 'k-off' }),
      );
      expect(placed).toEqual({ message: null, skipped: 'off' });
      expect(fake.sent).toHaveLength(0);
      // Test messages are limited to ten an hour per business.
      for (let i = 1; i < 10; i += 1) await test(CUSTOMER).expect(422);
      await test(CUSTOMER).expect(429);
    });
  });

  describe("the business's own provider", () => {
    it('checks credentials with the provider before saving, and never shows them again', async () => {
      const wrong = await O()
        .put(url('/gateway'))
        .send({
          provider: 'bulksmsbd',
          credentials: { apiKey: 'not-the-key-0001' },
          senderId: '8809617000000',
        })
        .expect(422);
      expect(wrong.body.code).toBe('sms_check_failed');
      expect(wrong.body.detail).toContain('1011');

      const noSender = await O()
        .put(url('/gateway'))
        .send({ provider: 'bulksmsbd', credentials: { apiKey: BULK_KEY } })
        .expect(422);
      expect(noSender.body.errors).toEqual([expect.objectContaining({ path: 'senderId' })]);
      const badKey = await O()
        .put(url('/gateway'))
        .send({
          provider: 'bulksmsbd',
          credentials: { apiKey: 'short' },
          senderId: '8809617000000',
        })
        .expect(422);
      expect(badKey.body.errors).toEqual([expect.objectContaining({ path: 'credentials.apiKey' })]);
      expect((await settings()).own).toBeNull();

      const ok = await O()
        .put(url('/gateway'))
        .send({
          provider: 'bulksmsbd',
          credentials: { apiKey: BULK_KEY },
          senderId: '8809617000000',
        })
        .expect(200);
      expect(ok.body.check).toEqual({ summary: 'Connected. Balance ৳100.00.', checked: true });
      expect(ok.body.settings.own).toMatchObject({
        provider: 'bulksmsbd',
        credentialsHint: 'API key …0001',
        senderId: '8809617000000',
      });
      expect(JSON.stringify(ok.body)).not.toContain(BULK_KEY);
      const raw = await t.db
        .collection('smssettings')
        .findOne({ orgId: new Types.ObjectId(orgId) });
      expect(JSON.stringify(raw)).not.toContain(BULK_KEY);
      // Connecting does not start sending.
      expect(ok.body.settings.mode).toBe('off');
    });

    it('sends a test message through it, free of charge, and refuses numbers it cannot reach', async () => {
      await patch({ mode: 'own' }).expect(200);
      const s = await settings();
      expect(s.route).toMatchObject({
        ready: true,
        route: 'own',
        providerName: 'BulkSMSBD',
        pricePerPartMinor: 0,
      });
      const before = await wallet();

      const sent = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(sent).toMatchObject({
        status: 'sent',
        route: 'own',
        provider: 'bulksmsbd',
        purpose: 'test',
        to: CUSTOMER_E164,
        parts: 1,
        priceMinor: 0,
      });
      expect(fake.sent).toEqual([
        expect.objectContaining({
          to: '8801712345678',
          from: '8809617000000',
          text: `Test message from ${shopName} via Sellora. SMS is working.`,
        }),
      ]);
      expect(await wallet()).toEqual(before);

      const abroad = (await test('+447911123456').expect(200)).body as MessageDto;
      expect(abroad).toMatchObject({ status: 'failed', failure: 'unreachable_number' });
      await test('12').expect(422);
      expect(fake.sent).toHaveLength(1);
    });

    it('validates order texts: known placeholders, not empty when on, not too long', async () => {
      const unknown = await patch({
        orderTemplates: { order_placed: { text: 'Hi {name}, use {coupon}' } },
      }).expect(422);
      expect(unknown.body.errors).toEqual([
        { path: 'orderTemplates.order_placed.text', message: 'This message cannot use {coupon}' },
      ]);
      const tracking = await patch({
        orderTemplates: { order_confirmed: { text: 'Track {tracking}' } },
      }).expect(422);
      expect(tracking.body.errors[0].path).toBe('orderTemplates.order_confirmed.text');
      const empty = await patch({
        orderTemplates: { order_delivered: { enabled: true, text: '  ' } },
      }).expect(422);
      expect(empty.body.errors[0].message).toBe('Write the message or turn it off');
      const long = await patch({
        orderTemplates: { order_placed: { text: 'ধ'.repeat(450) } },
      }).expect(422);
      expect(long.body.errors[0].message).toContain('SMS parts');

      const on = await patch({
        orderTemplates: {
          order_placed: { enabled: true },
          order_confirmed: { enabled: true },
          order_shipped: { enabled: true },
          order_delivered: { enabled: true, text: 'Delivered {order}. Thanks, {name}! {shop}' },
        },
      }).expect(200);
      expect(
        (on.body as SettingsDto).orderTemplates.filter((x) => x.enabled).map((x) => x.event),
      ).toEqual(['order_placed', 'order_confirmed', 'order_shipped', 'order_delivered']);
    });

    it('texts the customer as the order moves on, once per order and event', async () => {
      const order = await createOrder();
      const [placed] = await orderMessages(order.id, 1);
      expect(placed).toMatchObject({
        purpose: 'order_placed',
        status: 'queued',
        ref: { type: 'order', id: order.id, label: order.number },
      });
      expect(placed!.body).toBe(
        `Hi Rahim Uddin, we got your order ${order.number} (Tk 2,500). We will call you to confirm. ${shopName}`,
      );
      await runJobs();
      expect(fake.sent.map((m) => m.text)).toEqual([placed!.body]);

      await setStatus(order.id, 'confirmed');
      await orderMessages(order.id, 2);
      await setStatus(order.id, 'shipped');
      await orderMessages(order.id, 3);
      await setStatus(order.id, 'delivered');
      const all = await orderMessages(order.id, 4);
      await runJobs();
      expect(all.map((m) => m.purpose).sort()).toEqual([
        'order_confirmed',
        'order_delivered',
        'order_placed',
        'order_shipped',
      ]);
      const texts = fake.sent.map((m) => m.text);
      expect(texts).toContain(
        `Your order ${order.number} is on its way with our delivery partner. Track it: ${shopName}`,
      );
      expect(texts).toContain(`Delivered ${order.number}. Thanks, Rahim Uddin! ${shopName}`);

      // The same event again (a retried webhook, a second listener) makes no second message.
      expect(await t.app.get(OrderSmsListener).notify(orgId, order.id, 'order_delivered')).toBe(
        false,
      );
      expect(await messages(`?orderId=${order.id}`)).toHaveLength(4);
    });

    it('an order confirmed when it is made gets the confirmation, and messages that are off send nothing', async () => {
      const order = await createOrder('01812345678', 'confirmed');
      const [confirmed] = await orderMessages(order.id, 1);
      expect(confirmed!.body).toBe(
        `Your order ${order.number} is confirmed. Total Tk 2,500, pay on delivery. ${shopName}`,
      );
      await O().post(`/v1/orgs/${orgId}/orders/${order.id}/cancel`).send({}).expect(200);
      await new Promise((r) => setTimeout(r, 200));
      expect((await messages(`?orderId=${order.id}`)).map((m) => m.purpose)).toEqual([
        'order_confirmed',
      ]);
      await clearJobs();
    });

    it('tries again while the provider is unreachable, and fails on the last attempt', async () => {
      const m = (
        await inTenant(() =>
          sms().enqueue({
            to: CUSTOMER_E164,
            text: 'Retry me',
            purpose: 'order_placed',
            key: 'retry-1',
          }),
        )
      ).message!;
      fake.faults.push('refused');
      expect((await runJobs())[0]!.error).toContain('could not be reached');
      expect((await messages('?status=queued')).map((x) => x.id)).toContain(m._id.toHexString());
      await runJobs();
      expect(fake.to(CUSTOMER_E164).map((x) => x.text)).toEqual(['Retry me']);

      await inTenant(() =>
        sms().enqueue({
          to: CUSTOMER_E164,
          text: 'Never arrives',
          purpose: 'order_placed',
          key: 'retry-2',
        }),
      );
      fake.faults.push('refused');
      await runJobs({ final: true });
      const [failed] = await messages('?status=failed&purpose=order_placed');
      expect(failed).toMatchObject({ body: 'Never arrives', failure: 'unavailable' });
    });

    it('never sends twice when the answer was lost, and does not charge for it', async () => {
      await inTenant(() =>
        sms().enqueue({
          to: CUSTOMER_E164,
          text: 'Lost answer',
          purpose: 'order_placed',
          key: 'lost-1',
        }),
      );
      fake.faults.push('lose-reply');
      await runJobs();
      expect(fake.sent).toHaveLength(1);
      const [unknown] = await messages('?status=unknown');
      expect(unknown).toMatchObject({ body: 'Lost answer', failure: 'uncertain' });
      await runJobs();
      expect(fake.sent).toHaveLength(1);
    });

    it('shows a credentials problem on the settings page until a message goes through', async () => {
      const saved = fake.bulkKeys.get(BULK_KEY)!;
      fake.bulkKeys.delete(BULK_KEY);
      const failed = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(failed).toMatchObject({ status: 'failed', failure: 'auth' });
      expect((await settings()).own!.lastError!.message).toContain('1011');
      fake.bulkKeys.set(BULK_KEY, saved);
      await test(CUSTOMER).expect(200);
      expect((await settings()).own!.lastError).toBeNull();
    });
  });

  describe('Sellora SMS (paid from the wallet)', () => {
    it('is offered to businesses only once the super-admin set it up and switched it on', async () => {
      const off = await patch({ mode: 'sellora' }).expect(422);
      expect(off.body.code).toBe('sms_unavailable');
      const early = await P().patch('/v1/platform/sms').send({ enabled: true }).expect(422);
      expect(early.body.code).toBe('sms_provider_missing');
      await t.as(owner.token).get('/v1/platform/sms').expect(401);

      const wrong = await P()
        .put('/v1/platform/sms/gateway')
        .send({ provider: 'alpha_sms', credentials: { apiKey: 'wrong-key-0000' } })
        .expect(422);
      expect(wrong.body.code).toBe('sms_check_failed');
      const connected = await P()
        .put('/v1/platform/sms/gateway')
        .send({
          provider: 'alpha_sms',
          credentials: { apiKey: ALPHA_KEY },
          senderId: '8809612000000',
        })
        .expect(200);
      expect(JSON.stringify(connected.body)).not.toContain(ALPHA_KEY);
      const on = await P().patch('/v1/platform/sms').send({ enabled: true }).expect(200);
      expect(on.body).toMatchObject({
        enabled: true,
        ready: true,
        provider: 'alpha_sms',
        senderId: '8809612000000',
        prices: [{ currency: 'BDT', perPartMinor: 50, senderNamePerPartMinor: 70 }],
        costs: [{ currency: 'BDT', perPartMinor: 30, senderNamePerPartMinor: 45 }],
      });
      const dup = await P()
        .patch('/v1/platform/sms')
        .send({
          prices: [
            { currency: 'BDT', perPartMinor: 50, senderNamePerPartMinor: 70 },
            { currency: 'BDT', perPartMinor: 1, senderNamePerPartMinor: 1 },
          ],
        })
        .expect(422);
      expect(dup.body.errors[0].path).toBe('prices');

      await patch({ mode: 'sellora' }).expect(200);
      const s = await settings();
      expect(s.sellora).toMatchObject({ available: true, price: { perPartMinor: 50 } });
      expect(s.route).toMatchObject({
        ready: true,
        route: 'sellora',
        senderId: '8809612000000',
        pricePerPartMinor: 50,
      });
    });

    it('is paid in cash only: free credit does not pay for SMS', async () => {
      const w = await wallet();
      expect(w.balanceMinor - w.bonusMinor).toBe(0);
      const res = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(res).toMatchObject({ status: 'failed', failure: 'insufficient_balance' });
      expect(res.error).toContain('Top up');
      expect(fake.sent).toHaveLength(0);
      expect(await wallet()).toEqual(w);
    });

    it('holds the price, then charges it once the provider accepts the message', async () => {
      await credit(orgId, 1_000);
      const before = await wallet();
      const one = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(one).toMatchObject({
        status: 'sent',
        route: 'sellora',
        provider: 'alpha_sms',
        parts: 1,
        priceMinor: 50,
      });
      expect(fake.sent[0]).toMatchObject({
        provider: 'alpha_sms',
        account: ALPHA_KEY,
        from: '8809612000000',
      });

      const bangla =
        'আপনার অর্ডারটি আজ পাঠানো হয়েছে। কুরিয়ার আপনাকে কল করবে, অনুগ্রহ করে ফোন খোলা রাখুন। ধন্যবাদ';
      const two = (await test(CUSTOMER, bangla).expect(200)).body as MessageDto;
      expect(two).toMatchObject({ status: 'sent', encoding: 'unicode', parts: 2, priceMinor: 100 });

      const after = await wallet();
      expect(after.balanceMinor).toBe(before.balanceMinor - 150);
      expect(after.heldMinor).toBe(0);
      const ledger = (
        await O().get(`/v1/orgs/${orgId}/billing/wallet/ledger?type=sms_usage`).expect(200)
      ).body.items as {
        amountMinor: number;
        description: string;
        reference: { type: string; id: string };
      }[];
      expect(ledger.map((l) => [l.amountMinor, l.description])).toEqual([
        [-100, 'SMS to 017•••••678 · 2 parts'],
        [-50, 'SMS to 017•••••678 · 1 part'],
      ]);
      expect(ledger[0]!.reference).toEqual({ type: 'sms_message', id: two.id });
    });

    it('releases the hold when sending fails or its outcome is unknown, and charges nothing', async () => {
      const before = await wallet();
      fake.faults.push('refused');
      const down = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(down).toMatchObject({ status: 'failed', failure: 'unavailable' });
      fake.faults.push('timeout');
      const unknown = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(unknown).toMatchObject({ status: 'unknown', failure: 'uncertain' });
      expect(await wallet()).toEqual(before);
    });

    it('cleans up messages a crash left half sent, releasing their hold', async () => {
      const m = (
        await inTenant(() =>
          sms().enqueue({
            to: CUSTOMER_E164,
            text: 'Crash',
            purpose: 'order_placed',
            key: 'crash-1',
          }),
        )
      ).message!;
      await inTenant(() => t.app.get(WalletService).hold(50, { excludeBonus: true }));
      await t.db.collection('smsmessages').updateOne(
        { _id: m._id },
        {
          $set: {
            status: 'sending',
            held: true,
            priceMinor: 50,
            updatedAt: new Date(Date.now() - 11 * 60_000),
          },
        },
      );
      expect((await wallet()).heldMinor).toBe(50);
      expect(await sms().sweepStuck()).toBe(1);
      expect((await wallet()).heldMinor).toBe(0);
      const [swept] = await messages('?status=unknown&purpose=order_placed');
      expect(swept).toMatchObject({ body: 'Crash', failure: 'uncertain' });
      await clearJobs();
    });

    it('stops at the daily limit, which the super-admin can change per business', async () => {
      const today = (await O().get(url('/summary')).expect(200)).body as {
        today: number;
        dailyLimit: number;
      };
      expect(today.dailyLimit).toBe(1000);
      const set = await P()
        .put(`/v1/platform/sms/businesses/${orgId}/daily-limit`)
        .send({ dailyLimit: today.today })
        .expect(200);
      expect(set.body).toMatchObject({ dailyLimit: today.today, effectiveDailyLimit: today.today });
      const limited = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(limited).toMatchObject({ status: 'failed', failure: 'daily_limit' });
      await P()
        .put(`/v1/platform/sms/businesses/${orgId}/daily-limit`)
        .send({ dailyLimit: null })
        .expect(200);
      expect(((await test(CUSTOMER).expect(200)).body as MessageDto).status).toBe('sent');
      const list = (await P().get('/v1/platform/sms/businesses').expect(200)).body as {
        items: {
          orgId: string;
          mode: string;
          effectiveDailyLimit: number;
          last30Days: { spentMinor: number };
        }[];
      };
      expect(list.items.find((i) => i.orgId === orgId)).toMatchObject({
        mode: 'sellora',
        effectiveDailyLimit: 1000,
        last30Days: { spentMinor: 200 },
      });
    });

    it('reports revenue, cost and profit to the super-admin', async () => {
      const stats = (await P().get('/v1/platform/sms/stats').expect(200)).body as {
        totals: {
          currency: string;
          messages: number;
          parts: number;
          revenueMinor: number;
          costMinor: number;
          profitMinor: number;
        }[];
      };
      expect(stats.totals).toEqual([
        {
          currency: 'BDT',
          messages: 3,
          parts: 4,
          revenueMinor: 200,
          costMinor: 120,
          profitMinor: 80,
        },
      ]);
      await t.as(owner.token).get('/v1/platform/sms/stats').expect(401);
    });
  });

  describe('sender names', () => {
    it('are asked for by the business and approved by the super-admin', async () => {
      const bad = await O().put(url('/sender-name')).send({ name: 'Nakshi Ghor' }).expect(422);
      expect(bad.body.errors[0].path).toBe('name');
      await O().put(url('/sender-name')).send({ name: '12345' }).expect(422);
      const asked = (await O().put(url('/sender-name')).send({ name: 'NakshiGhor' }).expect(200))
        .body as SettingsDto;
      expect(asked.senderName).toMatchObject({ name: 'NakshiGhor', status: 'pending' });
      const early = await patch({ useSenderName: true }).expect(422);
      expect(early.body.code).toBe('sender_name_not_approved');

      const queue = (await P().get('/v1/platform/sms/sender-names').expect(200)).body as {
        items: { orgId: string; name: string; status: string; business: { name: string } }[];
      };
      expect(queue.items).toEqual([
        expect.objectContaining({
          orgId,
          name: 'NakshiGhor',
          status: 'pending',
          business: expect.objectContaining({ name: shopName }),
        }),
      ]);
      expect((await P().get('/v1/platform/sms').expect(200)).body.pendingSenderNames).toBe(1);

      const stale = await P()
        .post(`/v1/platform/sms/sender-names/${orgId}/approve`)
        .send({ name: 'SomethingElse' })
        .expect(409);
      expect(stale.body.code).toBe('sender_name_changed');
      await P()
        .post(`/v1/platform/sms/sender-names/${rivalOrgId}/approve`)
        .send({ name: 'NakshiGhor' })
        .expect(404);
      const approved = await P()
        .post(`/v1/platform/sms/sender-names/${orgId}/approve`)
        .send({ name: 'NakshiGhor' })
        .expect(200);
      expect(approved.body).toEqual({ orgId, name: 'NakshiGhor', status: 'approved' });
      const mail = (await t.outbox(owner.email)).find((m) => m.category === 'sms.sender_approved');
      expect(mail?.text).toContain('NakshiGhor');
    });

    it('sends from the approved name at its own price', async () => {
      const on = (await patch({ useSenderName: true }).expect(200)).body as SettingsDto;
      expect(on.route).toMatchObject({
        ready: true,
        senderId: 'NakshiGhor',
        pricePerPartMinor: 70,
      });
      const m = (await test(CUSTOMER).expect(200)).body as MessageDto;
      expect(m).toMatchObject({ status: 'sent', senderId: 'NakshiGhor', priceMinor: 70 });
      expect(fake.sent[0]!.from).toBe('NakshiGhor');
    });

    it('a new request stops the old name until it is decided; a refusal says why', async () => {
      const asked = (await O().put(url('/sender-name')).send({ name: 'NakshiBD' }).expect(200))
        .body as SettingsDto;
      expect(asked).toMatchObject({
        useSenderName: false,
        senderName: { name: 'NakshiBD', status: 'pending' },
      });
      await P()
        .post(`/v1/platform/sms/sender-names/${orgId}/reject`)
        .send({ name: 'NakshiBD', reason: 'Operators need a trade licence for this name.' })
        .expect(200);
      const s = await settings();
      expect(s.senderName).toMatchObject({
        status: 'rejected',
        reason: 'Operators need a trade licence for this name.',
      });
      expect((await t.outbox(owner.email)).map((m) => m.category)).toContain('sms.sender_rejected');
      await O().delete(url('/sender-name')).expect(200);
      expect((await settings()).senderName).toBeNull();
    });
  });

  describe('marketing opt-outs', () => {
    let code: string;

    it('marketing messages carry a link that lets the customer stop them', async () => {
      const link = await inTenant(() => sms().optOutUrl(CUSTOMER_E164));
      expect(link).toMatch(/^http:\/\/localhost:3000\/u\/[A-Za-z0-9]{8}$/);
      expect(await inTenant(() => sms().optOutUrl(CUSTOMER_E164))).toBe(link);
      code = link.split('/').pop()!;

      const page = await t.http().get(`/v1/public/sms/opt-out/${code}`).expect(200);
      expect(page.body).toEqual({ shop: shopName, phone: '017•••••678', stopped: false });
      await t.http().get('/v1/public/sms/opt-out/nothere1').expect(404);
      await t.http().post(`/v1/public/sms/opt-out/${code}`).expect(200, { stopped: true });
      expect((await t.http().get(`/v1/public/sms/opt-out/${code}`).expect(200)).body.stopped).toBe(
        true,
      );

      const campaign = await inTenant(() =>
        sms().enqueue({
          to: CUSTOMER_E164,
          text: 'Eid sale!',
          purpose: 'campaign',
          key: 'campaign-1',
        }),
      );
      expect(campaign).toEqual({ message: null, skipped: 'opted_out' });
      // Order messages are service messages and still go.
      const order = await inTenant(() =>
        sms().enqueue({
          to: CUSTOMER_E164,
          text: 'Your order',
          purpose: 'order_confirmed',
          key: 'svc-1',
        }),
      );
      expect(order.message).not.toBeNull();
      await clearJobs();
    });

    it('staff see the list, and can stop or allow a number when the customer asks', async () => {
      const list = (await O().get(url('/opt-outs')).expect(200)).body.items as {
        phone: string;
        source: string;
      }[];
      expect(list).toEqual([expect.objectContaining({ phone: CUSTOMER_E164, source: 'link' })]);
      await O()
        .delete(url(`/opt-outs/${encodeURIComponent(CUSTOMER)}`))
        .expect(204);
      await O().post(url('/opt-outs')).send({ phone: '01912345678' }).expect(204);
      const after = (await O().get(url('/opt-outs')).expect(200)).body.items as {
        phone: string;
        source: string;
      }[];
      expect(after).toEqual([
        expect.objectContaining({ phone: '+8801912345678', source: 'staff' }),
      ]);
      // Another business's list is its own.
      expect(
        (await t.as(rival.token).get(url('/opt-outs', rivalOrgId)).expect(200)).body.items,
      ).toEqual([]);
    });
  });

  describe('delivery reports', () => {
    let twilioOrg: string;
    let twilioOwner: Session;

    it('are accepted only with the signature of the account the message went out on', async () => {
      twilioOwner = await t.registerUser();
      twilioOrg = (await t.createOrg(twilioOwner, { name: 'Global Shop' })).id;
      await t
        .as(twilioOwner.token)
        .put(url('/gateway', twilioOrg))
        .send({
          provider: 'twilio',
          credentials: { accountSid: TWILIO_SID, authToken: TWILIO_TOKEN },
          senderId: '+15005550006',
        })
        .expect(200);
      await patch({ mode: 'own' }, twilioOrg, twilioOwner).expect(200);
      const m = (await test('+447911123456', undefined, twilioOrg, twilioOwner).expect(200))
        .body as MessageDto;
      expect(m.status).toBe('sent');
      const sent = fake.sent[0] as FakeSms;
      expect(sent.statusCallback).toBe(`${API}/v1/public/sms/callbacks/twilio/${m.id}`);
      const path = new URL(sent.statusCallback!).pathname;

      const report = fake.twilioReport(sent, 'delivered');
      await t
        .http()
        .post(path)
        .type('form')
        .set('X-Twilio-Signature', 'forged')
        .send(report.params)
        .expect(204);
      const status = async () =>
        (await t.as(twilioOwner.token).get(url('/messages', twilioOrg)).expect(200)).body.items[0]
          .status as string;
      expect(await status()).toBe('sent');
      // A report for another provider's message address is ignored.
      await t
        .http()
        .post(path.replace('/twilio/', '/bulksmsbd/'))
        .type('form')
        .send(report.params)
        .expect(204);
      await t
        .http()
        .post(path)
        .type('form')
        .set('X-Twilio-Signature', report.signature)
        .send(report.params)
        .expect(204);
      expect(await status()).toBe('delivered');
    });
  });

  describe('tenancy', () => {
    it("one business never sees another's settings or messages", async () => {
      const mine = await messages();
      expect(mine.length).toBeGreaterThan(5);
      expect(await messages('', rivalOrgId).catch(() => 'forbidden')).toBe('forbidden');
      const theirs = (await t.as(rival.token).get(url('/messages', rivalOrgId)).expect(200)).body
        .items;
      expect(theirs).toEqual([]);
      await t.as(rival.token).get(url('', orgId)).expect(404);
      const rivalSettings = await settings(rivalOrgId, rival);
      expect(rivalSettings).toMatchObject({ mode: 'off', own: null, senderName: null });
    });
  });
});
