import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { AiRepliesService } from '../../src/modules/ai/agent/ai-replies.service.js';
import { MAX_MEDIA_WAITS } from '../../src/modules/ai/agent/reply-queue.js';
import { InboxRealtime } from '../../src/modules/inbox/inbox-realtime.service.js';
import { MetaInbound } from '../../src/modules/meta/meta-inbound.service.js';
import { MetaMedia, type MediaJob } from '../../src/modules/meta/meta-media.js';
import type { MetaWebhookJob } from '../../src/modules/meta/meta-webhook.service.js';
import { FakeAnthropic } from '../helpers/fake-anthropic.js';
import { FakeGraph, signWebhook, webhook, whatsappMediaUrl } from '../helpers/fake-meta.js';
import { TestApp, type Session } from '../helpers/test-app.js';

const APP_ID = '2468013579';
const APP_SECRET = 'meta-app-secret-for-media-tests';
const PAGE = { id: '1100000000001', name: 'Dhaka Fashion', token: 'PAGE_TOKEN_media_abcdefghij' };
const WA = {
  phoneNumberId: '2100000000001',
  wabaId: '3100000000001',
  token: 'WA_TOKEN_media_abcdefghijklmn',
  displayPhone: '+880 1700-000011',
  verifiedName: 'Dhaka Fashion',
};
const CDN = 'https://scontent.xx.fbcdn.net/v/t1.15752-9';

interface AttachmentDto {
  url: string | null;
  contentType: string | null;
  status: 'pending' | 'ready' | 'failed';
  error: string | null;
}

interface MessageDto {
  id: string;
  type: string;
  text: string;
  sender: { type: string };
  attachments: AttachmentDto[];
}

let seq = 0;
const mid = (prefix = 'm_photo') => `${prefix}_${Date.now().toString(36)}_${(seq += 1)}`;

/** A real photo: a gradient, so the JPEG is not trivially small. */
async function photo(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') {
  const img = sharp({ create: { width, height, channels: 3, background: '#c0392b' } });
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 90 }).toBuffer();
}

