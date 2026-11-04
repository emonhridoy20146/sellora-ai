import { getQueueToken } from '@nestjs/bullmq';
import { Worker, type Job, type Queue } from 'bullmq';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { AiRepliesService } from '../../src/modules/ai/agent/ai-replies.service.js';
import { InboxRealtime } from '../../src/modules/inbox/inbox-realtime.service.js';
import { MessagingService } from '../../src/modules/inbox/messaging.service.js';
import type { OutboxJob } from '../../src/modules/inbox/outbox.js';
import { MetaInbound, type InboundOutcome } from '../../src/modules/meta/meta-inbound.service.js';
import { MetaSender, type SendOutcome } from '../../src/modules/meta/meta-sender.service.js';
import type { MetaWebhookJob } from '../../src/modules/meta/meta-webhook.service.js';
import { FakeAnthropic } from '../helpers/fake-anthropic.js';
import { FakeGraph, signWebhook, webhook } from '../helpers/fake-meta.js';
import { TestApp, type Session } from '../helpers/test-app.js';
import { OutboxProcessor } from '../../src/workers/outbox.processor.js';

const APP_ID = '1357924680';
const APP_SECRET = 'meta-app-secret-for-tests-0001';
const VERIFY_TOKEN = 'verify-token-for-tests-0001';

const PAGE1 = { id: '1000000000001', name: 'Dhaka Fashion', token: 'PAGE1_TOKEN_abcdefghijklmnop' };
const IG1 = { id: '17841400000000001', username: 'dhakafashion' };
const PAGE2 = {
  id: '1000000000002',
  name: 'Dhaka Fashion Outlet',
  token: 'PAGE2_TOKEN_abcdefghijklmnop',
};
const WA1 = {
  phoneNumberId: '2000000000001',
  wabaId: '3000000000001',
  token: 'WA_SYSTEM_TOKEN_abcdefghijklmnop',
  displayPhone: '+880 1700-000001',
  verifiedName: 'Dhaka Fashion',
};
const WA2 = {
  phoneNumberId: '2000000000002',
  wabaId: '3000000000002',
  token: 'WA_BUSINESS_TOKEN_abcdefghijklmnop',
  displayPhone: '+880 1700-000002',
  verifiedName: 'Dhaka Fashion Online',
};

interface ChannelDto {
  id: string;
  type: string;
  name: string;
  status: string;
  statusReason: string | null;
  account: {
    externalId: string;
    displayName: string;
    username: string | null;
    pageId: string | null;
  } | null;
}

interface ConversationDto {
  id: string;
  channelId: string;
  channelType: string;
  ai: { mode: string; reason: string | null };
  lastInboundAt: string | null;
  replyWindowEndsAt: string | null;
  contact: { id: string; name: string; phone: string | null; avatarUrl: string | null } | null;
}

interface MessageDto {
  id: string;
  direction: string;
  type: string;
  sender: { type: string; name: string | null };
  text: string;
  delivery: { status: string; error: string | null };
}

interface PageChoice {
  id: string;
  name: string;
  canMessage: boolean;
  instagram: { id: string; username: string | null } | null;
  connected: { messenger: string | null; instagram: string | null };
}

let seq = 0;
const mid = (prefix = 'm_in') => `${prefix}_${Date.now().toString(36)}_${(seq += 1)}`;

