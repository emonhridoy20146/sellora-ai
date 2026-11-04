import { getQueueToken } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { AutomationsService } from '../../src/modules/campaigns/automations.service.js';
import { inSendWindow, nextSendTime } from '../../src/modules/campaigns/campaign-rules.js';
import { CampaignsService } from '../../src/modules/campaigns/campaigns.service.js';
import { SmsService, type SmsJob } from '../../src/modules/sms/sms.service.js';
import { SmsProcessor } from '../../src/workers/sms.processor.js';
import { FakeSmsProviders } from '../helpers/fake-sms.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface CampaignDto {
  id: string;
  name: string;
  status: string;
  text: string;
  audience: Record<string, unknown>;
  link: {
    kind: string;
    label: string | null;
    url: string | null;
    clicks: number;
    lastClickAt: string | null;
  };
  scheduledAt: string | null;
  pause: { reason: string } | null;
  wait: { reason: string; until: string } | null;
  counts: { recipients: number; queued: number; optedOut: number; unreachable: number };
  orders: { count: number; revenueMinor: number };
  estimate: { recipients: number; parts: number; totalMinor: number } | null;
  preview: { text: string; parts: number; language: string };
  progress: number;
  messages: { byStatus: Record<string, number>; spentMinor: number };
  stopped: number;
  testsLeft: number;
}

interface AutomationDto {
  kind: string;
  enabled: boolean;
  days: number;
  text: string;
  link: {
    kind: string;
    label: string | null;
    url: string | null;
    clicks: number;
    problem: string | null;
  };
  enabledAt: string | null;
  preview: { text: string; parts: number };
  last30Days: {
    planned: number;
    sent: number;
    skipped: number;
    orders: { count: number; revenueMinor: number };
  };
}

interface AutomationsDto {
  included: boolean;
  language: string;
  after_delivery: AutomationDto;
  win_back: AutomationDto;
}

const ALPHA_KEY = 'alpha-platform-key-0001';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const oid = (id: string) => new Types.ObjectId(id);

/**
 * A fixed-offset zone where it is `localHour` o'clock now, so "send now" is inside (or
 * outside) the 9 AM–9 PM hours whenever the suite runs.
 */
const zoneAt = (localHour: number): string => {
  let off = localHour - new Date().getUTCHours();
  if (off > 14) off -= 24;
  if (off < -12) off += 24;
  return off === 0 ? 'Etc/GMT' : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
};

const RAHIM = '+8801711111111';
const KARIM = '+8801722222222';
const SALMA = '+8801733333333';
const FOREIGN = '+447911123456';
const STOPPED = '+8801744444444';
const BLOCKED = '+8801755555555';