describe('Customer photos from Messenger and WhatsApp', () => {
  const graph = new FakeGraph(APP_SECRET);
  const ai = new FakeAnthropic();
  let t: TestApp;
  let owner: Session;
  let agent: Session;
  let fulfillment: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let platform: string;
  let messengerId: string;
  let whatsappId: string;
  let jpeg: Buffer;

  const O = () => t.as(owner.token);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const queue = <T>(name: string) => t.app.get<Queue<T>>(getQueueToken(name));
  const media = () => t.app.get(MetaMedia);

  const receive = async (body: unknown) => {
    const signed = signWebhook(APP_SECRET, body);
    await t
      .http()
      .post('/v1/webhooks/meta')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signed.signature)
      .send(signed.raw)
      .expect(200);
    const outcomes = [];
    for (const job of await queue<MetaWebhookJob>(QUEUES.webhooks).getJobs(['waiting'])) {
      outcomes.push(...(await t.app.get(MetaInbound).handleWebhook(job.data.body)));
      await job.remove();
    }
    return outcomes;
  };

  /** Receives a photo message; returns the stored message's id and its conversation. */
  const receivePhoto = async (body: unknown, externalId: string) => {
    expect(await receive(body)).toEqual(['stored']);
    const stored = await t.db.collection('messages').findOne({ externalId });
    return {
      messageId: stored!._id.toHexString(),
      conversationId: (stored!.conversationId as { toHexString(): string }).toHexString(),
    };
  };

  /** Runs the queued media job the way the worker does. */
  const fetchMedia = async (messageId: string, finalAttempt = false) => {
    const job = await queue<MediaJob>(QUEUES.media).getJob(`media-${messageId}`);
    expect(job, 'a media job was queued').toBeTruthy();
    return media().fetch(job!.data, { finalAttempt });
  };

  const message = async (conversationId: string, messageId: string, as = owner) => {
    const res = await t
      .as(as.token)
      .get(url(`/conversations/${conversationId}/messages`))
      .expect(200);
    return (res.body.items as MessageDto[]).find((m) => m.id === messageId)!;
  };

  beforeAll(async () => {
    graph.codes.set('CODE_OWNER', 'USER_OWNER_TOKEN');
    graph.pagesByUser.set('USER_OWNER_TOKEN', [PAGE]);
    graph.whatsapp.push(WA);
    jpeg = await photo(2000, 1500);

    t = await TestApp.create(
      {
        META_APP_ID: APP_ID,
        META_APP_SECRET: APP_SECRET,
        META_WEBHOOK_VERIFY_TOKEN: 'verify-token-for-media-tests',
        META_GRAPH_BASE_URL: 'http://graph.test',
        AI_ANTHROPIC_API_KEY: 'sk-ant-test-key',
        CHAT_MEDIA_MAX_MB: '1',
      },
      { metaFetch: graph.fetch, aiFetch: ai.fetch },
    );
    owner = await t.registerUser({ name: 'Owner Rahman' });
    orgId = (await t.createOrg(owner, { name: 'Dhaka Fashion' })).id;
    agent = await t.addMember(owner, orgId, 'sales_agent');
    fulfillment = await t.addMember(owner, orgId, 'fulfillment');
    rival = await t.registerUser({ name: 'Rival Owner' });
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Shop' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Channel', 'Contact', 'Conversation', 'Message', 'StoredFile'].map((m) =>
        t.db.model(m).init(),
      ),
    );

    const start = await O().post(url('/channels/meta/login')).expect(200);
    const state = new URL(start.body.url as string).searchParams.get('state')!;
    const login = await O()
      .post(url('/channels/meta/login/finish'))
      .send({ code: 'CODE_OWNER', state })
      .expect(200);
    const pages = await O()
      .post(url('/channels/meta/pages'))
      .send({ sessionId: login.body.sessionId, pageId: PAGE.id, messenger: true, instagram: false })
      .expect(201);
    messengerId = pages.body.items[0].id as string;
    const wa = await O()
      .post(url('/channels/meta/whatsapp'))
      .send({ phoneNumberId: WA.phoneNumberId, wabaId: WA.wabaId, accessToken: WA.token })
      .expect(201);
    whatsappId = wa.body.id as string;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    graph.reset();
    ai.reset();
  });

  describe('saving', () => {
    it('copies a Messenger photo into private storage and serves it only through the inbox', async () => {
      const link = `${CDN}/rahim-saree.jpg?_nc_cat=1&oh=abc`;
      graph.cdn.set(link, { bytes: jpeg, contentType: 'image/jpeg' });
      const updated = vi.spyOn(t.app.get(InboxRealtime), 'messageUpdated');
      const externalId = mid();
      const { messageId, conversationId } = await receivePhoto(
        webhook.messengerPhotos(PAGE.id, '5551000000001', externalId, [link], 'eta ache?'),
        externalId,
      );
      // Stored at once, with the photo still on its way.
      expect(await message(conversationId, messageId)).toMatchObject({
        type: 'image',
        text: 'eta ache?',
        attachments: [{ status: 'pending', url: null, error: null }],
      });
      const raw = await t.db.collection('messages').findOne({ externalId });
      expect(raw?.attachments[0]).toMatchObject({ status: 'pending', source: link });
      expect(raw?.channelId.toHexString()).toBe(messengerId);

      expect(await fetchMedia(messageId)).toEqual({ status: 'done', saved: 1, failed: 0 });
      // CDN links need no token, and none is sent to them.
      expect(graph.downloads).toEqual([{ url: link, token: null }]);
      const path = url(`/conversations/${conversationId}/messages/${messageId}/attachments/0`);
      const shown = await message(conversationId, messageId);
      expect(shown.attachments).toEqual([
        expect.objectContaining({ status: 'ready', url: path, contentType: 'image/jpeg' }),
      ]);
      expect(updated).toHaveBeenCalledWith(
        orgId,
        undefined,
        expect.objectContaining({ id: messageId, attachments: shown.attachments }),
      );
      updated.mockRestore();

      // The saved copy: private, in the business's own folder, counted against its storage.
      const file = await t.db.collection('storedfiles').findOne({ 'usedBy.id': messageId });
      expect(file).toMatchObject({
        purpose: 'chat_media',
        visibility: 'private',
        status: 'ready',
        contentType: 'image/jpeg',
        size: jpeg.length,
      });
      expect(file!.key).toMatch(new RegExp(`^o/${orgId}/chat/[a-f0-9]{24}\\.jpg$`));
      const after = await t.db.collection('messages').findOne({ externalId });
      expect(after?.attachments[0].source).toBeUndefined();

      const res = await O().get(path).buffer(true).expect(200);
      expect(Buffer.compare(res.body as Buffer, jpeg)).toBe(0);
      expect(res.headers).toMatchObject({
        'content-type': 'image/jpeg',
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      // Not from the public storage route, and not by guessing.
      await t.http().get(`/v1/storage/${file!.key}`).expect(404);
      await O()
        .get(url(`/conversations/${conversationId}/messages/${messageId}/attachments/1`))
        .expect(404);
      await O()
        .get(url(`/conversations/${conversationId}/messages/${messageId}/attachments/x`))
        .expect(422);
    });

    it('shows a photo only to staff who can see its conversation', async () => {
      const link = `${CDN}/private.jpg?oh=1`;
      graph.cdn.set(link, { bytes: jpeg, contentType: 'image/jpeg' });
      const externalId = mid();
      const { messageId, conversationId } = await receivePhoto(
        webhook.messengerPhotos(PAGE.id, '5551000000002', externalId, [link]),
        externalId,
      );
      await fetchMedia(messageId);
      const path = (org = orgId) =>
        url(`/conversations/${conversationId}/messages/${messageId}/attachments/0`, org);

      // Another business: neither through its own org nor through this one.
      await t.as(rival.token).get(path(rivalOrgId)).expect(404);
      expect([403, 404]).toContain((await t.as(rival.token).get(path())).status);
      // A role without the inbox.
      await t.as(fulfillment.token).get(path()).expect(403);
      // A sales agent sees only conversations assigned to them.
      await t.as(agent.token).get(path()).expect(404);
      await O()
        .post(url(`/conversations/${conversationId}/assign`))
        .send({ assigneeId: agent.userId })
        .expect(200);
      await t.as(agent.token).get(path()).expect(200);
      // A message from another conversation cannot be read through this one.
      const other = await t.db.collection('conversations').findOne({
        orgId: new Types.ObjectId(orgId),
        _id: { $ne: new Types.ObjectId(conversationId) },
      });
      await O()
        .get(url(`/conversations/${other!._id.toHexString()}/messages/${messageId}/attachments/0`))
        .expect(404);
    });

    it('fetches WhatsApp media with the channel’s token and checks Meta’s checksum', async () => {
      const png = await photo(640, 480, 'png');
      graph.waMedia.set('WA_MEDIA_OK', { bytes: png, contentType: 'image/png', token: WA.token });
      const externalId = mid('wamid.PHOTO');
      const { messageId, conversationId } = await receivePhoto(
        webhook.whatsappPhoto(
          WA.phoneNumberId,
          '8801712345678',
          externalId,
          'WA_MEDIA_OK',
          'ei design ta',
        ),
        externalId,
      );
      expect(await fetchMedia(messageId)).toEqual({ status: 'done', saved: 1, failed: 0 });
      expect(graph.requests).toEqual([
        expect.objectContaining({ method: 'GET', path: 'WA_MEDIA_OK', token: WA.token }),
      ]);
      expect(graph.downloads).toEqual([{ url: whatsappMediaUrl('WA_MEDIA_OK'), token: WA.token }]);
      const shown = await message(conversationId, messageId);
      expect(shown).toMatchObject({
        text: 'ei design ta',
        attachments: [{ status: 'ready', contentType: 'image/png' }],
      });
      const conv = (
        await O()
          .get(url(`/conversations/${conversationId}`))
          .expect(200)
      ).body;
      expect(conv.channelId).toBe(whatsappId);

      // A download that does not match Meta's checksum is retried, then given up on.
      graph.waMedia.set('WA_MEDIA_BAD', {
        bytes: png,
        contentType: 'image/png',
        token: WA.token,
        sha256: '0'.repeat(64),
      });
      const badId = mid('wamid.PHOTO');
      const bad = await receivePhoto(
        webhook.whatsappPhoto(WA.phoneNumberId, '8801712345678', badId, 'WA_MEDIA_BAD'),
        badId,
      );
      await expect(fetchMedia(bad.messageId)).rejects.toThrow(/checksum/);
      expect((await message(bad.conversationId, bad.messageId)).attachments[0]).toMatchObject({
        status: 'pending',
      });
      expect(await fetchMedia(bad.messageId, true)).toEqual({
        status: 'done',
        saved: 0,
        failed: 1,
      });
      expect((await message(bad.conversationId, bad.messageId)).attachments[0]).toEqual(
        expect.objectContaining({
          status: 'failed',
          url: null,
          error: 'Not saved: the download from Meta kept failing.',
        }),
      );
      expect(
        await t.db.collection('storedfiles').countDocuments({ 'usedBy.id': bad.messageId }),
      ).toBe(0);
    });

    it('gives up at once, with a reason staff understand, when trying again cannot help', async () => {
      const ok = `${CDN}/ok.jpg`;
      const expired = `${CDN}/expired.jpg`;
      const huge = `${CDN}/huge.jpg`;
      const notPhoto = `${CDN}/page.jpg`;
      const away = `${CDN}/away.jpg`;
      graph.cdn.set(ok, { bytes: jpeg, contentType: 'image/jpeg' });
      graph.cdn.set(expired, { bytes: jpeg, contentType: 'image/jpeg', status: 403 });
      graph.cdn.set(huge, { bytes: Buffer.alloc(1_200_000, 1), contentType: 'image/jpeg' });
      graph.cdn.set(notPhoto, {
        bytes: Buffer.from('<html><script>alert(1)</script></html>'),
        contentType: 'image/jpeg',
      });
      graph.cdn.set(away, {
        bytes: jpeg,
        contentType: 'image/jpeg',
        redirect: 'https://attacker.example/grab',
      });
      const externalId = mid();
      const { messageId, conversationId } = await receivePhoto(
        webhook.messengerPhotos(PAGE.id, '5551000000003', externalId, [
          ok,
          expired,
          huge,
          notPhoto,
          away,
        ]),
        externalId,
      );
      expect(await fetchMedia(messageId)).toEqual({ status: 'done', saved: 1, failed: 4 });
      expect(
        (await message(conversationId, messageId)).attachments.map((a) => [a.status, a.error]),
      ).toEqual([
        ['ready', null],
        ['failed', 'Not saved: Meta no longer has this photo.'],
        ['failed', 'Not saved: larger than 1 MB.'],
        ['failed', 'Not saved: not a photo type Sellora can show.'],
        ['failed', 'Not saved: the link did not come from Meta.'],
      ]);
      // The redirect was never followed off Meta.
      expect(graph.downloads.map((d) => d.url)).not.toContain('https://attacker.example/grab');

      // WhatsApp media Meta no longer knows.
      const goneId = mid('wamid.PHOTO');
      const gone = await receivePhoto(
        webhook.whatsappPhoto(WA.phoneNumberId, '8801712345678', goneId, 'WA_MEDIA_DELETED'),
        goneId,
      );
      expect(await fetchMedia(gone.messageId)).toEqual({ status: 'done', saved: 0, failed: 1 });
      expect((await message(gone.conversationId, gone.messageId)).attachments[0]?.error).toBe(
        'Not saved: Meta no longer has this photo.',
      );
    });

    it('retries an outage without downloading saved photos again', async () => {
      const first = `${CDN}/first.jpg`;
      const flaky = `${CDN}/flaky.jpg`;
      graph.cdn.set(first, { bytes: jpeg, contentType: 'image/jpeg' });
      graph.cdn.set(flaky, { bytes: jpeg, contentType: 'image/jpeg', status: 503 });
      const externalId = mid();
      const { messageId, conversationId } = await receivePhoto(
        webhook.messengerPhotos(PAGE.id, '5551000000004', externalId, [first, flaky]),
        externalId,
      );
      await expect(fetchMedia(messageId)).rejects.toThrow(/503/);
      expect((await message(conversationId, messageId)).attachments.map((a) => a.status)).toEqual([
        'ready',
        'pending',
      ]);

      graph.reset();
      graph.cdn.set(flaky, { bytes: jpeg, contentType: 'image/jpeg' });
      expect(await fetchMedia(messageId)).toEqual({ status: 'done', saved: 1, failed: 0 });
      expect(graph.downloads.map((d) => d.url)).toEqual([flaky]);
      expect(await fetchMedia(messageId)).toEqual({ status: 'skipped', reason: 'nothing_pending' });
    });

    it('stops saving when the plan’s storage is full', async () => {
      const link = `${CDN}/full.jpg`;
      graph.cdn.set(link, { bytes: jpeg, contentType: 'image/jpeg' });
      await t
        .as(platform)
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ note: 'storage full test', limits: { storageMb: 0 } })
        .expect(200);
      try {
        const externalId = mid();
        const { messageId, conversationId } = await receivePhoto(
          webhook.messengerPhotos(PAGE.id, '5551000000005', externalId, [link]),
          externalId,
        );
        expect(await fetchMedia(messageId)).toEqual({ status: 'done', saved: 0, failed: 1 });
        expect((await message(conversationId, messageId)).attachments[0]?.error).toBe(
          'Not saved: the plan’s storage is full.',
        );
      } finally {
        await t
          .as(platform)
          .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
          .send({ note: 'storage full test done', limits: {} })
          .expect(200);
      }
    });
  });

  describe('the AI agent', () => {
    const replies = () => t.app.get(AiRepliesService);
    let tierModelId: string;

    const lastUserContent = () => {
      const msgs = ai.last().body.messages;
      return msgs.filter((m) => m.role === 'user').at(-1)!.content;
    };

    beforeAll(async () => {
      const view = await O().patch(url('/ai-agent')).send({ enabled: true, replyDelaySeconds: 0 });
      expect(view.status).toBe(200);
      const tier = view.body.settings.tier as string;
      const models = (await t.as(platform).get('/v1/platform/billing/ai-models').expect(200))
        .body as { id: string; tier: string; isDefaultForTier: boolean; imageInput: boolean }[];
      const model = models.find((m) => m.tier === tier && m.isDefaultForTier)!;
      expect(model.imageInput).toBe(true);
      tierModelId = model.id;
    });

    it('waits while the photo is saved, then looks at it', async () => {
      const link = `${CDN}/want-this.jpg`;
      graph.cdn.set(link, { bytes: jpeg, contentType: 'image/jpeg' });
      const externalId = mid();
      const { messageId, conversationId } = await receivePhoto(
        webhook.messengerPhotos(PAGE.id, '5551000000010', externalId, [link], 'eta ache?'),
        externalId,
      );
      const job = { orgId, conversationId, messageId };
      expect(await replies().handleJob(job, { finalAttempt: true })).toEqual({
        status: 'skipped',
        reason: 'waiting_for_media',
      });
      expect(ai.requests).toHaveLength(0);
      const again = await queue(QUEUES.ai).getJob(`reply-${messageId}-m1`);
      expect(again?.data).toMatchObject({ messageId, mediaWaits: 1 });
      expect(again?.opts.delay).toBe(2_000);
      await again!.remove();

      await fetchMedia(messageId);
      ai.then(FakeAnthropic.text('Ji, ei lal saree ta ache! Dam ৳2,500.'));
      expect(
        await replies().handleJob({ ...job, mediaWaits: 1 }, { finalAttempt: true }),
      ).toMatchObject({ status: 'replied' });
      const content = lastUserContent() as {
        type: string;
        text?: string;
        source?: { data: string };
      }[];
      expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
      expect(content[0]).toEqual({ type: 'text', text: 'Photo 1:' });
      expect(content[1]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg' },
      });
      expect(content[2]).toEqual({ type: 'text', text: '[The customer sent Photo 1] eta ache?' });
      // Scaled down before it was sent.
      const seen = await sharp(Buffer.from(content[1]!.source!.data, 'base64')).metadata();
      expect([seen.width, seen.height]).toEqual([1280, 960]);
      expect(ai.last().body.system).toMatch(/Look at it closely/);
      const last = (
        await O()
          .get(url(`/conversations/${conversationId}/messages`))
          .expect(200)
      ).body.items[0] as MessageDto;
      expect(last).toMatchObject({
        sender: { type: 'ai' },
        text: 'Ji, ei lal saree ta ache! Dam ৳2,500.',
      });
    });

    it('stops waiting after a while and answers without the photo', async () => {
      const link = `${CDN}/slow.jpg`;
      graph.cdn.set(link, { bytes: jpeg, contentType: 'image/jpeg', status: 503 });
      const externalId = mid();
      const { messageId, conversationId } = await receivePhoto(
        webhook.messengerPhotos(PAGE.id, '5551000000011', externalId, [link], 'dam koto?'),
        externalId,
      );
      ai.then(FakeAnthropic.text('Photo ta ekhono load hoyni, ektu bolben ki khujchen?'));
      expect(
        await replies().handleJob(
          { orgId, conversationId, messageId, mediaWaits: MAX_MEDIA_WAITS },
          { finalAttempt: true },
        ),
      ).toMatchObject({ status: 'replied' });
      expect(lastUserContent()).toBe('[The customer sent a photo] dam koto?');
    });

    it('describes photos to a model that cannot see them', async () => {
      const off = await t
        .as(platform)
        .patch(`/v1/platform/billing/ai-models/${tierModelId}`)
        .send({ imageInput: false })
        .expect(200);
      expect(off.body.imageInput).toBe(false);
      try {
        const link = `${CDN}/blind.jpg`;
        graph.cdn.set(link, { bytes: jpeg, contentType: 'image/jpeg' });
        const externalId = mid();
        const { messageId, conversationId } = await receivePhoto(
          webhook.messengerPhotos(PAGE.id, '5551000000012', externalId, [link], 'eta?'),
          externalId,
        );
        await fetchMedia(messageId);
        ai.then(FakeAnthropic.text('Ki dhoroner product khujchen, ektu likhe bolben?'));
        expect(
          await replies().handleJob({ orgId, conversationId, messageId }, { finalAttempt: true }),
        ).toMatchObject({ status: 'replied' });
        expect(lastUserContent()).toBe('[The customer sent a photo] eta?');
        expect(ai.last().body.system).toMatch(/describe what they are looking for/);
      } finally {
        await t
          .as(platform)
          .patch(`/v1/platform/billing/ai-models/${tierModelId}`)
          .send({ imageInput: true })
          .expect(200);
      }
    });
  });
});
