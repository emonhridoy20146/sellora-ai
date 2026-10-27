import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ChannelDto {
  id: string;
  type: string;
  name: string;
  status: string;
  aiEnabled: boolean;
  webChat: {
    publicKey: string;
    allowedOrigins: string[];
    greeting: string;
    color: string;
    askContact: boolean;
  } | null;
}

interface ConversationDto {
  id: string;
  channelId: string;
  status: string;
  assigneeId: string | null;
  ai: { mode: string; reason: string | null };
  lastMessage: { text: string; direction: string; senderType: string } | null;
  unread: number;
  locked: boolean;
  contact: { id: string; name: string; phone: string | null } | null;
}

interface MessageDto {
  id: string;
  conversationId: string;
  direction: string;
  type: string;
  sender: { type: string; id: string | null; name: string | null };
  text: string;
  clientId: string | null;
}

interface VisitorMessage {
  id: string;
  from: 'visitor' | 'business';
  name: string | null;
  type: string;
  text: string;
  clientId: string | null;
}

let seq = 0;
const cid = () => `c${Date.now().toString(36)}${(seq += 1).toString().padStart(4, '0')}`;

function waitFor<T>(socket: Socket, event: string, match?: (d: T) => boolean, ms = 5_000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`no ${event} within ${ms} ms`));
    }, ms);
    const handler = (data: T) => {
      if (match && !match(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

describe('inbox: channels, conversations, web chat and live updates', () => {
  let t: TestApp;
  let base: string;
  let owner: Session;
  let agent: Session; // sales_agent: sees only conversations assigned to them
  let fulfillment: Session; // cannot reply
  let orgId: string;
  let platform: string;
  let channel: ChannelDto;
  const sockets: Socket[] = [];

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const widget = (path = '') => `/v1/webchat/${channel.webChat!.publicKey}${path}`;

  const setOverrides = (body: Record<string, unknown>) =>
    t
      .as(platform)
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ note: 'inbox test', ...body })
      .expect(200);

  const visitor = async () => {
    const res = await t.http().post(widget('/session')).send({}).expect(200);
    return res.body as { token: string; contact: unknown; messages: VisitorMessage[] };
  };

  const say = (token: string, text: string, clientId = cid()) =>
    t
      .http()
      .post(widget('/messages'))
      .set('authorization', `Bearer ${token}`)
      .send({ text, clientId });

  const conversations = async (as = owner, query = '') =>
    (
      await t
        .as(as.token)
        .get(url(`/conversations${query}`))
        .expect(200)
    ).body as {
      items: ConversationDto[];
    };

  const socket = (ns: 'agents' | 'webchat', opts: Record<string, unknown>) => {
    const s = io(`${base}/${ns}`, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...opts,
    });
    sockets.push(s);
    return s;
  };

  const staffSocket = async (session: Session) => {
    const s = socket('agents', { auth: { token: session.token } });
    await connected(s);
    const ack = (await s.emitWithAck('join', { orgId })) as { ok: boolean; scope?: string };
    return { s, ack };
  };

  beforeAll(async () => {
    t = await TestApp.create();
    base = await t.listen();
    owner = await t.registerUser({ name: 'Owner Rahman' });
    orgId = (await t.createOrg(owner, { name: 'Dhaka Fashion' })).id;
    agent = await t.addMember(
      owner,
      orgId,
      'sales_agent',
      await t.registerUser({ name: 'Agent Karim' }),
    );
    fulfillment = await t.addMember(owner, orgId, 'fulfillment');
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Channel', 'Contact', 'Conversation', 'Message'].map((m) => t.db.model(m).init()),
    );
    // Start like the free plan: one channel and no AI agent.
    await setOverrides({ removeModules: ['ai_agent'], limits: { channels: 1 } });
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await t.close();
  });

  describe('channels', () => {
    it('creates a web chat widget with tidy settings and a public key', async () => {
      const res = await O()
        .post(url('/channels/web-chat'))
        .send({
          name: 'Website',
          allowedOrigins: ['myshop.com', 'https://www.myshop.com/', 'https://myshop.com'],
          greeting: 'Hi! How can we help?',
          color: '#FF5500',
        })
        .expect(201);
      channel = res.body as ChannelDto;
      expect(channel).toMatchObject({
        type: 'web_chat',
        name: 'Website',
        status: 'active',
        aiEnabled: true,
        webChat: {
          allowedOrigins: ['https://myshop.com', 'https://www.myshop.com'],
          greeting: 'Hi! How can we help?',
          color: '#ff5500',
          askContact: true,
        },
      });
      expect(channel.webChat!.publicKey).toMatch(/^wc_[A-Za-z0-9_-]{24}$/);
      const list = await O().get(url('/channels')).expect(200);
      expect((list.body.items as ChannelDto[]).map((c) => c.id)).toEqual([channel.id]);
    });

    it('rejects bad widget settings', async () => {
      const res = await O()
        .post(url('/channels/web-chat'))
        .send({ name: 'Bad', allowedOrigins: ['ftp://files.example.com'], color: 'red' })
        .expect(422);
      const paths = (res.body.errors as { path: string }[]).map((e) => e.path);
      expect(paths).toEqual(expect.arrayContaining(['body.allowedOrigins.0', 'body.color']));
    });

    it('enforces the channel limit; turning one off frees its slot', async () => {
      const blocked = await O()
        .post(url('/channels/web-chat'))
        .send({ name: 'Second' })
        .expect(402);
      expect(blocked.body).toMatchObject({ code: 'plan_limit_reached', limit: 'channels', max: 1 });

      await O()
        .patch(url(`/channels/${channel.id}`))
        .send({ status: 'disabled' })
        .expect(200);
      const second = (
        await O().post(url('/channels/web-chat')).send({ name: 'Second' }).expect(201)
      ).body as ChannelDto;
      const reenable = await O()
        .patch(url(`/channels/${channel.id}`))
        .send({ status: 'active' })
        .expect(402);
      expect(reenable.body.code).toBe('plan_limit_reached');

      await O()
        .delete(url(`/channels/${second.id}`))
        .expect(204);
      await O()
        .patch(url(`/channels/${channel.id}`))
        .send({ status: 'active' })
        .expect(200);
    });

    it('needs org.integrations.manage to change channels', async () => {
      await t.as(agent.token).post(url('/channels/web-chat')).send({ name: 'X' }).expect(403);
      await t
        .as(agent.token)
        .patch(url(`/channels/${channel.id}`))
        .send({ name: 'X' })
        .expect(403);
    });
  });

  describe('website chat (visitor side)', () => {
    it('serves the widget settings by key, and nothing for unknown or disabled widgets', async () => {
      const res = await t.http().get(widget()).expect(200);
      expect(res.body).toEqual({
        businessName: 'Dhaka Fashion',
        greeting: 'Hi! How can we help?',
        color: '#ff5500',
        askContact: true,
        allowedOrigins: ['https://myshop.com', 'https://www.myshop.com'],
      });
      await t.http().get('/v1/webchat/wc_AAAAAAAAAAAAAAAAAAAAAAAA').expect(404);
      await t.http().get('/v1/webchat/not-a-key').expect(422);

      await O()
        .patch(url(`/channels/${channel.id}`))
        .send({ status: 'disabled' })
        .expect(200);
      await t.http().get(widget()).expect(404);
      await t.http().post(widget('/session')).send({}).expect(404);
      await O()
        .patch(url(`/channels/${channel.id}`))
        .send({ status: 'active' })
        .expect(200);
    });

    it('a visitor writes; the business sees a new open conversation with one unread', async () => {
      const v = await visitor();
      expect(v.messages).toEqual([]);
      const sent = await say(v.token, 'Is the red kurti in stock?').expect(201);
      expect(sent.body.message).toMatchObject({
        from: 'visitor',
        text: 'Is the red kurti in stock?',
      });

      const { items } = await conversations();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        channelId: channel.id,
        status: 'open',
        unread: 1,
        assigneeId: null,
        ai: { mode: 'auto' },
        locked: false,
        lastMessage: { text: 'Is the red kurti in stock?', direction: 'in', senderType: 'contact' },
      });
    });

    it('stores a retried message once', async () => {
      const v = await visitor();
      const clientId = cid();
      const a = await say(v.token, 'Hello', clientId).expect(201);
      const b = await say(v.token, 'Hello', clientId).expect(201);
      expect(b.body.message.id).toBe(a.body.message.id);
      const history = await t
        .http()
        .get(widget('/messages'))
        .set('authorization', `Bearer ${v.token}`)
        .expect(200);
      expect(history.body.messages).toHaveLength(1);
    });

    it('resumes with the same token and keeps history; a token for another widget does not work', async () => {
      const v = await visitor();
      await say(v.token, 'First visit').expect(201);
      const again = await t.http().post(widget('/session')).send({ token: v.token }).expect(200);
      expect((again.body.messages as VisitorMessage[]).map((m) => m.text)).toEqual(['First visit']);

      await setOverrides({ removeModules: ['ai_agent'], limits: { channels: 2 } });
      const other = (
        await O().post(url('/channels/web-chat')).send({ name: 'Other site' }).expect(201)
      ).body as ChannelDto;
      const res = await t
        .http()
        .get(`/v1/webchat/${other.webChat!.publicKey}/messages`)
        .set('authorization', `Bearer ${v.token}`)
        .expect(401);
      expect(res.body.code).toBe('visitor_token_invalid');
      // Presented to the other widget, the token starts a fresh visitor there.
      const fresh = await t
        .http()
        .post(`/v1/webchat/${other.webChat!.publicKey}/session`)
        .send({ token: v.token })
        .expect(200);
      expect(fresh.body.messages).toEqual([]);
      await O()
        .delete(url(`/channels/${other.id}`))
        .expect(204);
      await setOverrides({ removeModules: ['ai_agent'], limits: { channels: 1 } });
      await t.http().post(widget('/messages')).send({ text: 'x', clientId: cid() }).expect(401);
      await t
        .http()
        .post(widget('/messages'))
        .set('authorization', 'Bearer forged.token')
        .send({ text: 'x', clientId: cid() })
        .expect(401);
    });

    it('works while the merchant is signed in with cookies in the same browser', async () => {
      const login = await t
        .http()
        .post('/v1/auth/login')
        .send({ email: owner.email, password: 'correct horse battery staple' })
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];
      const v = await visitor();
      await t
        .http()
        .post(widget('/messages'))
        .set('cookie', cookies.map((c) => c.split(';')[0]).join('; '))
        .set('origin', 'http://localhost:3000')
        .set('authorization', `Bearer ${v.token}`)
        .send({ text: 'From a signed-in browser', clientId: cid() })
        .expect(201);
    });

    it('takes the visitor’s name and phone, normalising the phone', async () => {
      const v = await visitor();
      await t
        .http()
        .patch(widget('/contact'))
        .set('authorization', `Bearer ${v.token}`)
        .send({ phone: 'not a phone' })
        .expect(422);
      const res = await t
        .http()
        .patch(widget('/contact'))
        .set('authorization', `Bearer ${v.token}`)
        .send({ name: 'Nusrat', phone: '01712345678' })
        .expect(200);
      expect(res.body.contact).toEqual({ name: 'Nusrat', phone: '+8801712345678', email: null });
      await say(v.token, 'I want 2 pieces').expect(201);
      const { items } = await conversations(owner, '?q=nusrat');
      expect(items).toHaveLength(1);
      expect(items[0]!.contact).toMatchObject({ name: 'Nusrat', phone: '+8801712345678' });
      const byPhone = await conversations(owner, '?q=1712345678');
      expect(byPhone.items.map((c) => c.id)).toEqual([items[0]!.id]);
    });

    it('limits how fast one visitor can send', async () => {
      const v = await visitor();
      let limited = false;
      for (let i = 0; i < 35 && !limited; i += 1) {
        const res = await say(v.token, `msg ${i}`);
        if (res.status === 429) limited = true;
        else expect(res.status).toBe(201);
      }
      expect(limited).toBe(true);
    });
  });

  describe('staff replies, notes, the dot command and handover', () => {
    let v: { token: string };
    let conv: ConversationDto;

    beforeAll(async () => {
      v = await visitor();
      await say(v.token, 'Price of the blue saree?').expect(201);
      conv = (await conversations(owner, '?q=')).items.find(
        (c) => c.lastMessage?.text === 'Price of the blue saree?',
      )!;
    });

    it('a reply reaches the visitor with the staff member’s name; a note does not', async () => {
      const reply = await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: '2,500 taka', clientId: cid() })
        .expect(201);
      expect(reply.body.message).toMatchObject({
        direction: 'out',
        type: 'text',
        sender: { type: 'user', name: 'Owner Rahman' },
      });
      // Replying takes the conversation: it is now assigned to the owner.
      expect(reply.body.conversation.assigneeId).toBe(owner.userId);

      await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: 'Customer asked twice before', note: true })
        .expect(201);

      const seen = await t
        .http()
        .get(widget('/messages'))
        .set('authorization', `Bearer ${v.token}`)
        .expect(200);
      expect((seen.body.messages as VisitorMessage[]).map((m) => [m.from, m.text, m.name])).toEqual(
        [
          ['visitor', 'Price of the blue saree?', null],
          ['business', '2,500 taka', 'Owner Rahman'],
        ],
      );

      const staff = await O()
        .get(url(`/conversations/${conv.id}/messages`))
        .expect(200);
      expect((staff.body.items as MessageDto[]).map((m) => m.type)).toEqual([
        'note',
        'text',
        'text',
      ]);
    });

    it('without the AI agent in the plan, a human reply does not touch the AI switch', async () => {
      const res = await O()
        .get(url(`/conversations/${conv.id}`))
        .expect(200);
      expect(res.body.ai.mode).toBe('auto');
    });

    it('with the AI agent, a human reply pauses the AI and says so in the thread', async () => {
      await setOverrides({ addModules: ['ai_agent'], limits: { channels: 2 } });
      await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: 'We also have it in green' })
        .expect(201);
      const res = await O()
        .get(url(`/conversations/${conv.id}`))
        .expect(200);
      expect(res.body.ai).toMatchObject({ mode: 'paused', reason: 'human_reply' });
      const staff = await O()
        .get(url(`/conversations/${conv.id}/messages?limit=1`))
        .expect(200);
      expect(staff.body.items[0]).toMatchObject({
        type: 'system',
        text: 'Owner Rahman replied, so the AI paused.',
      });
    });

    it('"." on its own toggles the AI and is never sent to the customer', async () => {
      const on = await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: ' . ' })
        .expect(201);
      expect(on.body.message).toBeNull();
      expect(on.body.conversation.ai).toMatchObject({ mode: 'auto', reason: 'dot_command' });
      const off = await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: '.' })
        .expect(201);
      expect(off.body.conversation.ai.mode).toBe('paused');

      const seen = await t
        .http()
        .get(widget('/messages'))
        .set('authorization', `Bearer ${v.token}`)
        .expect(200);
      expect((seen.body.messages as VisitorMessage[]).some((m) => m.text.trim() === '.')).toBe(
        false,
      );
      // A note of "." is just a note.
      const note = await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: '.', note: true })
        .expect(201);
      expect(note.body.message.type).toBe('note');
    });

    it('pausing and resuming needs inbox.ai_control', async () => {
      await O()
        .post(url(`/conversations/${conv.id}/ai`))
        .send({ mode: 'auto' })
        .expect(200);
      await O()
        .post(url(`/conversations/${conv.id}/assign`))
        .send({ assigneeId: agent.userId })
        .expect(200);
      // The sales agent role has inbox.ai_control.
      const res = await t
        .as(agent.token)
        .post(url(`/conversations/${conv.id}/ai`))
        .send({ mode: 'paused' })
        .expect(200);
      expect(res.body.ai.mode).toBe('paused');
    });

    it('closing and reopening, and new customer messages reopen a closed thread', async () => {
      const closed = await O()
        .post(url(`/conversations/${conv.id}/status`))
        .send({ status: 'closed' })
        .expect(200);
      expect(closed.body).toMatchObject({ status: 'closed', unread: 0 });
      expect((await conversations()).items.some((c) => c.id === conv.id)).toBe(false);
      expect((await conversations(owner, '?status=closed')).items.map((c) => c.id)).toContain(
        conv.id,
      );
      await say(v.token, 'Hello again').expect(201);
      const reopened = await O()
        .get(url(`/conversations/${conv.id}`))
        .expect(200);
      expect(reopened.body).toMatchObject({ status: 'open', unread: 1 });
      const read = await O()
        .post(url(`/conversations/${conv.id}/read`))
        .expect(200);
      expect(read.body.unread).toBe(0);
    });

    it('cannot reply on a turned-off channel', async () => {
      await O()
        .patch(url(`/channels/${channel.id}`))
        .send({ status: 'disabled' })
        .expect(200);
      const res = await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: 'Hello?' })
        .expect(409);
      expect(res.body.code).toBe('channel_disabled');
      // Notes still work.
      await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: 'Channel is off', note: true })
        .expect(201);
      await O()
        .patch(url(`/channels/${channel.id}`))
        .send({ status: 'active' })
        .expect(200);
    });
  });

  describe('who sees what', () => {
    it('a sales agent sees only conversations assigned to them', async () => {
      const mine = await conversations(agent, '?status=all');
      expect(mine.items.length).toBeGreaterThan(0);
      expect(mine.items.every((c) => c.assigneeId === agent.userId)).toBe(true);
      expect((await conversations(agent, '?assignee=unassigned')).items).toEqual([]);

      const all = await conversations(owner);
      const unassigned = all.items.find((c) => c.assigneeId === null)!;
      await t
        .as(agent.token)
        .get(url(`/conversations/${unassigned.id}`))
        .expect(404);
      await t
        .as(agent.token)
        .get(url(`/conversations/${unassigned.id}/messages`))
        .expect(404);
      await t
        .as(agent.token)
        .post(url(`/conversations/${unassigned.id}/messages`))
        .send({ text: 'hi' })
        .expect(404);
    });

    it('assigns only to members who can reply', async () => {
      const all = await conversations(owner);
      const target = all.items.find((c) => c.assigneeId === null)!;
      const res = await O()
        .post(url(`/conversations/${target.id}/assign`))
        .send({ assigneeId: fulfillment.userId })
        .expect(422);
      expect(res.body.errors[0].path).toBe('assigneeId');
      await t
        .as(agent.token)
        .post(url(`/conversations/${target.id}/assign`))
        .send({ assigneeId: agent.userId })
        .expect(403);
    });

    it('fulfillment staff without inbox access are refused', async () => {
      await t.as(fulfillment.token).get(url('/conversations')).expect(403);
    });

    it('another business sees none of it', async () => {
      const stranger = await t.registerUser();
      const otherOrg = (await t.createOrg(stranger, { name: 'Other Shop' })).id;
      const conv = (await conversations()).items[0]!;
      await t
        .as(stranger.token)
        .get(url(`/conversations/${conv.id}`))
        .expect(404);
      await t
        .as(stranger.token)
        .get(url(`/channels/${channel.id}`))
        .expect(404);
      const inOwn = await t
        .as(stranger.token)
        .get(`/v1/orgs/${otherOrg}/conversations/${conv.id}`)
        .expect(404);
      expect(inOwn.body.code).toBe('conversation_not_found');
      await t.as(stranger.token).get(`/v1/orgs/${otherOrg}/channels/${channel.id}`).expect(404);
      expect(
        (
          (await t.as(stranger.token).get(`/v1/orgs/${otherOrg}/conversations`).expect(200)).body
            .items as unknown[]
        ).length,
      ).toBe(0);
    });
  });

  describe('monthly conversation limit', () => {
    it('locks new conversations past the limit, keeps their messages, and unlocks on upgrade', async () => {
      const used = (await conversations(owner, '?status=all&limit=100')).items.length;
      await setOverrides({
        addModules: ['ai_agent'],
        limits: { channels: 2, conversationsPerMonth: used },
      });
      const v = await visitor();
      await say(v.token, 'Secret question about my order').expect(201);

      const locked = (await conversations()).items.find((c) => c.locked)!;
      expect(locked).toBeDefined();
      expect(locked.lastMessage!.text).toBe('');
      const res = await O()
        .get(url(`/conversations/${locked.id}/messages`))
        .expect(402);
      expect(res.body).toMatchObject({
        code: 'plan_limit_reached',
        limit: 'conversationsPerMonth',
        max: used,
      });
      await O()
        .post(url(`/conversations/${locked.id}/messages`))
        .send({ text: 'hello' })
        .expect(402);
      // Existing conversations keep working.
      const other = (await conversations()).items.find((c) => !c.locked)!;
      await O()
        .get(url(`/conversations/${other.id}/messages`))
        .expect(200);

      await setOverrides({
        addModules: ['ai_agent'],
        limits: { channels: 2, conversationsPerMonth: used + 1 },
      });
      const opened = await O()
        .get(url(`/conversations/${locked.id}/messages`))
        .expect(200);
      expect((opened.body.items as MessageDto[])[0]!.text).toBe('Secret question about my order');
      const after = await O()
        .get(url(`/conversations/${locked.id}`))
        .expect(200);
      expect(after.body.locked).toBe(false);
      await setOverrides({ addModules: ['ai_agent'], limits: { channels: 2 } });
    });
  });

  describe('live updates', () => {
    it('refuses sockets without a valid session, and cookie logins from other sites', async () => {
      const anon = socket('agents', {});
      await expect(connected(anon)).rejects.toThrow('unauthorized');
      const forged = socket('agents', { auth: { token: 'nope' } });
      await expect(connected(forged)).rejects.toThrow('unauthorized');
      const evil = socket('agents', {
        extraHeaders: { cookie: `sl_at=${owner.token}`, origin: 'https://evil.example' },
      });
      await expect(connected(evil)).rejects.toThrow('origin_not_allowed');
      const good = socket('agents', {
        extraHeaders: { cookie: `sl_at=${owner.token}`, origin: 'http://localhost:3000' },
      });
      await connected(good);
      expect(await good.emitWithAck('join', { orgId })).toEqual({ ok: true, scope: 'all' });
    });

    it('join answers by role: all, assigned, or refused', async () => {
      expect((await staffSocket(agent)).ack).toEqual({ ok: true, scope: 'assigned' });
      expect((await staffSocket(fulfillment)).ack).toEqual({
        ok: false,
        code: 'missing_permission',
      });
      const stranger = await t.registerUser();
      const s = socket('agents', { auth: { token: stranger.token } });
      await connected(s);
      expect(await s.emitWithAck('join', { orgId })).toEqual({ ok: false, code: 'not_found' });
    });

    it('staff get new messages live; the visitor gets replies and typing live', async () => {
      const { s: ownerSocket } = await staffSocket(owner);
      const { s: agentSocket } = await staffSocket(agent);
      const agentEvents: string[] = [];
      agentSocket.onAny((event: string) => agentEvents.push(event));

      const v = await visitor();
      const visitorSocket = socket('webchat', { auth: { token: v.token } });
      await connected(visitorSocket);

      const gotMessage = waitFor<MessageDto>(
        ownerSocket,
        'message.created',
        (m) => m.text === 'Live hello',
      );
      const gotConv = waitFor<ConversationDto>(
        ownerSocket,
        'conversation.updated',
        (c) => c.lastMessage?.text === 'Live hello',
      );
      const echo = waitFor<VisitorMessage>(
        visitorSocket,
        'message',
        (m) => m.text === 'Live hello',
      );
      await say(v.token, 'Live hello').expect(201);
      const message = await gotMessage;
      const conv = await gotConv;
      expect(message).toMatchObject({ direction: 'in', sender: { type: 'contact' } });
      expect(conv).toMatchObject({ unread: 1, assigneeId: null });
      expect((await echo).from).toBe('visitor');

      // The visitor types; staff see it.
      const typing = waitFor<{ conversationId: string }>(ownerSocket, 'typing');
      visitorSocket.emit('typing');
      expect((await typing).conversationId).toBe(conv.id);

      // Staff type and reply; the visitor sees both.
      const staffTyping = waitFor<{ typing: boolean }>(visitorSocket, 'typing');
      ownerSocket.emit('typing', { conversationId: conv.id });
      expect(await staffTyping).toEqual({ typing: true });
      const reply = waitFor<VisitorMessage>(visitorSocket, 'message', (m) => m.from === 'business');
      await O()
        .post(url(`/conversations/${conv.id}/messages`))
        .send({ text: 'Hello from the shop' })
        .expect(201);
      expect(await reply).toMatchObject({ text: 'Hello from the shop', name: 'Owner Rahman' });

      // The agent was never assigned this one, so heard nothing about it.
      await new Promise((r) => setTimeout(r, 300));
      expect(agentEvents).toEqual([]);

      // Assigning it to the agent brings it to them.
      const assigned = waitFor<ConversationDto>(
        agentSocket,
        'conversation.updated',
        (c) => c.id === conv.id,
      );
      await O()
        .post(url(`/conversations/${conv.id}/assign`))
        .send({ assigneeId: agent.userId })
        .expect(200);
      expect((await assigned).assigneeId).toBe(agent.userId);
      const next = waitFor<MessageDto>(
        agentSocket,
        'message.created',
        (m) => m.text === 'Are you there?',
      );
      await say(v.token, 'Are you there?').expect(201);
      expect((await next).conversationId).toBe(conv.id);
    });

    it('a visitor socket needs a valid visitor token', async () => {
      const s = socket('webchat', { auth: { token: 'forged' } });
      await expect(connected(s)).rejects.toThrow('visitor_token_invalid');
    });
  });
});
