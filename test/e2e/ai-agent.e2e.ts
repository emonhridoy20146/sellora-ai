import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { AiRepliesService } from '../../src/modules/ai/agent/ai-replies.service.js';
import { AiReplyQueue } from '../../src/modules/ai/agent/reply-queue.js';
import { AiProviderError } from '../../src/modules/ai/provider/ai-provider.js';
import { CreditsService } from '../../src/modules/billing/credits.service.js';
import { WalletService } from '../../src/modules/billing/wallet.service.js';
import { FakeAnthropic, onlyToolResult, type FakeRequest } from '../helpers/fake-anthropic.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ProductDto {
  id: string;
  name: string;
  variants: { id: string; title: string; stock: number }[];
}

interface ConversationDto {
  id: string;
  ai: { mode: string; reason: string | null };
  lastMessage: { text: string; direction: string; senderType: string } | null;
  contact: {
    id: string;
    name: string;
    phone: string | null;
    customerId: string | null;
    memory: { facts: string[]; address: string | null };
  } | null;
}

interface MessageDto {
  id: string;
  direction: string;
  type: string;
  sender: { type: string; name: string | null };
  text: string;
  ai: { credits: number } | null;
}

interface VisitorMessage {
  id: string;
  from: 'visitor' | 'business';
  text: string;
}

interface AgentView {
  settings: Record<string, unknown> & { enabled: boolean; handoverKeywords: string[] };
  status: {
    serviceReady: boolean;
    perReply: { credits: number; amountMinor: number; currency: string } | null;
    wallet: { availableMinor: number; currency: string };
    channels: { id: string; name: string; aiEnabled: boolean; aiCanReply: boolean }[];
  };
}

let seq = 0;
const cid = () => `c${Date.now().toString(36)}${(seq += 1).toString().padStart(4, '0')}`;

