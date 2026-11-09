import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

/**
 * Reports: the value dashboard and first analytics (ADR 0026). The period's messages, orders,
 * carts and AI usage are written straight to the database at known times, so every number
 * the overview returns can be worked out by hand below. Dates are in early October 2026; the
 * business is in Asia/Dhaka (UTC+6), so days are Dhaka days.
 */
describe('Reports: value dashboard and first analytics (ADR 0026)', () => {
  let t: TestApp;
  let platform: string;
  let owner: Session;
  let accountant: Session;
  let packer: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;

  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const at = (iso: string) => new Date(iso);
  const plus = (iso: string, seconds: number) => new Date(at(iso).getTime() + seconds * 1000);
  // 1 to 8 October 2026 in Dhaka.
  const FROM = '2026-09-30T18:00:00.000Z';
  const TO = '2026-10-08T18:00:00.000Z';
  const range = `from=${FROM}&to=${TO}`;
  const AI = { type: 'system', id: 'ai-agent' };
  const STAFF = { type: 'user', id: new Types.ObjectId().toHexString() };
  const RISKY_PHONE = '+8801711000001';
  const SAFE_PHONE = '+8801711000002';
  const SAREE = new Types.ObjectId();
  const PANJABI = new Types.ObjectId();

  /** Writes one business's period: the same shape for us and for the rival. */
  async function seed(org: string) {
    const o = new Types.ObjectId(org);
    const db = t.db;
    const web = new Types.ObjectId();
    const wa = new Types.ObjectId();
    await db.collection('channels').insertMany([
      { _id: web, orgId: o, type: 'web_chat', name: 'Website', status: 'active' },
      { _id: wa, orgId: o, type: 'whatsapp', name: 'WhatsApp', status: 'active' },
    ]);
    const conv = () => new Types.ObjectId();
    const [c1, c2, c3, c4, c5, old] = [conv(), conv(), conv(), conv(), conv(), conv()];
    const msg = (
      conversationId: Types.ObjectId,
      channelId: Types.ObjectId,
      createdAt: Date,
      who: 'contact' | 'ai' | 'user' | 'system',
      type = 'text',
    ) => ({
      orgId: o,
      conversationId,
      channelId,
      direction: who === 'contact' ? 'in' : 'out',
      type: who === 'system' ? 'system' : type,
      sender: { type: who },
      text: 'x',
      attachments: [],
      delivery: { status: 'sent' },
      createdAt,
      updatedAt: createdAt,
    });
    await db.collection('messages').insertMany([
      // 1: answered by the AI only (WhatsApp), replies after 30 s and 90 s.
      msg(c1, wa, at('2026-10-02T04:00:00Z'), 'contact', 'audio'),
      msg(c1, wa, plus('2026-10-02T04:00:00Z', 30), 'ai'),
      msg(c1, wa, plus('2026-10-02T04:00:00Z', 600), 'contact'),
      msg(c1, wa, plus('2026-10-02T04:00:00Z', 690), 'ai'),
      // 2: the AI first (10 s), then the team (300 s) on the website chat.
      msg(c2, web, at('2026-10-03T05:00:00Z'), 'contact'),
      msg(c2, web, plus('2026-10-03T05:00:00Z', 10), 'ai'),
      msg(c2, web, plus('2026-10-03T05:00:00Z', 3600), 'contact'),
      msg(c2, web, plus('2026-10-03T05:00:00Z', 3600), 'system'),
      msg(c2, web, plus('2026-10-03T05:00:00Z', 3900), 'user'),
      { ...msg(c2, web, plus('2026-10-03T05:00:00Z', 3950), 'user'), type: 'note' },
      // 3: the team only (600 s), WhatsApp.
      msg(c3, wa, at('2026-10-04T06:00:00Z'), 'contact'),
      msg(c3, wa, plus('2026-10-04T06:00:00Z', 600), 'user'),
      // 4: 19:30 UTC on 1 October is 01:30 on 2 October in Dhaka; never answered.
      msg(c4, web, at('2026-10-01T19:30:00Z'), 'contact'),
      // 5: the team only (120 s), website chat.
      msg(c5, web, at('2026-10-05T03:00:00Z'), 'contact'),
      msg(c5, web, plus('2026-10-05T03:00:00Z', 120), 'user'),
      // Before the period.
      msg(old, web, at('2026-09-29T00:00:00Z'), 'contact'),
      msg(old, web, plus('2026-09-29T00:00:00Z', 5), 'ai'),
    ]);

    const usage = (
      feature: string,
      status: string,
      settledAt: Date,
      billedMinor: number,
      shortfallMinor = 0,
      currency = 'BDT',
    ) => ({
      orgId: o,
      requestId: `r-${new Types.ObjectId().toHexString()}`,
      feature,
      status,
      currency,
      settledAt,
      billedMinor,
      shortfallMinor,
      credits: billedMinor / 10,
      createdAt: settledAt,
    });
    await db.collection('ai_usage').insertMany([
      usage('ai_agent_reply', 'settled', at('2026-10-02T04:00:31Z'), 1200),
      usage('voice_note_transcription', 'settled', at('2026-10-02T04:00:10Z'), 11),
      usage('ai_agent_reply', 'settled', at('2026-10-03T05:00:11Z'), 900, 100),
      usage('ai_agent_reply', 'released', at('2026-10-03T05:00:11Z'), 5000),
      usage('ai_agent_reply', 'settled', at('2026-09-29T00:00:05Z'), 7000),
      // Billed in another currency (a wallet from before a currency change): not added in.
      usage('ai_agent_reply', 'settled', at('2026-10-03T06:00:00Z'), 300, 0, 'USD'),
    ]);

    let seq = 0;
    const order = (
      placedAt: string,
      status: string,
      source: string,
      totalMinor: number,
      items: { productId: Types.ObjectId; name: string; quantity: number; totalMinor: number }[],
      extra: {
        actor?: object;
        phone?: string;
        deliveryChargeMinor?: number;
        history?: string[];
      } = {},
    ) => {
      seq += 1;
      return {
        orgId: o,
        number: `SL-${seq}`,
        seq,
        status,
        source,
        currency: 'BDT',
        customerId: new Types.ObjectId(),
        customer: { name: 'Rahim', ...(extra.phone ? { phone: extra.phone } : {}) },
        items,
        subtotalMinor: totalMinor,
        discountMinor: 0,
        deliveryChargeMinor: extra.deliveryChargeMinor ?? 10000,
        totalMinor,
        history: (extra.history ?? [status]).map((s, i) => ({
          status: s,
          at: at(placedAt),
          actor: i === 0 ? (extra.actor ?? STAFF) : STAFF,
        })),
        placedAt: at(placedAt),
      };
    };
    const saree = (quantity: number, totalMinor: number) => ({
      productId: SAREE,
      name: 'Red jamdani saree',
      quantity,
      totalMinor,
    });
    const panjabi = (quantity: number, totalMinor: number) => ({
      productId: PANJABI,
      name: 'Blue panjabi',
      quantity,
      totalMinor,
    });
    await db.collection('orders').insertMany([
      // Placed by the AI sales agent in a chat: 11:00 on 2 October in Dhaka.
      order('2026-10-02T05:00:00Z', 'pending', 'inbox', 250000, [saree(1, 240000)], {
        actor: AI,
      }),
      order('2026-10-03T06:00:00Z', 'delivered', 'manual', 150000, [panjabi(2, 140000)], {
        history: ['pending', 'shipped', 'delivered'],
      }),
      order('2026-10-04T07:00:00Z', 'confirmed', 'store', 120000, [saree(1, 110000)]),
      // Cancelled before shipping: a risky number, then a safe one.
      order('2026-10-05T08:00:00Z', 'cancelled', 'store', 90000, [saree(1, 80000)], {
        phone: RISKY_PHONE,
        deliveryChargeMinor: 12000,
        history: ['pending', 'cancelled'],
      }),
      order('2026-10-05T09:00:00Z', 'cancelled', 'manual', 60000, [panjabi(1, 50000)], {
        phone: SAFE_PHONE,
        deliveryChargeMinor: 8000,
        history: ['pending', 'cancelled'],
      }),
      // Cancelled after it was shipped: not a stopped order.
      order('2026-10-05T10:00:00Z', 'cancelled', 'manual', 60000, [panjabi(1, 50000)], {
        phone: RISKY_PHONE,
        history: ['pending', 'shipped', 'cancelled'],
      }),
      order('2026-10-06T10:00:00Z', 'returned', 'store', 50000, [panjabi(1, 40000)]),
      // The AI's order that was cancelled does not count as sold.
      order('2026-10-06T11:00:00Z', 'cancelled', 'inbox', 70000, [saree(1, 60000)], {
        actor: AI,
        history: ['pending', 'cancelled'],
      }),
      // Before the period.
      order('2026-09-20T10:00:00Z', 'pending', 'inbox', 999000, [saree(4, 999000)], { actor: AI }),
    ]);

    await db.collection('customers').insertMany([
      {
        orgId: o,
        name: 'Risky',
        phone: RISKY_PHONE,
        blocked: true,
        stats: { orders: 2, delivered: 0, returned: 0, cancelled: 2 },
      },
      {
        orgId: o,
        name: 'Safe',
        phone: SAFE_PHONE,
        blocked: false,
        stats: { orders: 5, delivered: 5, returned: 0, cancelled: 1 },
      },
    ]);

    const cart = (recovered: boolean, status: string, orderAt?: string, totalMinor = 99000) => ({
      orgId: o,
      token: `tok_${new Types.ObjectId().toHexString()}`,
      code: new Types.ObjectId().toHexString(),
      status,
      recovered,
      totalMinor,
      ...(orderAt ? { order: { id: 'x', number: 'SL-x', totalMinor, at: at(orderAt) } } : {}),
    });
    await db
      .collection('carts')
      .insertMany([
        cart(true, 'ordered', '2026-10-03T10:00:00Z'),
        cart(true, 'ordered', '2026-09-10T10:00:00Z', 50000),
        cart(false, 'ordered', '2026-10-03T11:00:00Z', 70000),
        cart(false, 'open'),
      ]);
  }

  beforeAll(async () => {
    t = await TestApp.create();
    platform = (await t.platformOwner()).token;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor' })).id;
    accountant = await t.addMember(owner, orgId, 'accountant');
    packer = await t.addMember(owner, orgId, 'fulfillment');
    rival = await t.registerUser({ name: 'Rival' });
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Bazar' })).id;
    await seed(orgId);
    await seed(rivalOrgId);
    await Promise.all(['Message', 'Order'].map((m) => t.db.model(m).init()));
  });

  afterAll(async () => {
    await t?.close();
  });

  it('shows what Sellora did and the period’s sales and chats, counted by hand', async () => {
    const res = await O()
      .get(url(`/analytics/overview?${range}`))
      .expect(200);
    expect(res.body).toEqual({
      range: { from: FROM, to: TO, timezone: 'Asia/Dhaka', currency: 'BDT' },
      value: {
        ai: {
          replies: 3,
          conversations: 2,
          answeredByAiOnly: 1,
          voiceNotes: 1,
          minutesSaved: 6,
          minutesPerReply: 2,
          // 1200 + 11 + (900 - 100 not collected); released, earlier and USD usage left out.
          spentMinor: 2011,
          orders: { count: 1, valueMinor: 250000 },
        },
        carts: { count: 1, valueMinor: 99000 },
        riskyOrders: { stopped: 1, deliveryChargeMinor: 12000, checked: 2 },
      },
      inbox: {
        conversations: 5,
        customerMessages: 7,
        aiReplies: 3,
        teamReplies: 3,
        replySeconds: { ai: 30, team: 300 },
        byChannel: expect.arrayContaining([
          { channelType: 'web_chat', conversations: 3 },
          { channelType: 'whatsapp', conversations: 2 },
        ]),
        byDay: [
          { date: '2026-10-02', customerMessages: 3, aiReplies: 2, teamReplies: 0 },
          { date: '2026-10-03', customerMessages: 2, aiReplies: 1, teamReplies: 1 },
          { date: '2026-10-04', customerMessages: 1, aiReplies: 0, teamReplies: 1 },
          { date: '2026-10-05', customerMessages: 1, aiReplies: 0, teamReplies: 1 },
        ],
      },
      sales: {
        orders: 3,
        valueMinor: 520000,
        averageMinor: 173333,
        cancelled: 4,
        returned: 1,
        delivered: 1,
        bySource: [
          { source: 'inbox', orders: 1, valueMinor: 250000 },
          { source: 'manual', orders: 1, valueMinor: 150000 },
          { source: 'store', orders: 1, valueMinor: 120000 },
        ],
        byDay: [
          { date: '2026-10-02', orders: 1, valueMinor: 250000, aiOrders: 1 },
          { date: '2026-10-03', orders: 1, valueMinor: 150000, aiOrders: 0 },
          { date: '2026-10-04', orders: 1, valueMinor: 120000, aiOrders: 0 },
        ],
        topProducts: [
          {
            productId: SAREE.toHexString(),
            name: 'Red jamdani saree',
            quantity: 2,
            valueMinor: 350000,
          },
          {
            productId: PANJABI.toHexString(),
            name: 'Blue panjabi',
            quantity: 2,
            valueMinor: 140000,
          },
        ],
      },
    });
    expect(res.body.inbox.byChannel).toHaveLength(2);
  });

  it('lets roles with reports open it, and no one else', async () => {
    await t
      .as(accountant.token)
      .get(url(`/analytics/overview?${range}`))
      .expect(200);
    const denied = await t
      .as(packer.token)
      .get(url(`/analytics/overview?${range}`))
      .expect(403);
    expect(denied.body.code).toBe('missing_permission');
    const other = await t.as(rival.token).get(url(`/analytics/overview?${range}`));
    expect([403, 404]).toContain(other.status);
    // The rival sees only its own business, with the same numbers.
    const own = await t
      .as(rival.token)
      .get(url(`/analytics/overview?${range}`, rivalOrgId))
      .expect(200);
    expect(own.body.sales.orders).toBe(3);
    expect(own.body.value.ai.replies).toBe(3);
  });

  it('checks the period', async () => {
    await O().get(url('/analytics/overview')).expect(422);
    await O()
      .get(url(`/analytics/overview?from=${TO}&to=${FROM}`))
      .expect(422);
    await O()
      .get(url('/analytics/overview?from=2025-01-01T00:00:00Z&to=2026-10-01T00:00:00Z'))
      .expect(422);
  });

  it('needs Reports in the plan, and leaves out what the plan does not include', async () => {
    const overrides = (removeModules: string[]) =>
      P()
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ note: 'reports test', removeModules })
        .expect(200);
    try {
      await overrides(['analytics']);
      const blocked = await O()
        .get(url(`/analytics/overview?${range}`))
        .expect(402);
      expect(blocked.body.code).toBe('module_not_in_plan');

      await overrides(['commerce']);
      const noShop = await O()
        .get(url(`/analytics/overview?${range}`))
        .expect(200);
      expect(noShop.body.sales).toBeNull();
      expect(noShop.body.value.ai.orders).toBeNull();
      expect(noShop.body.value.carts).toBeNull();
      expect(noShop.body.value.riskyOrders).toBeNull();
      expect(noShop.body.inbox.conversations).toBe(5);

      await overrides(['ai_agent', 'fraud', 'marketing']);
      const noAi = await O()
        .get(url(`/analytics/overview?${range}`))
        .expect(200);
      expect(noAi.body.value).toEqual({ ai: null, carts: null, riskyOrders: null });
      expect(noAi.body.sales.orders).toBe(3);
    } finally {
      await overrides([]);
    }
  });
});