describe('SMS campaigns and automations', () => {
  const fake = new FakeSmsProviders();
  let t: TestApp;
  let platform: string;
  let owner: Session;
  let viewer: Session;
  let agent: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let zone: string;
  let saree: { id: string; variants: { id: string }[] };
  let draftProduct: { id: string };
  const orders: Record<string, { id: string; number: string; totalMinor: number }> = {};

  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const campaigns = () => t.app.get(CampaignsService);
  const automations = () => t.app.get(AutomationsService);
  const sms = () => t.app.get(SmsService);
  const smsQueue = () => t.app.get<Queue<SmsJob>>(getQueueToken(QUEUES.sms));
  const inTenant = <T>(fn: () => Promise<T>, org = orgId) =>
    RequestContext.withTenant(org, fn, { type: 'system', id: 'test' });
  const col = (model: string) => t.db.model(model).collection;

  const runSmsJobs = async () => {
    const processor = new SmsProcessor(sms(), smsQueue());
    for (const job of await smsQueue().getJobs(['waiting', 'delayed', 'prioritized'])) {
      if (job.name !== 'send') continue;
      await processor.process(job as Job<SmsJob>);
      await job.remove();
    }
  };
  const credit = (amountMinor: number, direction: 'credit' | 'debit' = 'credit') =>
    P()
      .post(`/v1/platform/billing/tenants/${orgId}/wallet/adjust`)
      .send({
        direction,
        type: direction === 'credit' ? 'topup' : 'adjustment',
        amountMinor,
        note: 'campaign test',
        idempotencyKey: `k-${new Types.ObjectId().toHexString()}`,
      })
      .expect(200);
  const cash = async () =>
    (await O().get(url('/billing/wallet')).expect(200)).body as {
      balanceMinor: number;
      bonusMinor: number;
      heldMinor: number;
    };
  const setZone = (tz: string) =>
    col('Organization').updateOne({ _id: oid(orgId) }, { $set: { timezone: tz } });
  const order = async (phone: string, name: string) =>
    (
      await O()
        .post(url('/orders'))
        .send({
          status: 'confirmed',
          customer: { name, phone },
          shippingAddress: { line1: 'House 12, Road 5', area: 'Dhanmondi', city: 'Dhaka' },
          items: [{ productId: saree.id, variantId: saree.variants[0]!.id, quantity: 1 }],
        })
        .expect(201)
    ).body as { id: string; number: string; totalMinor: number; customerId: string };
  const setStatus = (orderId: string, status: string) =>
    O()
      .post(url(`/orders/${orderId}/status`))
      .send({ status })
      .expect(200);
  const customer = (body: Record<string, unknown>) =>
    O().post(url('/customers')).send(body).expect(201);

  const create = (body: Record<string, unknown>) => O().post(url('/campaigns')).send(body);
  const get = async (id: string) =>
    (
      await O()
        .get(url(`/campaigns/${id}`))
        .expect(200)
    ).body as CampaignDto;
  const start = (id: string, body: Record<string, unknown> = {}) =>
    O()
      .post(url(`/campaigns/${id}/start`))
      .send(body);
  const sweep = (now = new Date()) => campaigns().sweep(now);
  const recipients = async (id: string, status?: string) =>
    (
      await O()
        .get(url(`/campaigns/${id}/recipients${status ? `?status=${status}` : ''}`))
        .expect(200)
    ).body.items as {
      phone: string;
      status: string;
      skip: string | null;
      message: { status: string } | null;
      order: { number: string } | null;
    }[];
  const automationsDto = async () =>
    (await O().get(url('/automations')).expect(200)).body as AutomationsDto;
  const patchAutomations = (body: Record<string, unknown>) =>
    O().patch(url('/automations')).send(body);
  const sendOf = (key: string) => col('AutomationSend').findOne({ orgId: oid(orgId), key });

  beforeAll(async () => {
    fake.alphaKeys.set(ALPHA_KEY, { balance: 1000 });
    t = await TestApp.create(
      { API_PUBLIC_URL: 'https://api.sellora.test', LOG_LEVEL: 'error' },
      { smsFetch: fake.fetch },
    );
    platform = (await t.platformOwner()).token;
    owner = await t.registerUser();
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor', category: 'handicrafts' })).id;
    viewer = await t.addMember(owner, orgId, 'viewer');
    agent = await t.addMember(owner, orgId, 'sales_agent');
    rival = await t.registerUser();
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Bazar' })).id;
    await Promise.all(
      [
        'Store',
        'Product',
        'Customer',
        'Order',
        'SmsMessage',
        'SmsOptOut',
        'Campaign',
        'CampaignRecipient',
        'MarketingLink',
        'AutomationSettings',
        'AutomationSend',
      ].map((m) => t.db.model(m).init()),
    );
    zone = zoneAt(13);
    await setZone(zone);

    // Sellora SMS through Alpha SMS, 0.50 a part, paid from wallet cash.
    await P()
      .put('/v1/platform/sms/gateway')
      .send({
        provider: 'alpha_sms',
        credentials: { apiKey: ALPHA_KEY },
        senderId: '8809612000000',
      })
      .expect(200);
    await P().patch('/v1/platform/sms').send({ enabled: true }).expect(200);
    await O().patch(url('/sms')).send({ mode: 'sellora' }).expect(200);

    saree = (
      await O()
        .post(url('/products'))
        .send({ name: 'Red saree', variants: [{ priceMinor: 125_000, stock: 500 }] })
        .expect(201)
    ).body;
    draftProduct = (
      await O()
        .post(url('/products'))
        .send({ name: 'Secret shawl', status: 'draft', variants: [{ priceMinor: 1_000 }] })
        .expect(201)
    ).body;
    const open = async (session: Session, org: string, name: string, handle: string) => {
      const store = (
        await t.as(session.token).post(`/v1/orgs/${org}/stores`).send({ name, handle }).expect(201)
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
    await open(owner, orgId, 'Nakshi Ghor', 'nakshi-ghor');
    await t
      .as(rival.token)
      .post(url('/products', rivalOrgId))
      .send({ name: 'Clay pot', variants: [{ priceMinor: 30_000, stock: 5 }] })
      .expect(201);
    await open(rival, rivalOrgId, 'Rival Bazar', 'rival-bazar');

    // Rahim ordered twice, Karim once; Salma, the foreign number and Stopped never did.
    orders.rahim1 = await order('01711111111', 'Rahim');
    orders.rahim2 = await order('01711111111', 'Rahim');
    orders.karim = await order('01722222222', 'Karim');
    const rahim = await O().get(url('/customers?q=01711111111')).expect(200);
    await O()
      .patch(url(`/customers/${rahim.body.items[0].id}`))
      .send({ tags: ['vip'] })
      .expect(200);
    await customer({ name: 'Salma', phone: '01733333333', tags: ['vip'] });
    await customer({ name: 'Jane', phone: FOREIGN });
    await customer({ name: 'Stopped', phone: '01744444444' });
    await customer({ name: 'Blocked', phone: '01755555555', blocked: true });
    await inTenant(() => sms().stop(STOPPED, 'staff'));
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    fake.reset();
    for (const job of await smsQueue().getJobs(['waiting', 'delayed', 'prioritized']))
      await job.remove();
  });

  describe('the editor', () => {
    it('lists the stores, the SMS price, wallet cash, today’s limit and the sending hours', async () => {
      const o = (await O().get(url('/campaigns/options')).expect(200)).body;
      expect(o).toMatchObject({
        included: true,
        timezone: zone,
        stores: [{ name: 'Nakshi Ghor', url: 'https://nakshi-ghor.shops.test' }],
        landingPages: [],
        tags: ['vip'],
        sms: { ready: true, pricePerPartMinor: 50, currency: 'BDT', reach: 'bd_mobile' },
        wallet: { cashMinor: 0 },
        sendWindow: { startHour: 9, endHour: 21 },
        maxParts: 6,
        maxTests: 5,
      });
      expect(o.placeholders.map((p: { key: string }) => p.key)).toEqual(['name', 'shop', 'link']);
      expect(o.daily.limit).toBe(1000);
    });

    it('counts who an audience reaches and who is left out', async () => {
      const count = async (audience: Record<string, unknown>) =>
        (await O().post(url('/campaigns/audience')).send(audience).expect(200)).body as Record<
          string,
          number
        >;
      // Blocked customers are never counted; the stop and the foreign number are shown apart.
      expect(await count({ ordered: 'any' })).toEqual({
        customers: 5,
        optedOut: 1,
        unreachable: 1,
        recipients: 3,
      });
      expect((await count({ ordered: 'ordered' })).recipients).toBe(2);
      expect((await count({ ordered: 'any', tags: ['vip'] })).recipients).toBe(2);
      expect((await count({ ordered: 'ordered', minOrders: 2 })).recipients).toBe(1);
      expect((await count({ ordered: 'any', minSpentMinor: 200_000 })).recipients).toBe(1);
      expect((await count({ ordered: 'ordered', noOrderForDays: 30 })).recipients).toBe(0);
      expect((await count({ ordered: 'ordered', orderedWithinDays: 7 })).recipients).toBe(2);
      const odd = await O()
        .post(url('/campaigns/audience'))
        .send({ ordered: 'any', orderedWithinDays: 30, noOrderForDays: 60 })
        .expect(422);
      expect(odd.body.errors[0].path).toContain('noOrderForDays');
    });

    it('lets marketing viewers look but not change; sales agents see nothing', async () => {
      await t.as(viewer.token).get(url('/campaigns/options')).expect(200);
      await t.as(viewer.token).get(url('/campaigns')).expect(200);
      await t.as(viewer.token).post(url('/campaigns')).send({ name: 'x' }).expect(403);
      await t.as(agent.token).get(url('/campaigns')).expect(403);
      await t.as(agent.token).get(url('/automations')).expect(403);
    });

    it('checks the text against the link before saving', async () => {
      const noLink = await create({
        name: 'Eid collection',
        text: 'Hi {name}, Eid collection at {shop}: {link}',
      }).expect(422);
      expect(noLink.body.errors[0]).toMatchObject({
        path: 'text',
        message: expect.stringContaining('Choose where {link} goes'),
      });
      const unknown = await create({ text: 'Use {coupon}' }).expect(422);
      expect(unknown.body.errors[0].message).toContain('{coupon}');
      const draft = await create({
        text: 'New {link}',
        link: { kind: 'product', targetId: draftProduct.id },
      }).expect(422);
      expect(draft.body.errors[0]).toEqual({
        path: 'link',
        message: 'That product is not on sale.',
      });
      const page = await create({
        text: 'New {link}',
        link: { kind: 'landing_page', targetId: new Types.ObjectId().toHexString() },
      }).expect(422);
      expect(page.body.errors[0].message).toBe('That landing page was not found.');
      const check = await O()
        .post(url('/campaigns/check'))
        .send({ text: `${'Big Eid sale today only. '.repeat(30)}`, link: { kind: 'none' } })
        .expect(200);
      expect(check.body.errors[0].message).toContain('At most 480 characters');
    });

    it('saves a draft with a store link and previews it with a sample code and the stop link', async () => {
      const res = await create({
        name: 'Eid collection',
        text: 'Hi {name}, Eid collection at {shop}: {link}',
        audience: { ordered: 'any' },
        link: { kind: 'store' },
      }).expect(201);
      const c = res.body as CampaignDto;
      expect(c).toMatchObject({
        name: 'Eid collection',
        status: 'draft',
        link: { kind: 'store', label: 'Nakshi Ghor', url: null, clicks: 0 },
        testsLeft: 5,
        progress: 0,
      });
      expect(c.preview).toMatchObject({ parts: 1, language: 'en' });
      expect(c.preview.text).toBe(
        'Hi Rahim, Eid collection at Nakshi Ghor: https://nakshi-ghor.shops.test/c/Ab12Cd34 Stop: http://localhost:3000/u/Ab12Cd34',
      );
      const product = await create({
        name: 'Saree',
        text: 'New: {link}',
        link: { kind: 'product', targetId: saree.id },
      }).expect(201);
      expect(product.body.link).toMatchObject({
        kind: 'product',
        label: 'Red saree',
        path: expect.stringMatching(/^\/products\//),
      });
    });

    it('keeps each business’s campaigns to itself', async () => {
      const [mine] = (await O().get(url('/campaigns')).expect(200)).body.items as CampaignDto[];
      await t
        .as(rival.token)
        .get(url(`/campaigns/${mine!.id}`, rivalOrgId))
        .expect(404);
      await t
        .as(rival.token)
        .get(url(`/campaigns/${mine!.id}`))
        .expect(404);
      await t
        .as(rival.token)
        .post(url(`/campaigns/${mine!.id}/start`, rivalOrgId))
        .send({})
        .expect(404);
      expect(
        (await t.as(rival.token).get(url('/campaigns', rivalOrgId)).expect(200)).body.items,
      ).toEqual([]);
    });

    it('changes, copies and deletes drafts', async () => {
      const c = (await create({ name: 'Old name', text: 'Hello from {shop}' }).expect(201))
        .body as CampaignDto;
      const changed = await O()
        .patch(url(`/campaigns/${c.id}`))
        .send({ name: 'Winter sale', text: 'Winter sale at {shop}!' })
        .expect(200);
      expect(changed.body).toMatchObject({ name: 'Winter sale', text: 'Winter sale at {shop}!' });
      const copy = await O()
        .post(url(`/campaigns/${c.id}/duplicate`))
        .expect(201);
      expect(copy.body).toMatchObject({ name: 'Winter sale (copy)', status: 'draft' });
      await O()
        .delete(url(`/campaigns/${copy.body.id}`))
        .expect(204);
      await O()
        .get(url(`/campaigns/${copy.body.id}`))
        .expect(404);
      await O()
        .delete(url(`/campaigns/${c.id}`))
        .expect(204);
    });
  });

  describe('sending a campaign', () => {
    let eid: CampaignDto;
    let code: string;

    beforeAll(async () => {
      const items = (await O().get(url('/campaigns')).expect(200)).body.items as CampaignDto[];
      eid = items.find((c) => c.name === 'Eid collection')!;
    });

    it('will not start without wallet cash for everyone', async () => {
      const res = await start(eid.id).expect(402);
      expect(res.body.code).toBe('insufficient_balance');
      expect(res.body.detail).toContain('needs about');
      expect((await get(eid.id)).status).toBe('draft');
    });

    it('sends a test with the real short link, and counts the tests', async () => {
      await credit(1_000);
      const res = await O()
        .post(url(`/campaigns/${eid.id}/test`))
        .send({ to: '01799999999' })
        .expect(200);
      expect(res.body).toMatchObject({ status: 'sent', purpose: 'test', priceMinor: 50 });
      expect(fake.sent).toHaveLength(1);
      const m =
        /https:\/\/nakshi-ghor\.shops\.test\/c\/([A-Za-z0-9]{8}) Stop: http:\/\/localhost:3000\/u\/\w+$/.exec(
          fake.sent[0]!.text,
        );
      expect(m).not.toBeNull();
      code = m![1]!;
      expect(fake.sent[0]!.text.startsWith('Hi Rahim, Eid collection at Nakshi Ghor: ')).toBe(true);
      const c = await get(eid.id);
      expect(c.testsLeft).toBe(4);
      expect(c.link.url).toBe(`https://nakshi-ghor.shops.test/c/${code}`);
    });

    it('refuses to send now outside 9 AM–9 PM, and to schedule a time outside them', async () => {
      await setZone(zoneAt(2));
      const night = await start(eid.id).expect(422);
      expect(night.body.code).toBe('outside_hours');
      await setZone(zone);
      const soon = await start(eid.id, { at: new Date(Date.now() + 60_000).toISOString() }).expect(
        422,
      );
      expect(soon.body.errors[0].path).toBe('at');
      const late = await start(eid.id, {
        at: new Date(Date.now() + 12 * HOUR).toISOString(),
      }).expect(422);
      expect(late.body.errors[0].message).toContain('between 9 AM and 9 PM');
    });

    it('writes the audience down, then sends in batches through the SMS worker', async () => {
      const started = (await start(eid.id).expect(200)).body as CampaignDto;
      expect(started).toMatchObject({
        status: 'sending',
        // The foreign number is written down too, and skipped when its batch comes.
        counts: { recipients: 5, optedOut: 1, queued: 0, unreachable: 0 },
        estimate: { recipients: 3, parts: 1, totalMinor: 150 },
      });
      expect(await sweep()).toEqual({ batch: 1 });
      await runSmsJobs();
      const texts = fake.sent.map((m) => m.text);
      expect(texts).toHaveLength(3);
      for (const text of texts) {
        expect(text).toContain(
          `https://nakshi-ghor.shops.test/c/${code} Stop: http://localhost:3000/u/`,
        );
      }
      expect(texts.some((x) => x.startsWith('Hi Karim,'))).toBe(true);
      // The next sweep finds nobody left and closes it.
      await col('Campaign').updateOne({ _id: oid(eid.id) }, { $set: { nextRunAt: new Date() } });
      expect(await sweep()).toEqual({ finished: 1 });
      const done = await get(eid.id);
      expect(done).toMatchObject({
        status: 'sent',
        counts: { recipients: 5, queued: 3, optedOut: 1, unreachable: 1 },
        progress: 1,
        messages: { spentMinor: 150 },
      });
      expect(done.messages.byStatus.sent).toBe(3);
      // The blocked customer was never written down.
      expect((await recipients(eid.id)).map((r) => r.phone)).not.toContain(BLOCKED);
      const rows = await recipients(eid.id, 'skipped');
      expect(rows.map((r) => [r.phone, r.skip]).sort()).toEqual(
        [
          [STOPPED, 'opted_out'],
          [FOREIGN, 'unreachable'],
        ].sort(),
      );
      const audit = await col('AuditEvent').findOne({
        orgId: oid(orgId),
        action: 'campaign.started',
      });
      expect(audit?.metadata).toMatchObject({ recipients: 5, estimateMinor: 150 });
    });

    it('does not text a number twice when a batch runs again', async () => {
      await col('CampaignRecipient').updateMany(
        { campaignId: oid(eid.id), phone: RAHIM },
        { $set: { status: 'pending' }, $unset: { messageId: '' } },
      );
      await col('Campaign').updateOne(
        { _id: oid(eid.id) },
        { $set: { status: 'sending', nextRunAt: new Date() } },
      );
      expect(await sweep()).toEqual({ batch: 1 });
      await runSmsJobs();
      expect(fake.sent).toHaveLength(0);
      const [row] = (await recipients(eid.id, 'queued')).filter((r) => r.phone === RAHIM);
      expect(row!.message?.status).toBe('sent');
      expect((await get(eid.id)).counts).toMatchObject({ recipients: 5, queued: 3 });
      await col('Campaign').updateOne({ _id: oid(eid.id) }, { $set: { nextRunAt: new Date() } });
      expect(await sweep()).toEqual({ finished: 1 });
    });

    it('sends shoppers on from the short link with tracking tags and counts the click', async () => {
      const shop = (h: string, c = code) =>
        t
          .http()
          .get(`/v1/storefront/links/${c}`)
          .set('x-storefront-key', t.env.STOREFRONT_API_KEY!)
          .set('x-store-host', h);
      const res = await shop('nakshi-ghor.shops.test').expect(200);
      expect(res.body).toEqual({
        path: '/',
        query: { utm_source: 'sms', utm_medium: 'sms', utm_campaign: 'eid-collection' },
      });
      await shop('rival-bazar.shops.test').expect(404);
      await shop('nakshi-ghor.shops.test', 'Zz99Zz99').expect(404);
      await t
        .http()
        .get(`/v1/storefront/links/${code}`)
        .set('x-store-host', 'nakshi-ghor.shops.test')
        .expect(401);
      expect((await get(eid.id)).link).toMatchObject({
        clicks: 1,
        lastClickAt: expect.any(String),
      });
    });

    it('counts an order from a recipient once, and none from other numbers', async () => {
      const o = await order('01722222222', 'Karim');
      await vi.waitFor(async () => expect((await get(eid.id)).orders.count).toBe(1));
      await order('01722222222', 'Karim');
      await order('01766666666', 'Rina');
      await new Promise((r) => setTimeout(r, 300));
      expect((await get(eid.id)).orders).toEqual({ count: 1, revenueMinor: o.totalMinor });
      const ordered = await recipients(eid.id, 'ordered');
      expect(ordered.map((r) => [r.phone, r.order?.number])).toEqual([[KARIM, o.number]]);
    });

    it('shows how many recipients pressed stop after it', async () => {
      await inTenant(() => sms().stop(SALMA, 'link'));
      expect((await get(eid.id)).stopped).toBe(1);
    });

    it('cannot be changed or deleted once sent', async () => {
      await O()
        .patch(url(`/campaigns/${eid.id}`))
        .send({ text: 'Changed {link}' })
        .expect(409);
      await O()
        .delete(url(`/campaigns/${eid.id}`))
        .expect(409);
      await start(eid.id).expect(409);
    });
  });

  describe('pacing: night, today’s limit, wallet cash, staff', () => {
    /** Customers who ordered and can get a text now. */
    const ordered = async () =>
      (await O().post(url('/campaigns/audience')).send({ ordered: 'ordered' }).expect(200)).body
        .recipients as number;
    /** A started campaign to customers who ordered. */
    const startOrdered = async (name: string) => {
      const c = (
        await create({
          name,
          text: 'Eid offer at {shop} for {name}',
          audience: { ordered: 'ordered' },
        }).expect(201)
      ).body as CampaignDto;
      await start(c.id).expect(200);
      return c.id;
    };

    it('waits for the morning when the sweep comes at night', async () => {
      const id = await startOrdered('Night');
      const night = new Date(Date.now() + 13 * HOUR); // 2 AM local
      expect(inSendWindow(night, zone)).toBe(false);
      expect(await sweep(night)).toEqual({ night: 1 });
      const waiting = await get(id);
      const morning = nextSendTime(night, zone);
      expect(waiting).toMatchObject({ status: 'sending', wait: { reason: 'night' } });
      expect(new Date(waiting.wait!.until)).toEqual(morning);
      expect(await sweep(new Date(morning.getTime() - 1000))).toEqual({});
      expect(await sweep(morning)).toEqual({ batch: 1 });
      expect((await get(id)).counts.queued).toBe(await ordered());
      expect((await get(id)).wait).toBeNull();
    });

    it('cuts a batch to today’s SMS limit and carries on tomorrow', async () => {
      const id = await startOrdered('Limit');
      const sent = await inTenant(() => sms().sentToday());
      await col('SmsSettings').updateOne({ orgId: oid(orgId) }, { $set: { dailyLimit: sent + 1 } });
      expect(await sweep()).toEqual({ batch: 1 });
      expect((await get(id)).counts.queued).toBe(1);
      await col('Campaign').updateOne({ _id: oid(id) }, { $set: { nextRunAt: new Date() } });
      expect(await sweep()).toEqual({ daily_limit: 1 });
      const waiting = await get(id);
      expect(waiting.wait?.reason).toBe('daily_limit');
      await col('SmsSettings').updateOne({ orgId: oid(orgId) }, { $unset: { dailyLimit: '' } });
      const tomorrow = new Date(waiting.wait!.until);
      expect(await sweep(tomorrow)).toEqual({ batch: 1 });
      expect((await get(id)).counts.queued).toBe(await ordered());
    });

    it('pauses when wallet cash runs out, emails the owner, and resumes after a top-up', async () => {
      const id = await startOrdered('Wallet');
      const w = await cash();
      await credit(w.balanceMinor - w.bonusMinor - w.heldMinor - 10, 'debit');
      expect(await sweep()).toEqual({ 'paused:wallet': 1 });
      expect(await get(id)).toMatchObject({ status: 'paused', pause: { reason: 'wallet' } });
      const mail = (await t.outbox(owner.email)).find((m) => m.category === 'marketing');
      expect(mail?.subject).toBe('Campaign "Wallet" paused: not enough wallet cash');
      expect(mail?.text).toContain(`/app/${orgId}/marketing/campaigns/${id}`);
      await credit(1_000);
      await O()
        .post(url(`/campaigns/${id}/resume`))
        .expect(200);
      expect(await sweep()).toEqual({ batch: 1 });
      expect((await get(id)).counts.queued).toBe(await ordered());
    });

    it('pauses when SMS is turned off, and will not resume until it is back', async () => {
      const id = await startOrdered('SMS off');
      await O().patch(url('/sms')).send({ mode: 'off' }).expect(200);
      expect(await sweep()).toEqual({ 'paused:sms_off': 1 });
      const res = await O()
        .post(url(`/campaigns/${id}/resume`))
        .expect(422);
      expect(res.body.code).toBe('sms_off');
      await O().patch(url('/sms')).send({ mode: 'sellora' }).expect(200);
      await O()
        .post(url(`/campaigns/${id}/resume`))
        .expect(200);
      expect(await sweep()).toEqual({ batch: 1 });
    });

    it('lets staff pause, resume and cancel; cancelling skips whoever is left', async () => {
      const id = await startOrdered('Staff');
      const paused = await O()
        .post(url(`/campaigns/${id}/pause`))
        .expect(200);
      expect(paused.body).toMatchObject({ status: 'paused', pause: { reason: 'staff' } });
      expect(await sweep()).toEqual({});
      await O()
        .post(url(`/campaigns/${id}/pause`))
        .expect(409);
      await O()
        .post(url(`/campaigns/${id}/resume`))
        .expect(200);
      const cancelled = await O()
        .post(url(`/campaigns/${id}/cancel`))
        .expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      expect(await sweep()).toEqual({});
      const rows = await recipients(id, 'skipped');
      expect(rows.length).toBe(await ordered());
      expect(new Set(rows.map((r) => r.skip))).toEqual(new Set(['cancelled']));
      const audit = await col('AuditEvent').findOne({
        orgId: oid(orgId),
        action: 'campaign.cancelled',
      });
      expect(audit).not.toBeNull();
    });

    it('starts a scheduled campaign at its time, and it can be changed until then', async () => {
      const c = (
        await create({
          name: 'Later',
          text: 'Later at {shop}',
          audience: { ordered: 'ordered' },
        }).expect(201)
      ).body as CampaignDto;
      const at = new Date(Date.now() + 2 * HOUR); // 3 PM local
      const scheduled = await start(c.id, { at: at.toISOString() }).expect(200);
      expect(scheduled.body).toMatchObject({ status: 'scheduled', scheduledAt: at.toISOString() });
      await O()
        .patch(url(`/campaigns/${c.id}`))
        .send({ text: 'Later today at {shop}' })
        .expect(200);
      expect(await sweep()).toEqual({});
      expect((await sweep(at)).started).toBe(1);
      expect(await get(c.id)).toMatchObject({
        status: 'sending',
        counts: { recipients: await ordered() },
      });
      expect(await sweep(new Date(at.getTime() + 1000))).toEqual({ batch: 1 });
      await runSmsJobs();
      expect(fake.sent.filter((m) => m.text.startsWith('Later today at Nakshi Ghor'))).toHaveLength(
        await ordered(),
      );
    });

    it('pauses a scheduled campaign whose link page stopped being on sale', async () => {
      const c = (
        await create({
          name: 'Saree day',
          text: 'Saree day: {link}',
          audience: { ordered: 'ordered' },
          link: { kind: 'product', targetId: saree.id },
        }).expect(201)
      ).body as CampaignDto;
      const at = new Date(Date.now() + 2 * HOUR);
      await start(c.id, { at: at.toISOString() }).expect(200);
      await col('Product').updateOne({ _id: oid(saree.id) }, { $set: { status: 'archived' } });
      expect((await sweep(at))['paused:invalid']).toBe(1);
      expect((await get(c.id)).pause?.reason).toBe('invalid');
      await col('Product').updateOne({ _id: oid(saree.id) }, { $set: { status: 'active' } });
      await O()
        .post(url(`/campaigns/${c.id}/resume`))
        .expect(200);
      expect((await get(c.id)).status).toBe('scheduled');
      expect((await sweep(at)).started).toBe(1);
    });
  });

  describe('automations', () => {
    it('start switched off, with texts in the business language and no link', async () => {
      const a = await automationsDto();
      expect(a).toMatchObject({ included: true, language: 'en' });
      expect(a.after_delivery).toMatchObject({
        enabled: false,
        days: 3,
        text: 'Hi {name}, thank you for shopping at {shop}! We hope you like your order {order}.',
        link: { kind: 'none' },
      });
      expect(a.after_delivery.preview.text).toMatch(
        /^Hi Rahim, thank you for shopping at Nakshi Ghor! We hope you like your order SL-1042\. Stop: /,
      );
      expect(a.win_back).toMatchObject({ enabled: false, days: 60 });
    });

    it('checks the days, placeholders and link, and only marketing managers change them', async () => {
      const days = await patchAutomations({ after_delivery: { days: 4 } }).expect(422);
      expect(days.body.errors[0].path).toBe('after_delivery.days');
      const order = await patchAutomations({ win_back: { text: 'Your order {order}' } }).expect(
        422,
      );
      expect(order.body.errors[0]).toMatchObject({ path: 'win_back.text' });
      const link = await patchAutomations({ win_back: { link: { kind: 'store' } } }).expect(422);
      expect(link.body.errors[0].message).toContain('Put {link} in the message');
      await t.as(viewer.token).get(url('/automations')).expect(200);
      await t
        .as(viewer.token)
        .patch(url('/automations'))
        .send({ after_delivery: { enabled: true } })
        .expect(403);
    });

    it('plans the thank-you when an order is delivered, and sends it N days later', async () => {
      const on = await patchAutomations({
        after_delivery: {
          enabled: true,
          text: 'Thanks {name}! Hope you love order {order}. More: {link}',
          link: { kind: 'store' },
        },
      }).expect(200);
      expect(on.body.after_delivery).toMatchObject({
        enabled: true,
        enabledAt: expect.any(String),
      });
      const audit = await col('AuditEvent').findOne({
        orgId: oid(orgId),
        action: 'automation.updated',
      });
      expect(audit?.metadata).toMatchObject({ 'after_delivery.enabled': true });

      const o = orders.rahim1!;
      await setStatus(o.id, 'shipped');
      await setStatus(o.id, 'delivered');
      const planned = await vi.waitFor(async () => {
        const s = await sendOf(`after_delivery:${o.id}`);
        expect(s).not.toBeNull();
        return s!;
      });
      expect(planned).toMatchObject({ status: 'pending', phone: RAHIM, orderNumber: o.number });
      expect(planned.dueAt.getTime() - Date.now()).toBeGreaterThan(3 * DAY - HOUR);
      expect(await automations().sendDue()).toEqual({});
      const due = new Date(planned.dueAt.getTime() + 1000);
      expect(await automations().sendDue(due)).toEqual({ sent: 1 });
      await runSmsJobs();
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]!.text).toMatch(
        new RegExp(
          `^Thanks Rahim! Hope you love order ${o.number}\\. More: https://nakshi-ghor\\.shops\\.test/c/[A-Za-z0-9]{8} Stop: `,
        ),
      );
      const msg = await col('SmsMessage').findOne({
        orgId: oid(orgId),
        key: `auto:after_delivery:${o.id}`,
      });
      expect(msg).toMatchObject({
        purpose: 'automation',
        ref: { type: 'automation', id: 'after_delivery' },
      });
    });

    it('skips the thank-you when the order came back before it went', async () => {
      const o = orders.karim!;
      await setStatus(o.id, 'shipped');
      await setStatus(o.id, 'delivered');
      const planned = await vi.waitFor(async () => {
        const s = await sendOf(`after_delivery:${o.id}`);
        expect(s).not.toBeNull();
        return s!;
      });
      await setStatus(o.id, 'returned');
      expect(await automations().sendDue(new Date(planned.dueAt.getTime() + 1000))).toEqual({
        'skipped:returned': 1,
      });
    });

    it('texts customers whose last order turned N days old after it was switched on', async () => {
      const now = Date.now();
      await patchAutomations({ win_back: { enabled: true, days: 30 } }).expect(200);
      const lapse = async (name: string, phone: string, ago: number) => {
        const c = await customer({ name, phone });
        await col('Customer').updateOne(
          { _id: oid(c.body.id) },
          { $set: { 'stats.orders': 1, 'stats.lastOrderAt': new Date(now - ago) } },
        );
        return c.body.id as string;
      };
      await lapse('Old', '01781111111', 29.5 * DAY);
      const again = await lapse('Again', '01782222222', 29.6 * DAY);
      await lapse('Long gone', '01783333333', 40 * DAY);
      // Gap's 30 days ran out too, but a campaign texted the number an hour ago.
      const gap = await lapse('Gap', '01786666666', 29.5 * DAY);
      await col('CampaignRecipient').insertOne({
        orgId: oid(orgId),
        campaignId: new Types.ObjectId(),
        customerId: oid(gap),
        phone: '+8801786666666',
        name: 'Gap',
        status: 'queued',
        queuedAt: new Date(now - HOUR),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const later = new Date(now + 20 * HOUR); // 9 AM local tomorrow
      expect(inSendWindow(later, zone)).toBe(true);
      expect(await inTenant(() => automations().planWinBackHere(later))).toBe(3);
      // Planned again: nobody twice.
      await col('AutomationSettings').updateOne(
        { orgId: oid(orgId) },
        { $set: { winBackCheckedAt: new Date(now) } },
      );
      expect(await inTenant(() => automations().planWinBackHere(later))).toBe(0);

      await col('Customer').updateOne(
        { _id: oid(again) },
        { $set: { 'stats.lastOrderAt': new Date(now) } },
      );
      const out = await automations().sendDue(later);
      expect(out).toEqual({ sent: 1, 'skipped:ordered_again': 1, gap: 1 });
      await runSmsJobs();
      expect(fake.sent.map((m) => m.text.split(',')[0])).toEqual(['Hi Old']);
      const gapSend = await col('AutomationSend').findOne({
        orgId: oid(orgId),
        customerId: oid(gap),
        kind: 'win_back',
      });
      expect(gapSend!.status).toBe('pending');
      // Moved to 24 hours after the campaign text, then sent.
      expect(gapSend!.dueAt).toEqual(nextSendTime(new Date(now + 23 * HOUR), zone));
      expect(await automations().sendDue(new Date(now + 26 * HOUR))).toEqual({ sent: 1 });
    });

    it('skips a text that would go more than 3 days late, and texts nobody once switched off', async () => {
      const late = new Date(Date.now() - 4 * DAY);
      await col('AutomationSend').insertOne({
        orgId: oid(orgId),
        kind: 'win_back',
        key: 'win_back:late-test:1',
        customerId: new Types.ObjectId(),
        phone: '+8801784444444',
        name: 'Late',
        dueAt: late,
        firstDueAt: late,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(await automations().sendDue()).toEqual({ 'skipped:late': 1 });

      await patchAutomations({ win_back: { enabled: false } }).expect(200);
      const soon = new Date(Date.now() + HOUR);
      await col('AutomationSend').insertOne({
        orgId: oid(orgId),
        kind: 'win_back',
        key: 'win_back:off-test:1',
        customerId: new Types.ObjectId(),
        phone: '+8801785555555',
        name: 'Off',
        dueAt: soon,
        firstDueAt: soon,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(await automations().sendDue(soon)).toEqual({ 'skipped:off': 1 });
    });

    it('counts an order after an automation text and lists what was sent', async () => {
      // The text went an hour ago (the sweep above ran "tomorrow").
      await col('AutomationSend').updateOne(
        { orgId: oid(orgId), phone: '+8801781111111', kind: 'win_back' },
        { $set: { sentAt: new Date(Date.now() - HOUR) } },
      );
      await order('01781111111', 'Old');
      await vi.waitFor(async () =>
        expect((await automationsDto()).win_back.last30Days.orders.count).toBe(1),
      );
      const a = await automationsDto();
      expect(a.win_back.last30Days).toMatchObject({ sent: 2 });
      expect(a.after_delivery.last30Days).toMatchObject({ sent: 1, skipped: 1 });
      const sends = (await O().get(url('/automations/sends?kind=win_back&status=sent')).expect(200))
        .body.items as { name: string; message: { status: string } | null; order: unknown }[];
      expect(sends.map((s) => s.name).sort()).toEqual(['Gap', 'Old']);
      expect(sends.find((s) => s.name === 'Old')!.order).not.toBeNull();
    });

    it('need the marketing module to be switched on', async () => {
      await P()
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ note: 'campaign test', removeModules: ['marketing'] })
        .expect(200);
      const blocked = await O().get(url('/automations')).expect(402);
      expect(blocked.body.code).toBe('module_not_in_plan');
      await O().get(url('/campaigns')).expect(402);
      await P()
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ note: 'campaign test', removeModules: [] })
        .expect(200);
    });
  });
});