async function eventually<T>(fn: () => Promise<T | null | undefined>, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Messenger, Instagram and WhatsApp', () => {
  const graph = new FakeGraph(APP_SECRET);
  const ai = new FakeAnthropic();
  let t: TestApp;
  let owner: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let platform: string;
  const channel: Record<'messenger' | 'instagram' | 'whatsapp' | 'whatsapp2', ChannelDto> =
    {} as never;

  const O = () => t.as(owner.token);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const inbound = () => t.app.get(MetaInbound);
  const sender = () => t.app.get(MetaSender);
  const queue = <T>(name: string) => t.app.get<Queue<T>>(getQueueToken(name));

  const setOverrides = (body: Record<string, unknown>) =>
    t
      .as(platform)
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ note: 'meta test', ...body })
      .expect(200);

  /** Posts a webhook signed like Meta (or with the given signature). */
  const deliver = (body: unknown, signature?: string) => {
    const signed = signWebhook(APP_SECRET, body);
    return t
      .http()
      .post('/v1/webhooks/meta')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature ?? signed.signature)
      .send(signed.raw);
  };

  const pending = async <T>(name: string): Promise<Job<T>[]> =>
    (await queue<T>(name).getJobs(['waiting', 'delayed', 'prioritized'])).sort(
      (a, b) => a.timestamp - b.timestamp || Number(a.id ?? 0) - Number(b.id ?? 0),
    );

  /** Runs queued webhook deliveries the way the worker does. */
  const drainWebhooks = async (): Promise<InboundOutcome[]> => {
    const outcomes: InboundOutcome[] = [];
    for (const job of await pending<MetaWebhookJob>(QUEUES.webhooks)) {
      outcomes.push(...(await inbound().handleWebhook(job.data.body)));
      await job.remove();
    }
    return outcomes;
  };

  /** Delivers webhook bodies end to end: signed POST, then the worker's part. */
  const receive = async (...bodies: unknown[]) => {
    for (const body of bodies) await deliver(body).expect(200);
    return drainWebhooks();
  };

  /**
   * Runs queued sends the way the worker does. A job that throws stays queued (the queue
   * would retry it); a job told to wait stays queued too.
   */
  const drainOutbox = async (opts: { finalAttempt?: boolean; rounds?: number } = {}) => {
    const results: (SendOutcome | { error: unknown })[] = [];
    for (let round = 0; round < (opts.rounds ?? 10); round += 1) {
      const jobs = await pending<OutboxJob>(QUEUES.outbox);
      let progressed = false;
      for (const job of jobs) {
        let outcome: SendOutcome;
        try {
          outcome = await sender().send(job.data, { finalAttempt: opts.finalAttempt ?? true });
        } catch (error) {
          results.push({ error });
          continue;
        }
        if (outcome.status === 'wait') continue;
        results.push(outcome);
        await job.remove();
        progressed = true;
      }
      if (!progressed) break;
    }
    return results;
  };

  const conversations = async (org = orgId, as = owner) =>
    (await t.as(as.token).get(url('/conversations?status=all&limit=100', org)).expect(200)).body
      .items as ConversationDto[];

  const conversationOn = async (channelId: string, contactName?: string) => {
    const list = await conversations();
    const found = list.find(
      (c) => c.channelId === channelId && (!contactName || c.contact?.name === contactName),
    );
    if (!found) throw new Error(`no conversation on ${channelId}`);
    return found;
  };

  /** Oldest first. */
  const thread = async (conversationId: string) =>
    (
      (
        await O()
          .get(url(`/conversations/${conversationId}/messages`))
          .expect(200)
      ).body.items as MessageDto[]
    ).reverse();

  /** The conversation's message with this text (staff replies add system lines after them). */
  const byText = async (conversationId: string, text: string) => {
    const found = (await thread(conversationId)).find((m) => m.text === text);
    if (!found) throw new Error(`no message "${text}"`);
    return found;
  };

  const reply = (conversationId: string, text: string) =>
    O()
      .post(url(`/conversations/${conversationId}/messages`))
      .send({ text });

  /** Facebook Login as the person: start, then finish with the code Meta would return. */
  const pageLogin = async (as: Session, org: string, code: string) => {
    const start = await t.as(as.token).post(url('/channels/meta/login', org)).expect(200);
    const state = new URL(start.body.url as string).searchParams.get('state')!;
    const res = await t
      .as(as.token)
      .post(url('/channels/meta/login/finish', org))
      .send({ code, state })
      .expect(200);
    return { state, ...(res.body as { sessionId: string; pages: PageChoice[] }) };
  };

  beforeAll(async () => {
    graph.codes.set('CODE_OWNER', 'USER_OWNER_TOKEN');
    graph.codes.set('CODE_RIVAL', 'USER_RIVAL_TOKEN');
    graph.pagesByUser.set('USER_OWNER_TOKEN', [
      { ...PAGE1, instagram: IG1 },
      { ...PAGE2, tasks: ['ANALYZE'] },
    ]);
    graph.pagesByUser.set('USER_RIVAL_TOKEN', [{ ...PAGE1, token: 'PAGE1_RIVAL_TOKEN_abcdefgh' }]);
    graph.whatsapp.push(WA1, WA2);
    graph.businessCodes.set('ES_CODE', WA2.token);

    t = await TestApp.create(
      {
        META_APP_ID: APP_ID,
        META_APP_SECRET: APP_SECRET,
        META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
        META_WHATSAPP_CONFIG_ID: 'WA_CONFIG_1',
        META_GRAPH_BASE_URL: 'http://graph.test',
        AI_ANTHROPIC_API_KEY: 'sk-ant-test-key',
      },
      { metaFetch: graph.fetch, aiFetch: ai.fetch },
    );
    owner = await t.registerUser({ name: 'Owner Rahman' });
    orgId = (await t.createOrg(owner, { name: 'Dhaka Fashion' })).id;
    rival = await t.registerUser({ name: 'Rival Owner' });
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Shop' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Channel', 'Contact', 'Conversation', 'Message'].map((m) => t.db.model(m).init()),
    );
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    graph.reset();
    ai.reset();
  });

  // ------------------------------------------------------------------ webhook endpoint

  describe('webhook endpoint', () => {
    it('answers Meta’s verification handshake only with the right token', async () => {
      const ok = await t
        .http()
        .get('/v1/webhooks/meta')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        })
        .expect(200);
      expect(ok.text).toBe('1158201444');
      expect(ok.headers['content-type']).toMatch(/^text\/plain/);
      await t
        .http()
        .get('/v1/webhooks/meta')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': '1' })
        .expect(403);
    });

    it('rejects deliveries without a valid signature', async () => {
      const body = webhook.messenger(PAGE1.id, '5550001', mid(), 'hi');
      const signed = signWebhook(APP_SECRET, body);
      await t
        .http()
        .post('/v1/webhooks/meta')
        .set('content-type', 'application/json')
        .send(signed.raw)
        .expect(401);
      await deliver(body, signWebhook('another-secret', body).signature).expect(401);
      // Signed, then changed on the way.
      await t
        .http()
        .post('/v1/webhooks/meta')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', signed.signature)
        .send(signed.raw.replace('hi', 'ho'))
        .expect(401);
      expect(await pending(QUEUES.webhooks)).toHaveLength(0);
    });

    it('accepts deliveries with nothing to handle, without queueing them', async () => {
      const res = await deliver({
        object: 'page',
        entry: [{ id: PAGE1.id, messaging: [] }],
      }).expect(200);
      expect(res.body).toEqual({ events: 0 });
      expect(await pending(QUEUES.webhooks)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ connecting

  describe('connecting', () => {
    it('tells the web app that Meta is set up', async () => {
      const res = await O().get(url('/channels/meta/settings')).expect(200);
      expect(res.body).toEqual({
        configured: true,
        appId: APP_ID,
        graphVersion: 'v23.0',
        whatsappEmbeddedSignup: 'WA_CONFIG_1',
        redirectUri: 'http://localhost:3000/app/connect/meta',
      });
    });

    it('starts Facebook Login with the messaging permissions and a sealed state', async () => {
      const res = await O().post(url('/channels/meta/login')).expect(200);
      const login = new URL(res.body.url as string);
      expect(`${login.origin}${login.pathname}`).toBe(
        'https://www.facebook.com/v23.0/dialog/oauth',
      );
      expect(login.searchParams.get('client_id')).toBe(APP_ID);
      expect(login.searchParams.get('redirect_uri')).toBe('http://localhost:3000/app/connect/meta');
      expect(login.searchParams.get('scope')?.split(',')).toEqual(
        expect.arrayContaining([
          'pages_messaging',
          'pages_manage_metadata',
          'instagram_manage_messages',
        ]),
      );
      const state = login.searchParams.get('state')!;
      expect(state.startsWith(`${orgId}.`)).toBe(true);
      // The rest is encrypted: no ids or names in the clear.
      expect(state).not.toContain(owner.userId);
    });

    it('lists the person’s pages after login, and a state works once', async () => {
      const { state, sessionId, pages } = await pageLogin(owner, orgId, 'CODE_OWNER');
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(pages).toEqual([
        {
          id: PAGE1.id,
          name: PAGE1.name,
          canMessage: true,
          instagram: { id: IG1.id, username: IG1.username },
          connected: { messenger: null, instagram: null },
        },
        {
          id: PAGE2.id,
          name: PAGE2.name,
          canMessage: false,
          instagram: null,
          connected: { messenger: null, instagram: null },
        },
      ]);
      // The code went back with the same redirect URI, then became a long-lived token.
      const exchanges = graph.requests.filter((r) => r.path === 'oauth/access_token');
      expect(exchanges.map((r) => r.query.grant_type ?? 'code')).toEqual([
        'code',
        'fb_exchange_token',
      ]);
      expect(exchanges[0]!.query.redirect_uri).toBe('http://localhost:3000/app/connect/meta');
      expect(graph.requests.find((r) => r.path === 'me/accounts')?.token).toBe(
        'USER_OWNER_TOKEN-long',
      );

      const again = await O()
        .post(url('/channels/meta/login/finish'))
        .send({ code: 'CODE_OWNER', state })
        .expect(400);
      expect(again.body.code).toBe('state_used');
      // The chooser can reload the list while the session lasts.
      const reload = await O()
        .get(url(`/channels/meta/login/${sessionId}`))
        .expect(200);
      expect((reload.body.pages as PageChoice[]).map((p) => p.id)).toEqual([PAGE1.id, PAGE2.id]);
    });

    it('refuses a state or a page list that belongs to another business or person', async () => {
      const start = await O().post(url('/channels/meta/login')).expect(200);
      const state = new URL(start.body.url as string).searchParams.get('state')!;
      const res = await t
        .as(rival.token)
        .post(url('/channels/meta/login/finish', rivalOrgId))
        .send({ code: 'CODE_RIVAL', state })
        .expect(400);
      expect(res.body.code).toBe('invalid_state');
      await O()
        .post(url('/channels/meta/login/finish'))
        .send({ code: 'CODE_OWNER', state: 'x.y' })
        .expect(400);

      const mine = await pageLogin(owner, orgId, 'CODE_OWNER');
      const stolen = await t
        .as(rival.token)
        .get(url(`/channels/meta/login/${mine.sessionId}`, rivalOrgId))
        .expect(400);
      expect(stolen.body.code).toBe('connect_session_expired');
    });

    it('connects a page’s Messenger and Instagram, subscribes the page, and keeps the token sealed', async () => {
      const { sessionId } = await pageLogin(owner, orgId, 'CODE_OWNER');
      graph.reset();
      const res = await O()
        .post(url('/channels/meta/pages'))
        .send({ sessionId, pageId: PAGE1.id, messenger: true, instagram: true })
        .expect(201);
      const items = res.body.items as ChannelDto[];
      expect(items.map((c) => [c.type, c.name, c.status, c.account?.externalId])).toEqual([
        ['messenger', PAGE1.name, 'active', PAGE1.id],
        ['instagram', `@${IG1.username}`, 'active', IG1.id],
      ]);
      channel.messenger = items[0]!;
      channel.instagram = items[1]!;
      expect(graph.requests).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: `${PAGE1.id}/subscribed_apps`,
          token: PAGE1.token,
          query: expect.objectContaining({
            subscribed_fields:
              'messages,messaging_postbacks,message_echoes,message_deliveries,message_reads',
          }),
        }),
      ]);
      // Tokens never leave the server and are stored encrypted.
      const list = await O().get(url('/channels')).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(PAGE1.token);
      const raw = await t.db.collection('channels').findOne({ 'meta.externalId': PAGE1.id });
      expect(JSON.stringify(raw)).not.toContain(PAGE1.token);
      expect(raw?.meta.accessTokenEnc).toMatch(/^v1\./);
    });

    it('refuses a page the person cannot message as, or one without Instagram', async () => {
      const { sessionId } = await pageLogin(owner, orgId, 'CODE_OWNER');
      const noRole = await O()
        .post(url('/channels/meta/pages'))
        .send({ sessionId, pageId: PAGE2.id, messenger: true, instagram: false })
        .expect(400);
      expect(noRole.body.code).toBe('page_messaging_not_allowed');
      const noIg = await O()
        .post(url('/channels/meta/pages'))
        .send({ sessionId, pageId: PAGE2.id, messenger: false, instagram: true })
        .expect(400);
      expect(noIg.body.code).toBe('no_instagram_account');
    });

    it('keeps an account with the business that connected it', async () => {
      const { sessionId, pages } = await pageLogin(rival, rivalOrgId, 'CODE_RIVAL');
      expect(pages[0]!.connected).toEqual({ messenger: 'elsewhere', instagram: null });
      const res = await t
        .as(rival.token)
        .post(url('/channels/meta/pages', rivalOrgId))
        .send({ sessionId, pageId: PAGE1.id, messenger: true, instagram: false })
        .expect(409);
      expect(res.body.code).toBe('account_connected_elsewhere');
      const rivalChannels = await t.as(rival.token).get(url('/channels', rivalOrgId)).expect(200);
      expect(rivalChannels.body.items).toEqual([]);
    });

    it('reconnecting the same page updates it instead of adding another', async () => {
      const { sessionId, pages } = await pageLogin(owner, orgId, 'CODE_OWNER');
      expect(pages[0]!.connected).toEqual({ messenger: 'here', instagram: 'here' });
      const res = await O()
        .post(url('/channels/meta/pages'))
        .send({ sessionId, pageId: PAGE1.id, messenger: true, instagram: false })
        .expect(201);
      expect((res.body.items as ChannelDto[])[0]!.id).toBe(channel.messenger.id);
      const list = (await O().get(url('/channels')).expect(200)).body.items as ChannelDto[];
      expect(list.filter((c) => c.type === 'messenger')).toHaveLength(1);
    });

    it('respects the plan’s channel limit', async () => {
      await setOverrides({ limits: { channels: 2 } });
      const res = await O()
        .post(url('/channels/meta/whatsapp'))
        .send({ phoneNumberId: WA1.phoneNumberId, wabaId: WA1.wabaId, accessToken: WA1.token })
        .expect(402);
      expect(res.body).toMatchObject({ code: 'plan_limit_reached', limit: 'channels', max: 2 });
      expect(graph.requests).toHaveLength(0);
      await setOverrides({ limits: {} });
    });

    it('checks a WhatsApp token and number before connecting them', async () => {
      const badToken = await O()
        .post(url('/channels/meta/whatsapp'))
        .send({
          phoneNumberId: WA1.phoneNumberId,
          wabaId: WA1.wabaId,
          accessToken: 'NOT_A_REAL_TOKEN_123456',
        })
        .expect(400);
      expect(badToken.body.code).toBe('meta_access_denied');
      const wrongWaba = await O()
        .post(url('/channels/meta/whatsapp'))
        .send({ phoneNumberId: WA1.phoneNumberId, wabaId: WA2.wabaId, accessToken: WA1.token })
        .expect(400);
      expect(wrongWaba.body.code).toBe('whatsapp_number_not_in_account');

      graph.reset();
      const res = await O()
        .post(url('/channels/meta/whatsapp'))
        .send({ phoneNumberId: WA1.phoneNumberId, wabaId: WA1.wabaId, accessToken: WA1.token })
        .expect(201);
      channel.whatsapp = res.body as ChannelDto;
      expect(channel.whatsapp).toMatchObject({
        type: 'whatsapp',
        name: `${WA1.verifiedName} · ${WA1.displayPhone}`,
        account: { externalId: WA1.phoneNumberId },
      });
      expect(graph.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `GET ${WA1.phoneNumberId}`,
        `GET ${WA1.wabaId}/phone_numbers`,
        `POST ${WA1.wabaId}/subscribed_apps`,
      ]);
    });

    it('connects WhatsApp from Embedded Signup', async () => {
      const res = await O()
        .post(url('/channels/meta/whatsapp/embedded'))
        .send({ code: 'ES_CODE', phoneNumberId: WA2.phoneNumberId, wabaId: WA2.wabaId })
        .expect(201);
      channel.whatsapp2 = res.body as ChannelDto;
      expect(channel.whatsapp2.account?.externalId).toBe(WA2.phoneNumberId);
      const exchange = graph.requests.find((r) => r.path === 'oauth/access_token');
      expect(exchange?.query).toMatchObject({ client_id: APP_ID, code: 'ES_CODE' });
      expect(exchange?.query.redirect_uri).toBeUndefined();
      const bad = await O()
        .post(url('/channels/meta/whatsapp/embedded'))
        .send({ code: 'USED_CODE', phoneNumberId: WA2.phoneNumberId, wabaId: WA2.wabaId })
        .expect(400);
      expect(bad.body.code).toBe('meta_rejected');
    });

    it('needs the integrations permission', async () => {
      const sales = await t.addMember(owner, orgId, 'sales_agent');
      await t.as(sales.token).post(url('/channels/meta/login')).expect(403);
      await t.as(sales.token).get(url('/channels/meta/settings')).expect(403);
    });
  });

  // ------------------------------------------------------------------ receiving

  describe('receiving', () => {
    it('stores a Messenger message once, with the customer’s name from their profile', async () => {
      graph.profiles.set('5550001112223', {
        first_name: 'Rahim',
        last_name: 'Uddin',
        profile_pic: 'https://platform-lookaside.example/rahim.jpg',
      });
      const body = webhook.messenger(PAGE1.id, '5550001112223', 'm_first_1', 'Saree ache?');
      expect(await receive(body)).toEqual(['stored']);
      // Meta delivers again (a retry): stored once.
      expect(await receive(body)).toEqual(['duplicate']);

      const conv = await conversationOn(channel.messenger.id);
      expect(conv).toMatchObject({
        channelType: 'messenger',
        contact: { name: 'Rahim Uddin', avatarUrl: 'https://platform-lookaside.example/rahim.jpg' },
      });
      expect(Date.parse(conv.replyWindowEndsAt!) - Date.parse(conv.lastInboundAt!)).toBe(
        24 * 3600_000,
      );
      const msgs = await thread(conv.id);
      expect(msgs.map((m) => [m.direction, m.text])).toEqual([['in', 'Saree ache?']]);
      const profileCall = graph.requests.find((r) => r.path === '5550001112223');
      expect(profileCall).toMatchObject({
        token: PAGE1.token,
        query: expect.objectContaining({ fields: 'first_name,last_name,profile_pic' }),
      });
    });

    it('stores Instagram and WhatsApp messages on their channels', async () => {
      graph.profiles.set('7770001', { name: '', username: 'nadia.shop' });
      expect(
        await receive(
          webhook.instagram(IG1.id, '7770001', mid('ig'), 'Price koto?'),
          webhook.whatsapp(
            WA1.phoneNumberId,
            '8801711111111',
            mid('wamid'),
            'Panjabi ache?',
            'Karim',
          ),
        ),
      ).toEqual(['stored', 'stored']);
      const ig = await conversationOn(channel.instagram.id);
      expect(ig.contact?.name).toBe('@nadia.shop');
      const wa = await conversationOn(channel.whatsapp.id);
      expect(wa.contact).toMatchObject({ name: 'Karim', phone: '+8801711111111' });
    });

    it('drops events for accounts nobody connected, and keeps each business’s messages to itself', async () => {
      const before = await t.db.collection('messages').countDocuments();
      expect(await receive(webhook.messenger('9999999999999', '1234', mid(), 'hello'))).toEqual([
        'unknown_account',
      ]);
      expect(await t.db.collection('messages').countDocuments()).toBe(before);
      expect(await conversations(rivalOrgId, rival)).toEqual([]);
    });

    it('takes no new messages on a turned-off channel', async () => {
      await O()
        .patch(url(`/channels/${channel.whatsapp2.id}`))
        .send({ status: 'disabled' })
        .expect(200);
      expect(
        await receive(webhook.whatsapp(WA2.phoneNumberId, '8801722222222', mid('wamid'), 'hi')),
      ).toEqual(['channel_off']);
      await O()
        .patch(url(`/channels/${channel.whatsapp2.id}`))
        .send({ status: 'active' })
        .expect(200);
    });
  });

  // ------------------------------------------------------------------ replying

  describe('replying', () => {
    it('sends a staff reply through the Send API and records Meta’s message id', async () => {
      const conv = await conversationOn(channel.messenger.id);
      const res = await reply(conv.id, 'Ji ache, ৳3,000.').expect(201);
      expect(res.body.message.delivery).toEqual({ status: 'pending', error: null });
      expect(graph.sent()).toHaveLength(0); // never inside the request

      expect(await drainOutbox()).toEqual([
        { status: 'sent', parts: 1, externalId: expect.stringMatching(/^m_out_/) },
      ]);
      const [send] = graph.sent();
      expect(send).toMatchObject({
        path: `${PAGE1.id}/messages`,
        version: 'v23.0',
        token: PAGE1.token,
        body: {
          recipient: { id: '5550001112223' },
          messaging_type: 'RESPONSE',
          message: { text: 'Ji ache, ৳3,000.' },
        },
      });
      expect(await byText(conv.id, 'Ji ache, ৳3,000.')).toMatchObject({
        direction: 'out',
        delivery: { status: 'sent', error: null },
      });
      const stored = await t.db.collection('messages').findOne({ text: 'Ji ache, ৳3,000.' });
      expect(stored?.externalId).toMatch(/^m_out_/);
    });

    it('never messages the customer twice when saving the result fails once', async () => {
      const conv = await conversationOn(channel.messenger.id);
      const spy = vi
        .spyOn(t.app.get(MessagingService), 'updateDelivery')
        .mockRejectedValueOnce(new Error('database blip'));
      try {
        await reply(conv.id, 'Ekbar-i jabe').expect(201);
        // Sent, but recording it failed: the queue keeps the job to try again.
        expect(await drainOutbox({ finalAttempt: false })).toEqual([{ error: expect.any(Error) }]);
        expect(graph.sent()).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
      expect(await drainOutbox()).toEqual([
        { status: 'sent', parts: 1, externalId: expect.stringMatching(/^m_out_/) },
      ]);
      expect(graph.sent()).toHaveLength(1);
      expect(await byText(conv.id, 'Ekbar-i jabe')).toMatchObject({
        delivery: { status: 'sent', error: null },
      });
    });

    it('splits a long Instagram reply and sends the parts in order', async () => {
      const conv = await conversationOn(channel.instagram.id);
      const text = `${'Amader kache onek design ache. '.repeat(40)}Konta nite chan?`;
      await reply(conv.id, text).expect(201);
      const [outcome] = await drainOutbox();
      expect(outcome).toMatchObject({ status: 'sent', parts: 2 });
      const parts = graph.sent().map((r) => (r.body?.message as { text: string }).text);
      expect(parts).toHaveLength(2);
      expect(parts.every((p) => Array.from(p).length <= 1000)).toBe(true);
      expect(parts.join(' ')).toBe(text);
      expect(graph.sent()[0]!.path).toBe(`${PAGE1.id}/messages`);
    });

    it('sends WhatsApp replies and follows delivery reports forward only', async () => {
      const conv = await conversationOn(channel.whatsapp.id);
      await reply(conv.id, 'Ji, M size ache.').expect(201);
      await drainOutbox();
      const [send] = graph.sent();
      expect(send).toMatchObject({
        path: `${WA1.phoneNumberId}/messages`,
        token: WA1.token,
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '8801711111111',
          type: 'text',
          text: { body: 'Ji, M size ache.', preview_url: false },
        },
      });
      const stored = await t.db.collection('messages').findOne({ text: 'Ji, M size ache.' });
      const wamid = stored!.externalId as string;
      await receive(
        webhook.whatsappStatus(WA1.phoneNumberId, wamid, 'delivered'),
        webhook.whatsappStatus(WA1.phoneNumberId, wamid, 'read'),
        // Arrives late: must not undo "read".
        webhook.whatsappStatus(WA1.phoneNumberId, wamid, 'sent'),
      );
      expect((await byText(conv.id, 'Ji, M size ache.')).delivery.status).toBe('read');
    });

    it('records a WhatsApp delivery failure with Meta’s reason', async () => {
      const conv = await conversationOn(channel.whatsapp.id);
      await reply(conv.id, 'Order confirm korben?').expect(201);
      await drainOutbox();
      const stored = await t.db.collection('messages').findOne({ text: 'Order confirm korben?' });
      await receive(
        webhook.whatsappStatus(
          WA1.phoneNumberId,
          stored!.externalId as string,
          'failed',
          'Message undeliverable',
        ),
      );
      expect((await byText(conv.id, 'Order confirm korben?')).delivery).toEqual({
        status: 'failed',
        error: 'Message undeliverable',
      });
    });

    it('follows Messenger read receipts up to their time', async () => {
      const conv = await conversationOn(channel.messenger.id);
      await reply(conv.id, 'Delivery charge ৳60.').expect(201);
      await drainOutbox();
      await receive(webhook.read(PAGE1.id, '5550001112223', Date.now() + 1_000));
      const outs = (await thread(conv.id)).filter(
        (m) => m.direction === 'out' && m.type === 'text',
      );
      expect(outs.map((m) => m.delivery.status)).toEqual(outs.map(() => 'read'));
    });

    it('refuses replies once 24 hours have passed since the customer wrote', async () => {
      const conv = await conversationOn(channel.messenger.id);
      const old = new Date(Date.now() - 25 * 3600_000);
      await t.db
        .collection('conversations')
        .updateOne({ _id: new Types.ObjectId(conv.id) }, { $set: { lastInboundAt: old } });
      const res = await reply(conv.id, 'Are you there?').expect(409);
      expect(res.body.code).toBe('outside_reply_window');
      // Notes are still fine.
      await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: 'Call her', note: true })
        .expect(201);
      const dto = (
        await O()
          .get(url(`/conversations/${conv.id}`))
          .expect(200)
      ).body as ConversationDto;
      expect(Date.parse(dto.replyWindowEndsAt!)).toBeLessThan(Date.now());
      // The customer writes again: the window opens.
      await receive(webhook.messenger(PAGE1.id, '5550001112223', mid(), 'Hello?'));
      await reply(conv.id, 'Ji bolun').expect(201);
      await drainOutbox();
    });

    it('retries rate limits and keeps the conversation’s order', async () => {
      const conv = await conversationOn(channel.messenger.id);
      graph.fail('POST', /\/messages$/, 400, {
        code: 613,
        message: 'Calls to this api have exceeded the rate limit.',
      });
      await reply(conv.id, 'First').expect(201);
      await reply(conv.id, 'Second').expect(201);

      // First attempt: "First" is rate limited (the queue will retry), "Second" waits for it.
      const round1 = await drainOutbox({ finalAttempt: false, rounds: 1 });
      expect(round1).toEqual([{ error: expect.objectContaining({ kind: 'rate_limited' }) }]);
      const statuses = async () =>
        (await thread(conv.id))
          .filter((m) => m.text === 'First' || m.text === 'Second')
          .map((m) => [m.text, m.delivery.status]);
      expect(await statuses()).toEqual([
        ['First', 'pending'],
        ['Second', 'pending'],
      ]);
      await drainOutbox();
      // Every attempt, in order: "Second" was not tried until "First" went through.
      expect(graph.sent().map((r) => (r.body?.message as { text: string }).text)).toEqual([
        'First',
        'First',
        'Second',
      ]);
      expect(await statuses()).toEqual([
        ['First', 'sent'],
        ['Second', 'sent'],
      ]);
    });

    it('the worker holds a message until the one before it went out', async () => {
      const conv = await conversationOn(channel.messenger.id);
      const outbox = queue<OutboxJob>(QUEUES.outbox);
      graph.sendDelayMs = 400;
      const first = (await reply(conv.id, 'Worker first').expect(201)).body.message.id as string;
      const second = (await reply(conv.id, 'Worker second').expect(201)).body.message.id as string;
      const processor = new OutboxProcessor(sender());
      const worker = new Worker<OutboxJob>(
        QUEUES.outbox,
        (job, token) => processor.process(job, token),
        { connection: outbox.opts.connection, prefix: outbox.opts.prefix, concurrency: 8 },
      );
      try {
        await eventually(async () => {
          const m = await byText(conv.id, 'Worker second');
          return m.delivery.status === 'sent' ? m : null;
        }, 10_000);
      } finally {
        await worker.close();
        graph.sendDelayMs = 0;
      }
      expect(graph.sent().map((r) => (r.body?.message as { text: string }).text)).toEqual([
        'Worker first',
        'Worker second',
      ]);
      // Both jobs ran at once; the second waited (without using an attempt) for the first.
      const waited = await outbox.getJob(`send-${second}`);
      expect(waited?.data.waits).toBeGreaterThanOrEqual(1);
      expect(waited?.attemptsMade).toBe(1);
      expect((await outbox.getJob(`send-${first}`))?.returnvalue).toMatchObject({ status: 'sent' });
    });

    it('marks a refused message failed, and sends it again on request', async () => {
      const conv = await conversationOn(channel.messenger.id);
      graph.fail('POST', /\/messages$/, 400, { code: 100, message: '(#100) Invalid parameter' });
      const posted = await reply(conv.id, 'Try this link').expect(201);
      const id = posted.body.message.id as string;
      expect(await drainOutbox()).toEqual([
        {
          status: 'failed',
          reason: 'Not delivered: Meta refused the message ((#100) Invalid parameter).',
        },
      ]);
      const failed = (await thread(conv.id)).find((m) => m.id === id)!;
      expect(failed.delivery.status).toBe('failed');

      const retried = await O()
        .post(url(`/conversations/${conv.id}/messages/${id}/retry`))
        .expect(200);
      expect(retried.body.message.delivery).toEqual({ status: 'pending', error: null });
      await O()
        .post(url(`/conversations/${conv.id}/messages/${id}/retry`))
        .expect(409);
      await drainOutbox();
      expect((await thread(conv.id)).find((m) => m.id === id)!.delivery.status).toBe('sent');
    });

    it('asks for a reconnect when Meta rejects the token, and recovers after it', async () => {
      const conv = await conversationOn(channel.messenger.id);
      graph.fail('POST', /\/messages$/, 400, {
        code: 190,
        error_subcode: 460,
        message: 'The session has been invalidated because the user changed their password',
      });
      const announced = vi.spyOn(t.app.get(InboxRealtime), 'channelUpdated');
      await reply(conv.id, 'Hello again').expect(201);
      const [outcome] = await drainOutbox({ finalAttempt: false });
      // Open inboxes hear it at once and stop offering replies.
      expect(announced).toHaveBeenCalledWith(orgId, { id: channel.messenger.id, status: 'error' });
      expect(outcome).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('Reconnect'),
      });
      const ch = (
        await O()
          .get(url(`/channels/${channel.messenger.id}`))
          .expect(200)
      ).body as ChannelDto;
      expect(ch.status).toBe('error');
      expect(ch.statusReason).toMatch(/Reconnect/);
      const blocked = await reply(conv.id, 'Anyone?').expect(409);
      expect(blocked.body.code).toBe('channel_needs_reconnect');
      // Instagram on the same page is a separate channel and keeps working.
      expect(
        (
          await O()
            .get(url(`/channels/${channel.instagram.id}`))
            .expect(200)
        ).body.status,
      ).toBe('active');

      const { sessionId } = await pageLogin(owner, orgId, 'CODE_OWNER');
      await O()
        .post(url('/channels/meta/pages'))
        .send({ sessionId, pageId: PAGE1.id, messenger: true, instagram: false })
        .expect(201);
      const fixed = (
        await O()
          .get(url(`/channels/${channel.messenger.id}`))
          .expect(200)
      ).body as ChannelDto;
      expect(fixed).toMatchObject({ status: 'active', statusReason: null });
      expect(announced).toHaveBeenLastCalledWith(orgId, {
        id: channel.messenger.id,
        status: 'active',
      });
      announced.mockRestore();
      await reply(conv.id, 'Sorry for the wait').expect(201);
      expect(await drainOutbox()).toEqual([expect.objectContaining({ status: 'sent' })]);
    });
  });

  // ------------------------------------------------------------------ replies from elsewhere and the AI

  describe('with the AI agent', () => {
    const aiQueue = () => queue<{ messageId: string }>(QUEUES.ai);

    beforeAll(async () => {
      await O().patch(url('/ai-agent')).send({ enabled: true, replyDelaySeconds: 0 }).expect(200);
    });

    it('answers a Messenger customer through the outbox', async () => {
      const psid = '5550009998887';
      graph.profiles.set(psid, { first_name: 'Sumi', last_name: 'Akter' });
      const messageId = mid();
      await receive(webhook.messenger(PAGE1.id, psid, messageId, 'Assalamu alaikum, saree ache?'));
      const conv = await conversationOn(channel.messenger.id, 'Sumi Akter');
      const stored = await t.db.collection('messages').findOne({ externalId: messageId });
      const jobId = `reply-${stored!._id.toHexString()}`;
      // Scheduling follows the stored message.
      const job = await eventually(() => aiQueue().getJob(jobId));

      ai.then(FakeAnthropic.text('Walaikum assalam! Ji, Jamdani Saree ache.'));
      const outcome = await t.app
        .get(AiRepliesService)
        .handleJob(
          { orgId, conversationId: conv.id, messageId: stored!._id.toHexString() },
          { finalAttempt: true },
        );
      expect(outcome).toMatchObject({ status: 'replied' });
      await job.remove();

      expect(await drainOutbox()).toEqual([expect.objectContaining({ status: 'sent' })]);
      expect(graph.sent()[0]).toMatchObject({
        body: {
          recipient: { id: psid },
          message: { text: 'Walaikum assalam! Ji, Jamdani Saree ache.' },
        },
      });
      const last = (await thread(conv.id)).at(-1)!;
      expect(last).toMatchObject({ sender: { type: 'ai' }, delivery: { status: 'sent' } });
    });

    it('does not answer once the 24-hour window has closed', async () => {
      const conv = await conversationOn(channel.messenger.id, 'Sumi Akter');
      const last = await t.db
        .collection('messages')
        .find({ direction: 'in' })
        .sort({ _id: -1 })
        .limit(1)
        .next();
      await t.db
        .collection('conversations')
        .updateOne(
          { _id: last!.conversationId },
          { $set: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) } },
        );
      // A new customer message would reopen the window, so run the old job directly.
      const outcome = await t.app
        .get(AiRepliesService)
        .handleJob(
          { orgId, conversationId: conv.id, messageId: last!._id.toHexString() },
          { finalAttempt: true },
        );
      expect(outcome).toEqual({ status: 'skipped', reason: 'outside_reply_window' });
      await t.db
        .collection('conversations')
        .updateOne({ _id: last!.conversationId }, { $set: { lastInboundAt: new Date() } });
    });

    it('shows replies sent from Facebook in the thread and pauses the AI', async () => {
      const conv = await conversationOn(channel.messenger.id, 'Sumi Akter');
      expect(conv.ai.mode).toBe('auto');
      // Our own sends echo back with our app id: ignored.
      expect(
        await receive(webhook.echo(PAGE1.id, '5550009998887', mid('m_echo'), 'ours', APP_ID)),
      ).toEqual(['own_echo']);
      const echoId = mid('m_echo');
      expect(
        await receive(
          webhook.echo(
            PAGE1.id,
            '5550009998887',
            echoId,
            'Apu, ami call dicchi',
            '263902037430900',
          ),
        ),
      ).toEqual(['echo_stored']);
      expect(
        await receive(
          webhook.echo(
            PAGE1.id,
            '5550009998887',
            echoId,
            'Apu, ami call dicchi',
            '263902037430900',
          ),
        ),
      ).toEqual(['echo_ignored']);
      const after = (
        await O()
          .get(url(`/conversations/${conv.id}`))
          .expect(200)
      ).body as ConversationDto;
      expect(after.ai).toMatchObject({ mode: 'paused', reason: 'replied_elsewhere' });
      const msgs = await thread(conv.id);
      expect(msgs.slice(-2).map((m) => [m.type, m.sender.name ?? m.sender.type, m.text])).toEqual([
        ['text', 'Sent from Messenger', 'Apu, ami call dicchi'],
        ['system', 'system', 'Someone replied from Messenger outside Sellora, so the AI paused.'],
      ]);
    });
  });

  // ------------------------------------------------------------------ removing

  describe('removing', () => {
    it('unsubscribes a page only when no channel uses it any more', async () => {
      const removed = new Promise((r) => setTimeout(r, 150));
      await O()
        .delete(url(`/channels/${channel.messenger.id}`))
        .expect(204);
      await removed;
      expect(graph.requests.filter((r) => r.method === 'DELETE')).toEqual([]);

      await O()
        .delete(url(`/channels/${channel.instagram.id}`))
        .expect(204);
      await new Promise((r) => setTimeout(r, 150));
      expect(graph.requests.filter((r) => r.method === 'DELETE')).toEqual([
        expect.objectContaining({ path: `${PAGE1.id}/subscribed_apps`, token: PAGE1.token }),
      ]);

      // The page's messages are no longer taken; past conversations stay.
      expect(await receive(webhook.messenger(PAGE1.id, '5550001112223', mid(), 'hi'))).toEqual([
        'unknown_account',
      ]);
      expect((await conversations()).some((c) => c.channelId === channel.messenger.id)).toBe(true);
    });
  });
});