async function eventually<T>(fn: () => Promise<T | null | undefined>, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('AI sales agent', () => {
  const ai = new FakeAnthropic();
  let t: TestApp;
  let owner: Session;
  let manager: Session;
  let sales: Session;
  let orgId: string;
  let otherOrgProductId: string;
  let publicKey: string;
  let channelId: string;
  let saree: ProductDto;
  let panjabi: ProductDto;

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const widget = (path = '') => `/v1/webchat/${publicKey}${path}`;
  const queue = () => t.app.get<Queue>(getQueueToken(QUEUES.ai));
  const replies = () => t.app.get(AiRepliesService);

  /** Whether the agent is on, so a visitor's message is known to schedule a reply job. */
  let agentOn = false;
  const patchAgent = async (body: Record<string, unknown>, as = owner) => {
    const view = (await t.as(as.token).patch(url('/ai-agent')).send(body).expect(200)).body as AgentView;
    agentOn = view.settings.enabled;
    return view;
  };

  /** A new website visitor, and a function to send messages as them. */
  const visitor = async () => {
    const token = ((await t.http().post(widget('/session')).send({}).expect(200)).body as {
      token: string;
    }).token;
    let conversationId = '';
    const say = async (text: string) => {
      const res = await t
        .http()
        .post(widget('/messages'))
        .set('authorization', `Bearer ${token}`)
        .send({ text, clientId: cid() })
        .expect(201);
      const messageId = (res.body as { message: VisitorMessage }).message.id;
      // Scheduling happens after the response; wait for it so the newest message is known.
      if (agentOn) await eventually(() => queue().getJob(`reply-${messageId}`));
      if (!conversationId) {
        const list = await O().get(url('/conversations?status=all')).expect(200);
        conversationId = (list.body.items as ConversationDto[])[0]!.id;
      }
      return messageId;
    };
    const seen = async () =>
      (
        (
          await t
            .http()
            .get(widget('/messages'))
            .set('authorization', `Bearer ${token}`)
            .expect(200)
        ).body as { messages: VisitorMessage[] }
      ).messages;
    return {
      say,
      seen,
      get conversationId() {
        return conversationId;
      },
    };
  };

  const run = (conversationId: string, messageId: string, finalAttempt = true) =>
    replies().handleJob({ orgId, conversationId, messageId }, { finalAttempt });

  const conversation = async (id: string) =>
    (await O().get(url(`/conversations/${id}`)).expect(200)).body as ConversationDto;

  /** The conversation's messages, oldest first (the API pages newest first). */
  const thread = async (id: string) =>
    ((await O().get(url(`/conversations/${id}/messages`)).expect(200)).body as {
      items: MessageDto[];
    }).items.reverse();

  const wallet = async () =>
    (await O().get(url('/billing/wallet')).expect(200)).body as {
      availableMinor: number;
      heldMinor: number;
    };

  const inTenant = <T>(fn: () => Promise<T>) =>
    RequestContext.withTenant(orgId, fn, { type: 'system', id: 'test' });

  beforeAll(async () => {
    t = await TestApp.create({ AI_ANTHROPIC_API_KEY: 'sk-ant-test-key' }, { aiFetch: ai.fetch });
    owner = await t.registerUser({ name: 'Owner Rahman' });
    orgId = (await t.createOrg(owner, { name: 'Dhaka Fashion' })).id;
    manager = await t.addMember(owner, orgId, 'manager');
    sales = await t.addMember(owner, orgId, 'sales_agent');
    await Promise.all(
      ['Channel', 'Contact', 'Conversation', 'Message', 'Order', 'Customer', 'AiAgentSettings'].map(
        (m) => t.db.model(m).init(),
      ),
    );

    const channel = await O().post(url('/channels/web-chat')).send({ name: 'Website' }).expect(201);
    publicKey = channel.body.webChat.publicKey as string;
    channelId = channel.body.id as string;

    saree = (
      await O()
        .post(url('/products'))
        .send({
          name: 'Jamdani Saree',
          tags: ['saree', 'jamdani'],
          options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
          variants: [
            { optionValues: ['Red'], priceMinor: 300_000, stock: 5 },
            { optionValues: ['Blue'], priceMinor: 320_000, stock: 0 },
          ],
        })
        .expect(201)
    ).body as ProductDto;
    panjabi = (
      await O()
        .post(url('/products'))
        .send({
          name: 'Cotton Panjabi',
          tags: ['panjabi', 'eid'],
          variants: [{ priceMinor: 150_000, stock: 10 }],
        })
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

    // Another business, to prove the agent cannot reach its catalog.
    const rival = await t.registerUser({ name: 'Rival Owner' });
    const rivalOrg = (await t.createOrg(rival, { name: 'Rival Shop' })).id;
    otherOrgProductId = (
      await t
        .as(rival.token)
        .post(`/v1/orgs/${rivalOrg}/products`)
        .send({ name: 'Secret Lehenga', variants: [{ priceMinor: 900_000, stock: 3 }] })
        .expect(201)
    ).body.id as string;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    ai.reset();
  });

  // ------------------------------------------------------------------ settings

  describe('settings', () => {
    it('starts off, and shows readiness and the cost of a typical reply', async () => {
      const res = await O().get(url('/ai-agent')).expect(200);
      const view = res.body as AgentView;
      expect(view.settings).toMatchObject({
        enabled: false,
        tone: 'friendly',
        language: 'auto',
        tier: 'fast',
        takeOrders: true,
        confirmOrders: false,
        replyDelaySeconds: 3,
      });
      expect(view.status.serviceReady).toBe(true);
      // fast tier: 6,000 input × 2/1K + 400 output × 10/1K = 16 credits at ৳0.10
      expect(view.status.perReply).toEqual({ credits: 16, amountMinor: 160, currency: 'BDT' });
      expect(view.status.wallet).toEqual({ availableMinor: 25_000, currency: 'BDT' });
      expect(view.status.channels).toEqual([
        expect.objectContaining({ id: channelId, name: 'Website', aiEnabled: true, aiCanReply: true }),
      ]);
    });

    it('lets managers keep the knowledge current but not turn the agent on', async () => {
      const view = await patchAgent({ businessInfo: 'We deliver all over Bangladesh in 2-4 days.' }, manager);
      expect(view.settings.businessInfo).toBe('We deliver all over Bangladesh in 2-4 days.');
      const denied = await t.as(manager.token).patch(url('/ai-agent')).send({ enabled: true }).expect(403);
      expect(denied.body.required).toEqual(['ai.settings.manage']);
      await t.as(sales.token).get(url('/ai-agent')).expect(403);
      const bad = await O().patch(url('/ai-agent')).send({ replyDelaySeconds: 99, tone: 'rude' }).expect(422);
      expect((bad.body.errors as { path: string }[]).map((e) => e.path).sort()).toEqual([
        'body.replyDelaySeconds',
        'body.tone',
      ]);
    });

    it('does not schedule replies while the agent is off', async () => {
      const v = await visitor();
      const id = await v.say('hello?');
      await new Promise((r) => setTimeout(r, 200));
      expect(await queue().getJob(`reply-${id}`)).toBeUndefined();
    });

    it('turns on, with tidy handover keywords, and records who did it', async () => {
      const view = await patchAgent({
        enabled: true,
        handoverKeywords: ['Talk to a human', 'talk to a human ', 'মানুষের সাথে কথা'],
      });
      expect(view.settings.enabled).toBe(true);
      expect(view.settings.handoverKeywords).toEqual(['talk to a human', 'মানুষের সাথে কথা']);
      const audit = await t.db
        .collection('audit_events')
        .findOne({ action: 'ai.agent.enabled', 'actor.id': owner.userId });
      expect(audit?.metadata).toMatchObject({ after: { enabled: true } });
    });
  });

  // ------------------------------------------------------------------ replying

  describe('replies', () => {
    it('answers with the catalogue model for the tier and charges the real tokens', async () => {
      const before = await wallet();
      const v = await visitor();
      const id = await v.say('Assalamu alaikum, saree ache?');
      const job = await eventually(() => queue().getJob(`reply-${id}`));
      expect(job.opts.delay).toBe(3_000);
      expect(job.data).toEqual({ orgId, conversationId: v.conversationId, messageId: id });

      ai.then(
        FakeAnthropic.text('Walaikum assalam! Ji, Jamdani Saree ache, dam **৳3,000**.', {
          input_tokens: 2_000,
          cache_creation_input_tokens: 500,
          output_tokens: 100,
        }),
      );
      const outcome = await run(v.conversationId, id);
      expect(outcome).toMatchObject({ status: 'replied', credits: 6, handover: false });

      const req = ai.last();
      expect(req.headers['x-api-key']).toBe('sk-ant-test-key');
      expect(req.body).toMatchObject({
        model: 'claude-haiku-5-5',
        max_tokens: 2_048,
        output_config: { effort: 'low' },
        cache_control: { type: 'ephemeral' },
        messages: [{ role: 'user', content: 'Assalamu alaikum, saree ache?' }],
      });
      expect(req.body.metadata?.user_id).toMatch(/^[a-f0-9]{32}$/);
      expect(req.body.metadata?.user_id).not.toContain(orgId);
      expect(req.body.system).toContain('AI sales assistant of Dhaka Fashion');
      expect(req.body.system).toContain(`Jamdani Saree (id ${saree.id}): ৳3,000–৳3,200`);
      expect(req.body.system).toContain('Inside Dhaka (zone id dhaka): ৳60');
      expect(req.body.system).toContain('We deliver all over Bangladesh in 2-4 days.');
      expect(req.body.system).toContain('Reply in the language the customer writes in');
      expect(req.body.tools!.map((x) => x.name)).toEqual([
        'search_products',
        'get_product',
        'quote_order',
        'create_order',
        'get_my_orders',
        'save_customer_details',
        'handover_to_human',
      ]);
      for (const tool of req.body.tools!) {
        expect(tool.strict).toBe(true);
        expect(tool.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
      }

      // Markdown is unwrapped for chat; the visitor gets the reply live and in history.
      const seen = await v.seen();
      expect(seen.at(-1)).toMatchObject({
        from: 'business',
        text: 'Walaikum assalam! Ji, Jamdani Saree ache, dam ৳3,000.',
      });
      const msgs = await thread(v.conversationId);
      expect(msgs.at(-1)).toMatchObject({ sender: { type: 'ai' }, ai: { credits: 6 } });
      expect((await conversation(v.conversationId)).lastMessage?.senderType).toBe('ai');

      // 2,500 prompt tokens (cache writes included) × 2/1K + 100 × 10/1K = 6 credits = ৳0.60
      expect(await wallet()).toMatchObject({
        availableMinor: before.availableMinor - 60,
        heldMinor: 0,
      });
      const usage = await O().get(url('/billing/ai-usage/requests')).expect(200);
      const row = (usage.body.items as Record<string, unknown>[])[0]!;
      expect(row).toMatchObject({
        feature: 'ai_agent_reply',
        status: 'settled',
        credits: 6,
        tokens: { input: 2_500, output: 100 },
        reference: { type: 'conversation', id: v.conversationId },
      });
      expect(row).not.toHaveProperty('model');
      expect(row).not.toHaveProperty('costMinor');
      const platformRow = await t.db.collection('ai_usage').findOne({ requestId: row.requestId });
      expect(platformRow).toMatchObject({
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        inputTokens: 2_000,
        cacheWriteInputTokens: 500,
      });
      // 2,000 × $0.10 + 500 × $0.125 + 100 × $0.50 per MTok = 312.5 → 313 micro-USD
      expect(platformRow?.costUsdMicros).toBe(313);

      // Running the same job again does nothing: the customer is answered.
      expect(await run(v.conversationId, id)).toEqual({ status: 'skipped', reason: 'nothing_to_answer' });
      expect(ai.requests).toHaveLength(1);
    });

    it('answers a burst of messages once', async () => {
      const v = await visitor();
      const first = await v.say('ami ekta panjabi chai');
      const second = await v.say('L size ache?');
      expect(await run(v.conversationId, first)).toEqual({ status: 'skipped', reason: 'superseded' });
      ai.then(FakeAnthropic.text('Ji ache! Cotton Panjabi ৳1,500.'));
      expect(await run(v.conversationId, second)).toMatchObject({ status: 'replied' });
      expect(ai.requests).toHaveLength(1);
      expect(ai.last().body.messages).toEqual([
        { role: 'user', content: 'ami ekta panjabi chai\nL size ache?' },
      ]);
    });

    it('waits while another reply in the conversation is running', async () => {
      const v = await visitor();
      const id = await v.say('hello');
      const lock = t.app.get(AiReplyQueue);
      expect(await lock.lock(v.conversationId, 'someone-else')).toBe(true);
      expect(await run(v.conversationId, id)).toEqual({ status: 'skipped', reason: 'busy' });
      const again = await queue().getJob(`reply-${id}-b1`);
      expect(again?.opts.delay).toBe(3_000);
      expect(again?.data).toMatchObject({ messageId: id, busy: 1 });
      await lock.unlock(v.conversationId, 'someone-else');
      ai.then(FakeAnthropic.text('Hello! How can I help?'));
      expect(await run(v.conversationId, id)).toMatchObject({ status: 'replied' });
    });
  });

  // ------------------------------------------------------------------ selling

  describe('selling', () => {
    let buyer: Awaited<ReturnType<typeof visitor>>;
    const red = () => saree.variants.find((x) => x.title === 'Red')!;
    const blue = () => saree.variants.find((x) => x.title === 'Blue')!;
    const orderInput = () => ({
      items: [{ product_id: saree.id, variant_id: red().id, quantity: 1 }],
      delivery_zone_id: 'dhaka',
      customer_name: 'Rahim Uddin',
      phone: '01712345678',
      address: 'House 12, Road 5, Dhanmondi',
      area: 'Dhanmondi',
      district: 'Dhaka',
      note: null,
    });

    it('checks the product and quotes from catalog prices before asking to confirm', async () => {
      buyer = await visitor();
      const id = await buyer.say(
        'Red jamdani saree ta nibo. Rahim Uddin, 01712345678, House 12 Road 5 Dhanmondi Dhaka',
      );
      ai.then(
        FakeAnthropic.tool('get_product', { product_id: saree.id }, { thinking: true }),
        FakeAnthropic.tool('quote_order', {
          items: [{ product_id: saree.id, variant_id: red().id, quantity: 1 }],
          delivery_zone_id: 'dhaka',
        }),
        FakeAnthropic.text('Saree ৳3,000 + delivery ৳60 = mot ৳3,060. Confirm korben?'),
      );
      expect(await run(buyer.conversationId, id)).toMatchObject({ status: 'replied' });
      expect(ai.pending).toBe(0);

      const [, second, third] = ai.requests as [FakeRequest, FakeRequest, FakeRequest];
      // The assistant turn goes back unchanged (thinking and tool_use blocks), then the results.
      expect(second.body.messages[1]).toMatchObject({
        role: 'assistant',
        content: [
          { type: 'thinking', signature: 'sig_test_signature' },
          { type: 'tool_use', name: 'get_product' },
        ],
      });
      const product = onlyToolResult(second);
      expect(product).toMatchObject({ id: saree.id, name: 'Jamdani Saree' });
      expect(product.variants).toEqual([
        expect.objectContaining({ id: red().id, title: 'Red', price: '৳3,000', available: true }),
        expect.objectContaining({ id: blue().id, title: 'Blue', price: '৳3,200', available: false }),
      ]);
      expect(third.body.messages).toHaveLength(5);
      expect(onlyToolResult(third)).toMatchObject({
        item_total: '৳3,000',
        delivery: 'Inside Dhaka: ৳60',
        total_to_pay: '৳3,060',
        can_order: true,
      });
    });

    it('refuses out-of-stock variants in a quote', async () => {
      const v = await visitor();
      const id = await v.say('Blue ta 2 ta dorkar');
      ai.then(
        FakeAnthropic.tool('quote_order', {
          items: [{ product_id: saree.id, variant_id: blue().id, quantity: 2 }],
          delivery_zone_id: null,
        }),
        FakeAnthropic.text('Dukkhito, Blue ta ekhon stock e nei.'),
      );
      await run(v.conversationId, id);
      expect(onlyToolResult(ai.requests[1]!)).toMatchObject({
        _isError: true,
        can_order: false,
        problems: ['Jamdani Saree Blue: out of stock'],
      });
    });

    it('places the order once the customer confirms, and never doubles it', async () => {
      const id = await buyer.say('Ji confirm');
      ai.then(
        FakeAnthropic.tool('create_order', orderInput()),
        FakeAnthropic.text('Apnar order hoye geche! Shop theke call kore confirm korbe.'),
      );
      expect(await run(buyer.conversationId, id)).toMatchObject({ status: 'replied' });
      const placed = onlyToolResult(ai.requests[1]!);
      expect(placed).toMatchObject({ ok: true, status: 'pending', total_to_pay: '৳3,060' });
      expect(placed.order_number).toMatch(/^SL-\d+$/);

      const orders = (await O().get(url('/orders')).expect(200)).body.items as Record<string, unknown>[];
      const order = orders.find((o) => o.number === placed.order_number)!;
      expect(order).toMatchObject({
        status: 'pending',
        source: 'inbox',
        conversationId: buyer.conversationId,
        customer: { name: 'Rahim Uddin', phone: '+8801712345678' },
        shippingAddress: { line1: 'House 12, Road 5, Dhanmondi', area: 'Dhanmondi', district: 'Dhaka' },
        deliveryZone: { id: 'dhaka', name: 'Inside Dhaka' },
        totalMinor: 306_000,
        payment: { method: 'cod', status: 'unpaid' },
        internalNote: 'Placed by the AI sales agent in a chat.',
      });
      // Pending orders do not take stock yet.
      const product = (await O().get(url(`/products/${saree.id}`)).expect(200)).body as ProductDto;
      expect(product.variants[0]!.stock).toBe(5);

      // The chat's contact is now that customer.
      const conv = await conversation(buyer.conversationId);
      expect(conv.contact).toMatchObject({
        name: 'Rahim Uddin',
        phone: '+8801712345678',
        customerId: order.customerId,
      });

      // The model places the same order again: the existing one is returned.
      ai.reset();
      const again = await buyer.say('order ta hoise to?');
      ai.then(
        FakeAnthropic.tool('create_order', orderInput()),
        FakeAnthropic.text('Ji, apnar order already ache.'),
      );
      await run(buyer.conversationId, again);
      expect(onlyToolResult(ai.requests[1]!)).toMatchObject({
        ok: true,
        already_placed: true,
        order_number: placed.order_number,
      });
      const after = (await O().get(url('/orders')).expect(200)).body.items as unknown[];
      expect(after).toHaveLength(orders.length);
    });

    it("tells customers about their own orders only", async () => {
      const id = await buyer.say('amar order er ki obostha?');
      ai.then(FakeAnthropic.tool('get_my_orders', {}), FakeAnthropic.text('Pending ache.'));
      await run(buyer.conversationId, id);
      const mine = onlyToolResult(ai.requests[1]!);
      expect(mine.orders).toEqual([
        expect.objectContaining({ status: 'pending', total: '৳3,060', items: '1× Jamdani Saree (Red)' }),
      ]);
      // The system prompt now knows this customer and their order.
      expect(ai.requests[0]!.body.system).toContain('Phone: +8801712345678');
      expect(ai.requests[0]!.body.system).toMatch(/Recent orders:\n- SL-\d+ \(pending/);

      ai.reset();
      const stranger = await visitor();
      const sid = await stranger.say('amar order kothay?');
      ai.then(FakeAnthropic.tool('get_my_orders', {}), FakeAnthropic.text('Kon number e order korechilen?'));
      await run(stranger.conversationId, sid);
      expect(onlyToolResult(ai.requests[1]!)).toMatchObject({ orders: [] });
      expect(ai.requests[0]!.body.system).toContain('A new customer: nothing is known about them yet.');
    });

    it("cannot read another business's products", async () => {
      const v = await visitor();
      const id = await v.say('Secret Lehenga ache?');
      ai.then(
        FakeAnthropic.tool('get_product', { product_id: otherOrgProductId }),
        FakeAnthropic.tool('search_products', { query: 'Secret Lehenga' }),
        FakeAnthropic.text('Dukkhito, eta amader kache nei.'),
      );
      await run(v.conversationId, id);
      expect(onlyToolResult(ai.requests[1]!)).toMatchObject({ _isError: true, error: 'not_found' });
      expect(onlyToolResult(ai.requests[2]!)).toMatchObject({ results: [] });
      expect(ai.requests[0]!.body.system).not.toContain('Secret Lehenga');
    });

    it('finds products by loose words and reports bad tool input back to the model', async () => {
      const v = await visitor();
      const id = await v.say('eid er jonno kichu ache?');
      ai.then(
        FakeAnthropic.tool('search_products', { query: 'eid panjabi' }),
        FakeAnthropic.tool('quote_order', {
          items: [{ product_id: 'nope', variant_id: panjabi.variants[0]!.id, quantity: 0 }],
          delivery_zone_id: null,
        }),
        FakeAnthropic.text('Cotton Panjabi ache, ৳1,500.'),
      );
      await run(v.conversationId, id);
      const found = onlyToolResult(ai.requests[1]!);
      expect((found.results as { name: string }[]).map((r) => r.name)).toEqual(['Cotton Panjabi']);
      const bad = onlyToolResult(ai.requests[2]!);
      expect(bad).toMatchObject({ _isError: true, error: 'invalid_input' });
      expect((bad.problems as string[]).join(' ')).toMatch(/items\.0\.product_id.*items\.0\.quantity/);
    });

    it('remembers customer details, and staff can correct them', async () => {
      const v = await visitor();
      const id = await v.say('Ami Karima, 01811111111. Mirpur 10 e thaki, M size pori.');
      ai.then(
        FakeAnthropic.tool('save_customer_details', {
          name: 'Karima',
          phone: '01811111111',
          email: null,
          address: 'Mirpur 10, Dhaka',
          facts: ['wears size M'],
        }),
        FakeAnthropic.text('Dhonnobad Karima!'),
      );
      await run(v.conversationId, id);
      expect(onlyToolResult(ai.requests[1]!)).toMatchObject({ ok: true });
      let conv = await conversation(v.conversationId);
      expect(conv.contact).toMatchObject({
        name: 'Karima',
        phone: '+8801811111111',
        memory: { facts: ['wears size M'], address: 'Mirpur 10, Dhaka' },
      });

      ai.reset();
      const next = await v.say('notun ki ache?');
      ai.then(FakeAnthropic.text('Notun Cotton Panjabi esheche.'));
      await run(v.conversationId, next);
      expect(ai.last().body.system).toContain('Remembered:\n- wears size M');
      expect(ai.last().body.system).toContain('Saved address: Mirpur 10, Dhaka');

      conv = (
        await O()
          .patch(url(`/conversations/${v.conversationId}/contact`))
          .send({ memory: { facts: [], address: null } })
          .expect(200)
      ).body as ConversationDto;
      expect(conv.contact?.memory).toEqual({ facts: [], address: null });
    });
  });

  // ------------------------------------------------------------------ handing over

  describe('handing over to people', () => {
    it('hands over when the agent decides to, and stays quiet afterwards', async () => {
      const v = await visitor();
      const id = await v.say('Parcel ta chhera eseche!');
      ai.then(
        FakeAnthropic.tool('handover_to_human', {
          reason: 'complaint',
          summary: 'Parcel arrived torn',
        }),
        FakeAnthropic.text('Dukkhito! Amader team ekhuni apnar sathe kotha bolbe.'),
      );
      expect(await run(v.conversationId, id)).toMatchObject({ status: 'replied', handover: true });
      const conv = await conversation(v.conversationId);
      expect(conv.ai).toMatchObject({ mode: 'paused', reason: 'ai_handover' });
      const msgs = await thread(v.conversationId);
      expect(msgs.slice(-2).map((m) => [m.sender.type, m.text])).toEqual([
        ['ai', 'Dukkhito! Amader team ekhuni apnar sathe kotha bolbe.'],
        ['system', 'The AI handed this chat to the team: Parcel arrived torn'],
      ]);

      const later = await v.say('hello?');
      await eventually(() => queue().getJob(`reply-${later}`));
      expect(await run(v.conversationId, later)).toEqual({ status: 'skipped', reason: 'ai_paused' });
      expect(ai.requests).toHaveLength(2);
    });

    it('hands over on a keyword without calling the model, in the customer’s script', async () => {
      const v = await visitor();
      const id = await v.say('Can I talk to a human?');
      expect(await run(v.conversationId, id)).toEqual({ status: 'handed_over', reason: 'keyword' });
      expect(ai.requests).toHaveLength(0);
      expect((await v.seen()).at(-1)?.text).toBe(
        'Thanks for your message! A member of our team will reply to you shortly.',
      );
      expect((await conversation(v.conversationId)).ai.reason).toBe('keyword');

      const b = await visitor();
      const bid = await b.say('আমি মানুষের সাথে কথা বলতে চাই');
      expect(await run(b.conversationId, bid)).toMatchObject({ reason: 'keyword' });
      expect((await b.seen()).at(-1)?.text).toBe('ধন্যবাদ! আমাদের টিমের একজন শীঘ্রই আপনাকে উত্তর দেবেন।');
    });

    it('answers a waiting customer when a person turns the AI back on', async () => {
      const v = await visitor();
      const first = await v.say('hi');
      ai.then(FakeAnthropic.text('Hello!'));
      await run(v.conversationId, first);
      const send = (text: string) =>
        O().post(url(`/conversations/${v.conversationId}/messages`)).send({ text, clientId: cid() });
      await send('.').expect(201);
      expect((await conversation(v.conversationId)).ai.mode).toBe('paused');

      const waiting = await v.say('price koto?');
      await eventually(() => queue().getJob(`reply-${waiting}`));
      expect(await run(v.conversationId, waiting)).toEqual({ status: 'skipped', reason: 'ai_paused' });

      await send('.').expect(201);
      expect((await conversation(v.conversationId)).ai.mode).toBe('auto');
      ai.then(FakeAnthropic.text('Saree ৳3,000 theke shuru.'));
      expect(await run(v.conversationId, waiting)).toMatchObject({ status: 'replied' });
      expect((await v.seen()).at(-1)?.text).toBe('Saree ৳3,000 theke shuru.');
    });

    it('drops its reply when a person answers first', async () => {
      const v = await visitor();
      const id = await v.say('discount pabo?');
      ai.then(
        FakeAnthropic.during(async () => {
          await O()
            .post(url(`/conversations/${v.conversationId}/messages`))
            .send({ text: 'Ami dekhchi, ekhuni janacchi.', clientId: cid() })
            .expect(201);
        }, FakeAnthropic.text('AI answer that should not be sent')),
      );
      expect(await run(v.conversationId, id)).toEqual({
        status: 'skipped',
        reason: 'paused_during_reply',
      });
      const texts = (await v.seen()).map((m) => m.text);
      expect(texts).toContain('Ami dekhchi, ekhuni janacchi.');
      expect(texts).not.toContain('AI answer that should not be sent');
    });

    it('lets provider outages retry, then hands over on the last attempt', async () => {
      const v = await visitor();
      const id = await v.say('hello');
      ai.then(FakeAnthropic.error(529, 'overloaded_error'));
      await expect(run(v.conversationId, id, false)).rejects.toBeInstanceOf(AiProviderError);
      // The reservation was released: nothing held, nothing charged.
      expect((await wallet()).heldMinor).toBe(0);
      const released = await t.db
        .collection('ai_usage')
        .find({ orgId: { $exists: true }, status: 'released' })
        .toArray();
      expect(released.length).toBeGreaterThan(0);
      expect((await conversation(v.conversationId)).ai.mode).toBe('auto');

      ai.then(FakeAnthropic.error(529, 'overloaded_error'));
      expect(await run(v.conversationId, id, true)).toEqual({
        status: 'handed_over',
        reason: 'ai_error',
      });
      expect((await v.seen()).at(-1)?.from).toBe('business');
      expect((await conversation(v.conversationId)).ai).toMatchObject({
        mode: 'paused',
        reason: 'ai_error',
      });
    });

    it('hands over when the model declines to answer', async () => {
      const v = await visitor();
      const id = await v.say('something the model will not answer');
      ai.then(FakeAnthropic.refusal());
      expect(await run(v.conversationId, id)).toEqual({ status: 'handed_over', reason: 'ai_refused' });
      const msgs = await thread(v.conversationId);
      const notice = msgs.find((m) => m.sender.type === 'ai')!;
      // The declined call still cost tokens; the cost shows on the notice.
      expect(notice.ai?.credits).toBeGreaterThan(0);
    });

    it('pauses with a clear line for the team when AI credits run out', async () => {
      const v = await visitor();
      const id = await v.say('hello');
      const walletService = t.app.get(WalletService);
      const { availableMinor } = await wallet();
      await inTenant(() => walletService.hold(availableMinor));
      try {
        expect(await run(v.conversationId, id)).toEqual({
          status: 'handed_over',
          reason: 'no_credits',
        });
        expect(ai.requests).toHaveLength(0);
        const msgs = await thread(v.conversationId);
        expect(msgs.at(-1)?.text).toMatch(/AI credit balance is used up/);
      } finally {
        await inTenant(() => walletService.release(availableMinor));
      }
    });

    it('hands over when the tier’s model has no provider set up', async () => {
      const credits = t.app.get(CreditsService);
      const haiku = (await credits.listModels()).find((m) => m.model === 'claude-haiku-5-5')!;
      await credits.createModel({
        provider: 'openai',
        model: 'test-fast-model',
        label: 'Test fast model',
        tier: 'fast',
        inputUsdMicrosPerMTok: 100_000,
        outputUsdMicrosPerMTok: 400_000,
        cachedInputUsdMicrosPerMTok: 0,
        contextWindow: 128_000,
        enabled: true,
        isDefaultForTier: true,
      });
      try {
        expect(((await O().get(url('/ai-agent')).expect(200)).body as AgentView).status.serviceReady).toBe(false);
        const v = await visitor();
        const id = await v.say('hello');
        expect(await run(v.conversationId, id)).toEqual({
          status: 'handed_over',
          reason: 'ai_unavailable',
        });
        expect(ai.requests).toHaveLength(0);
      } finally {
        await credits.updateModel(haiku._id.toHexString(), { isDefaultForTier: true });
      }
    });

    it('stops at the daily reply limit for a conversation', async () => {
      await patchAgent({ maxRepliesPerDay: 1 });
      try {
        const v = await visitor();
        const one = await v.say('one');
        ai.then(FakeAnthropic.text('First answer.'));
        expect(await run(v.conversationId, one)).toMatchObject({ status: 'replied' });
        const two = await v.say('two');
        expect(await run(v.conversationId, two)).toEqual({
          status: 'handed_over',
          reason: 'reply_limit',
        });
        expect(ai.requests).toHaveLength(1);
      } finally {
        await patchAgent({ maxRepliesPerDay: 40 });
      }
    });
  });

  // ------------------------------------------------------------------ test chat

  describe('test chat', () => {
    it('runs the real agent with draft settings but saves nothing', async () => {
      const ordersBefore = ((await O().get(url('/orders')).expect(200)).body.items as unknown[]).length;
      ai.then(
        FakeAnthropic.tool('create_order', {
          items: [{ product_id: saree.id, variant_id: saree.variants[0]!.id, quantity: 1 }],
          delivery_zone_id: 'outside',
          customer_name: 'Test Buyer',
          phone: '01912345678',
          address: 'Agrabad, Chattogram',
          area: null,
          district: 'Chattogram',
          note: null,
        }),
        FakeAnthropic.text('Order done! Total ৳3,120.'),
      );
      const res = await t
        .as(manager.token)
        .post(url('/ai-agent/preview'))
        .send({
          messages: [
            { from: 'customer', text: 'Red saree chai' },
            { from: 'assistant', text: 'Address den please' },
            { from: 'customer', text: 'Agrabad, Chattogram. 01912345678. Confirm.' },
          ],
          draft: { businessInfo: 'Free gift wrap this week (draft).', language: 'banglish' },
        })
        .expect(200);
      expect(res.body).toMatchObject({
        reply: 'Order done! Total ৳3,120.',
        outcome: 'reply',
        handover: null,
        order: { number: 'TEST-ORDER' },
        toolCalls: [{ name: 'create_order', ok: true }],
      });
      expect(res.body.credits).toBeGreaterThan(0);
      expect(ai.requests[0]!.body.system).toContain('Free gift wrap this week (draft).');
      expect(ai.requests[0]!.body.system).toContain('Reply in Banglish');
      expect(ai.requests[0]!.body.messages).toHaveLength(3);
      expect(onlyToolResult(ai.requests[1]!)).toMatchObject({ preview: true, total_to_pay: '৳3,120' });
      expect(((await O().get(url('/orders')).expect(200)).body.items as unknown[]).length).toBe(ordersBefore);
      // The saved settings are unchanged.
      const view = (await O().get(url('/ai-agent')).expect(200)).body as AgentView;
      expect(view.settings.language).toBe('auto');
      const usage = await O().get(url('/billing/ai-usage/requests?feature=ai_agent_preview')).expect(200);
      expect((usage.body.items as unknown[]).length).toBeGreaterThan(0);
    });

    it('validates the chat and reports an unusable AI service as 503', async () => {
      await O()
        .post(url('/ai-agent/preview'))
        .send({ messages: [{ from: 'assistant', text: 'Hi' }] })
        .expect(422);
      await t
        .as(sales.token)
        .post(url('/ai-agent/preview'))
        .send({ messages: [{ from: 'customer', text: 'Hi' }] })
        .expect(403);
      ai.then(FakeAnthropic.error(401, 'authentication_error'));
      const res = await O()
        .post(url('/ai-agent/preview'))
        .send({ messages: [{ from: 'customer', text: 'Hi' }] })
        .expect(503);
      expect(res.body.code).toBe('ai_unavailable');
      expect((await wallet()).heldMinor).toBe(0);
    });
  });
});
