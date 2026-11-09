import { getQueueToken } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { readFileSync } from 'node:fs';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { AiRepliesService } from '../../src/modules/ai/agent/ai-replies.service.js';
import { MAX_MEDIA_WAITS } from '../../src/modules/ai/agent/reply-queue.js';
import { AiProviderError } from '../../src/modules/ai/provider/ai-provider.js';
import {
  NOT_SET_UP,
  VoiceNotesService,
} from '../../src/modules/ai/voice-notes/voice-notes.service.js';
import { EntitlementsService } from '../../src/modules/billing/entitlements.service.js';
import { WalletService } from '../../src/modules/billing/wallet.service.js';
import { InboxRealtime } from '../../src/modules/inbox/inbox-realtime.service.js';
import type { TranscribeJob } from '../../src/modules/inbox/voice-note-queue.js';
import { MetaInbound } from '../../src/modules/meta/meta-inbound.service.js';
import { MetaMedia, type MediaJob } from '../../src/modules/meta/meta-media.js';
import type { MetaWebhookJob } from '../../src/modules/meta/meta-webhook.service.js';
import { FakeAnthropic } from '../helpers/fake-anthropic.js';
import { FakeGraph, signWebhook, webhook } from '../helpers/fake-meta.js';
import { FakeSpeech, withSpeech } from '../helpers/fake-speech.js';
import { TestApp, type Session } from '../helpers/test-app.js';

const APP_ID = '2468013580';
const APP_SECRET = 'meta-app-secret-for-voice-tests';
const PAGE = { id: '1100000000021', name: 'Dhaka Fashion', token: 'PAGE_TOKEN_voice_abcdefghij' };
const WA = {
  phoneNumberId: '2100000000021',
  wabaId: '3100000000021',
  token: 'WA_TOKEN_voice_abcdefghijklmn',
  displayPhone: '+880 1700-000021',
  verifiedName: 'Dhaka Fashion',
};
const CDN = 'https://cdn.fbsbx.com/v/t59.3654-21';
const SPEECH_KEY = 'sk-test-speech-key';
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url));

interface TranscriptDto {
  status: 'pending' | 'done' | 'failed' | 'skipped';
  text: string | null;
  error: string | null;
  credits: number | null;
}

interface AttachmentDto {
  kind: 'image' | 'audio' | 'file';
  url: string | null;
  contentType: string | null;
  status: 'pending' | 'ready' | 'failed';
  error: string | null;
  durationMs: number | null;
  transcript: TranscriptDto | null;
}

interface MessageDto {
  id: string;
  type: string;
  text: string;
  sender: { type: string };
  attachments: AttachmentDto[];
}

let seq = 0;
const mid = (prefix = 'wamid.VOICE') => `${prefix}_${Date.now().toString(36)}_${(seq += 1)}`;
const phone = () => `88017${String(10_000_000 + (seq += 1)).slice(-8)}`;

describe('Voice notes from WhatsApp and Messenger (ADR 0025)', () => {
  const graph = new FakeGraph(APP_SECRET);
  const ai = new FakeAnthropic();
  const speech = new FakeSpeech();
  let t: TestApp;
  let owner: Session;
  let fulfillment: Session;
  let rival: Session;
  let orgId: string;
  let rivalOrgId: string;
  let platform: string;
  const ogg = fixture('voice-4s.ogg');
  const m4a = fixture('voice-2s.m4a');

  const O = () => t.as(owner.token);
  const url = (path: string, org = orgId) => `/v1/orgs/${org}${path}`;
  const queue = <T>(name: string) => t.app.get<Queue<T>>(getQueueToken(name));
  const voiceNotes = () => t.app.get(VoiceNotesService);
  const replies = () => t.app.get(AiRepliesService);
  const inTenant = <T>(fn: () => Promise<T>) =>
    RequestContext.withTenant(orgId, fn, { type: 'system', id: 'test' });

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

  /** A WhatsApp voice note from a new customer, saved to storage (transcript waiting). */
  const voiceNote = async (bytes = ogg, opts: { fetch?: boolean } = {}) => {
    const mediaId = `WA_VOICE_${(seq += 1)}`;
    graph.waMedia.set(mediaId, { bytes, contentType: 'audio/ogg', token: WA.token });
    const externalId = mid();
    expect(
      await receive(webhook.whatsappVoice(WA.phoneNumberId, phone(), externalId, mediaId)),
    ).toEqual(['stored']);
    const stored = await t.db.collection('messages').findOne({ externalId });
    const ids = {
      messageId: stored!._id.toHexString(),
      conversationId: (stored!.conversationId as Types.ObjectId).toHexString(),
    };
    if (opts.fetch !== false)
      expect(await fetchMedia(ids.messageId)).toEqual({ status: 'done', saved: 1, failed: 0 });
    return ids;
  };

  const fetchMedia = async (messageId: string) => {
    const job = await queue<MediaJob>(QUEUES.media).getJob(`media-${messageId}`);
    expect(job, 'a media job was queued').toBeTruthy();
    const out = await t.app.get(MetaMedia).fetch(job!.data, { finalAttempt: false });
    await job!.remove();
    return out;
  };

  /** Runs a queued transcription the way the worker does, then removes the job. */
  const transcribe = async (
    messageId: string,
    opts: { run?: string; finalAttempt?: boolean } = {},
  ) => {
    let job: Job<TranscribeJob> | undefined;
    if (opts.run)
      job = await queue<TranscribeJob>(QUEUES.ai).getJob(`transcribe-${messageId}-0-${opts.run}`);
    else
      job = (await queue<TranscribeJob>(QUEUES.ai).getJobs(['waiting', 'delayed'])).find(
        (j) => j.name === 'transcribe' && j.data.messageId === messageId,
      );
    expect(job, 'a transcription job was queued').toBeTruthy();
    try {
      return await voiceNotes().transcribe(job!.data, { finalAttempt: opts.finalAttempt ?? true });
    } finally {
      if (opts.finalAttempt !== false) await job!.remove();
    }
  };

  const message = async (conversationId: string, messageId: string) => {
    const res = await O()
      .get(url(`/conversations/${conversationId}/messages`))
      .expect(200);
    return (res.body.items as MessageDto[]).find((m) => m.id === messageId)!;
  };
  const voiceOf = async (ids: { conversationId: string; messageId: string }) =>
    (await message(ids.conversationId, ids.messageId)).attachments[0]!;
  const wallet = async () =>
    (await O().get(url('/billing/wallet')).expect(200)).body as {
      availableMinor: number;
      heldMinor: number;
    };
  const usageFor = (messageId: string): Promise<Record<string, unknown>[]> =>
    t.db
      .collection('ai_usage')
      .find({ feature: 'voice_note_transcription', 'reference.id': messageId })
      .sort({ _id: 1 })
      .toArray();
  const retry = (ids: { conversationId: string; messageId: string }, as = owner, org = orgId) =>
    t
      .as(as.token)
      .post(
        url(
          `/conversations/${ids.conversationId}/messages/${ids.messageId}/attachments/0/transcribe`,
          org,
        ),
      );

  beforeAll(async () => {
    graph.codes.set('CODE_OWNER', 'USER_OWNER_TOKEN');
    graph.pagesByUser.set('USER_OWNER_TOKEN', [PAGE]);
    graph.whatsapp.push(WA);

    t = await TestApp.create(
      {
        META_APP_ID: APP_ID,
        META_APP_SECRET: APP_SECRET,
        META_WEBHOOK_VERIFY_TOKEN: 'verify-token-for-voice-tests',
        META_GRAPH_BASE_URL: 'http://graph.test',
        AI_ANTHROPIC_API_KEY: 'sk-ant-test-key',
        AI_OPENAI_API_KEY: SPEECH_KEY,
        AI_OPENAI_BASE_URL: 'http://speech.test/v1',
      },
      { metaFetch: graph.fetch, aiFetch: withSpeech(speech, ai.fetch) },
    );
    owner = await t.registerUser({ name: 'Owner Rahman' });
    orgId = (await t.createOrg(owner, { name: 'Dhaka Fashion' })).id;
    fulfillment = await t.addMember(owner, orgId, 'fulfillment');
    rival = await t.registerUser({ name: 'Rival Owner' });
    rivalOrgId = (await t.createOrg(rival, { name: 'Rival Shop' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Channel', 'Contact', 'Conversation', 'Message', 'StoredFile', 'AiUsage'].map((m) =>
        t.db.model(m).init(),
      ),
    );
    await O()
      .post(url('/products'))
      .send({ name: 'Jamdani Saree', variants: [{ priceMinor: 320_000, stock: 4 }] })
      .expect(201);

    const start = await O().post(url('/channels/meta/login')).expect(200);
    const state = new URL(start.body.url as string).searchParams.get('state')!;
    const login = await O()
      .post(url('/channels/meta/login/finish'))
      .send({ code: 'CODE_OWNER', state })
      .expect(200);
    await O()
      .post(url('/channels/meta/pages'))
      .send({ sessionId: login.body.sessionId, pageId: PAGE.id, messenger: true, instagram: false })
      .expect(201);
    await O()
      .post(url('/channels/meta/whatsapp'))
      .send({ phoneNumberId: WA.phoneNumberId, wabaId: WA.wabaId, accessToken: WA.token })
      .expect(201);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    graph.reset();
    ai.reset();
    speech.reset();
  });

  describe('saving and transcribing', () => {
    it('saves a WhatsApp voice note privately, measures it and turns it into text, charged by the second', async () => {
      const updated = vi.spyOn(t.app.get(InboxRealtime), 'messageUpdated');
      const ids = await voiceNote(ogg, { fetch: false });
      // Stored at once, the recording still on its way.
      expect(await message(ids.conversationId, ids.messageId)).toMatchObject({
        type: 'audio',
        text: '',
        attachments: [{ kind: 'audio', status: 'pending', url: null, transcript: null }],
      });
      expect(await fetchMedia(ids.messageId)).toEqual({ status: 'done', saved: 1, failed: 0 });

      const path = url(
        `/conversations/${ids.conversationId}/messages/${ids.messageId}/attachments/0`,
      );
      expect(await voiceOf(ids)).toEqual({
        kind: 'audio',
        url: path,
        contentType: 'audio/ogg',
        name: null,
        size: ogg.length,
        status: 'ready',
        error: null,
        durationMs: 4_200,
        transcript: { status: 'pending', text: null, error: null, credits: null },
      });
      // The saved copy is private, kept with the message and served only through the inbox.
      const raw = await t.db
        .collection('messages')
        .findOne({ _id: new Types.ObjectId(ids.messageId) });
      const file = await t.db
        .collection('storedfiles')
        .findOne({ _id: raw!.attachments[0].fileId });
      expect(file).toMatchObject({
        purpose: 'chat_media',
        visibility: 'private',
        contentType: 'audio/ogg',
      });
      expect(file!.key).toMatch(/\/chat\/[a-f0-9]{24}\.ogg$/);
      const bytes = (range?: string) => {
        const req = O().get(path);
        if (range) void req.set('Range', range);
        return req.buffer(true).parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      };
      const played = await bytes().expect(200);
      expect(played.headers['content-type']).toBe('audio/ogg');
      expect(played.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.compare(played.body as Buffer, ogg)).toBe(0);
      // Players read the end of an Ogg file to show its length, and seek by range.
      const end = await bytes('bytes=-1000').expect(206);
      expect(end.headers['content-range']).toBe(
        `bytes ${ogg.length - 1000}-${ogg.length - 1}/${ogg.length}`,
      );
      expect(Buffer.compare(end.body as Buffer, ogg.subarray(ogg.length - 1000))).toBe(0);
      const part = await bytes('bytes=10-19').expect(206);
      expect(part.headers['content-length']).toBe('10');
      expect(Buffer.compare(part.body as Buffer, ogg.subarray(10, 20))).toBe(0);
      await bytes(`bytes=${ogg.length}-`)
        .expect(416)
        .expect('Content-Range', `bytes */${ogg.length}`);
      await t.http().get(path).expect(401);

      const before = await wallet();
      speech.then(
        FakeSpeech.text('  Apu, lal jamdani saree ta ki ache?  ', { language: 'bengali' }),
      );
      expect(await transcribe(ids.messageId, { run: 'auto' })).toEqual({
        status: 'done',
        credits: 1.05,
        chars: 34,
      });
      // The catalogue's model, the server's key, the real recording, the business's words.
      expect(speech.requests).toEqual([
        {
          url: 'http://speech.test/v1/audio/transcriptions',
          authorization: `Bearer ${SPEECH_KEY}`,
          model: 'gpt-4o-mini-transcribe',
          language: null,
          prompt: 'Dhaka Fashion, Jamdani Saree',
          responseFormat: 'json',
          fileName: 'voice-note.ogg',
          fileType: 'audio/ogg',
          size: ogg.length,
        },
      ]);
      expect((await voiceOf(ids)).transcript).toEqual({
        status: 'done',
        text: 'Apu, lal jamdani saree ta ki ache?',
        error: null,
        credits: 1.05,
      });
      // The inbox hears about the words as soon as they are saved.
      const [toOrg, , dto] = updated.mock.calls.at(-1)!;
      expect(toOrg).toBe(orgId);
      expect(dto).toMatchObject({
        id: ids.messageId,
        attachments: [
          { transcript: { status: 'done', text: 'Apu, lal jamdani saree ta ki ache?' } },
        ],
      });
      updated.mockRestore();

      // 4.2 s at 15 credits a minute = 1.05 credits = ৳0.105, rounded up to 11 paisa.
      const [usage] = await usageFor(ids.messageId);
      expect(usage).toMatchObject({
        status: 'settled',
        audioMs: 4_200,
        credits: 1.05,
        billedMinor: 11,
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
        costUsdMicros: 210,
        reference: { type: 'message', id: ids.messageId },
        requestId: `vn-${ids.messageId}-0-1`,
      });
      expect(usage!.tier).toBeUndefined();
      expect(await wallet()).toEqual(
        expect.objectContaining({ availableMinor: before.availableMinor - 11, heldMinor: 0 }),
      );
      // The business sees credits and seconds, never the provider, model or cost.
      const list = await O()
        .get(url('/billing/ai-usage/requests?feature=voice_note_transcription'))
        .expect(200);
      const row = (list.body.items as Record<string, unknown>[]).find(
        (u) => (u.reference as { id: string } | null)?.id === ids.messageId,
      );
      expect(row).toMatchObject({
        feature: 'voice_note_transcription',
        tier: null,
        audioSeconds: 4.2,
        credits: 1.05,
      });
      expect(JSON.stringify(row)).not.toMatch(/openai|transcribe|cost/i);
    });

    it('saves a Messenger voice clip (MP4) and shows it as a voice note in the chat list', async () => {
      const link = `${CDN}/audioclip-1.mp4?_nc_cat=1&oh=abc`;
      graph.cdn.set(link, { bytes: m4a, contentType: 'audio/mp4' });
      const externalId = mid('m_voice');
      expect(
        await receive(webhook.messengerAudio(PAGE.id, '5552000000001', externalId, link)),
      ).toEqual(['stored']);
      const stored = await t.db.collection('messages').findOne({ externalId });
      const ids = {
        messageId: stored!._id.toHexString(),
        conversationId: (stored!.conversationId as Types.ObjectId).toHexString(),
      };
      expect(await fetchMedia(ids.messageId)).toMatchObject({ saved: 1 });
      const voice = await voiceOf(ids);
      expect(voice).toMatchObject({ kind: 'audio', status: 'ready', contentType: 'audio/mp4' });
      expect(voice.durationMs).toBeGreaterThan(2_400);
      expect(voice.durationMs).toBeLessThan(2_600);
      const conv = await O()
        .get(url(`/conversations/${ids.conversationId}`))
        .expect(200);
      expect(conv.body.lastMessage.text).toBe('Voice note');
      speech.then(FakeSpeech.text('size M ache?'));
      expect(await transcribe(ids.messageId, { run: 'auto' })).toMatchObject({ status: 'done' });
      expect(speech.requests[0]).toMatchObject({
        fileName: 'voice-note.m4a',
        fileType: 'audio/mp4',
      });
    });
  });

  describe('the AI agent', () => {
    beforeAll(async () => {
      await O().patch(url('/ai-agent')).send({ enabled: true, replyDelaySeconds: 0 }).expect(200);
    });

    const lastUserText = () => {
      const msgs = ai.last().body.messages;
      return msgs.filter((m) => m.role === 'user').at(-1)!.content;
    };

    it('waits for the words, then answers them like typed text', async () => {
      const ids = await voiceNote();
      const job = { orgId, conversationId: ids.conversationId, messageId: ids.messageId };
      expect(await replies().handleJob(job, { finalAttempt: true })).toEqual({
        status: 'skipped',
        reason: 'waiting_for_media',
      });
      expect(ai.requests).toHaveLength(0);
      await (await queue(QUEUES.ai).getJob(`reply-${ids.messageId}-m1`))?.remove();

      speech.then(FakeSpeech.text('Dhaka te delivery charge koto?'));
      await transcribe(ids.messageId, { run: 'auto' });
      ai.then(FakeAnthropic.text('Dhaka-r bhitore delivery charge ৳60.'));
      expect(
        await replies().handleJob({ ...job, mediaWaits: 1 }, { finalAttempt: true }),
      ).toMatchObject({
        status: 'replied',
      });
      expect(lastUserText()).toBe(
        '[The customer sent a voice note (0:04). Speech-to-text heard: "Dhaka te delivery charge koto?"]',
      );
      expect(ai.last().body.system).toMatch(
        /Speech-to-text can mishear names, numbers and addresses/,
      );
    });

    it('answers with what it has when the words take too long', async () => {
      const ids = await voiceNote();
      ai.then(FakeAnthropic.text('Dukkhito, voice note ta shunte parchi na. Ektu likhe bolben?'));
      expect(
        await replies().handleJob(
          {
            orgId,
            conversationId: ids.conversationId,
            messageId: ids.messageId,
            mediaWaits: MAX_MEDIA_WAITS,
          },
          { finalAttempt: true },
        ),
      ).toMatchObject({ status: 'replied' });
      expect(lastUserText()).toBe(
        '[The customer sent a voice note (0:04) that is still being turned into text]',
      );
    });

    it('hands over when a handover keyword is spoken', async () => {
      await O()
        .patch(url('/ai-agent'))
        .send({ handoverKeywords: ['manager'] })
        .expect(200);
      try {
        const ids = await voiceNote();
        speech.then(FakeSpeech.text('Ami manager er sathe kotha bolte chai'));
        await transcribe(ids.messageId, { run: 'auto' });
        expect(
          await replies().handleJob(
            { orgId, conversationId: ids.conversationId, messageId: ids.messageId },
            { finalAttempt: true },
          ),
        ).toEqual({ status: 'handed_over', reason: 'keyword' });
        expect(ai.requests).toHaveLength(0);
      } finally {
        await O().patch(url('/ai-agent')).send({ handoverKeywords: [] }).expect(200);
      }
    });
  });

  describe('failures and retries', () => {
    it('retries an outage, then shows why, releases the hold and lets a person try again', async () => {
      const ids = await voiceNote();
      speech.then(FakeSpeech.error(503), FakeSpeech.error(503));
      const err = await transcribe(ids.messageId, { run: 'auto', finalAttempt: false }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AiProviderError);
      expect((await voiceOf(ids)).transcript?.status).toBe('pending');
      expect(await transcribe(ids.messageId, { run: 'auto' })).toEqual({
        status: 'failed',
        reason: 'Voice-to-text kept failing. Try again in a few minutes.',
      });
      expect((await voiceOf(ids)).transcript).toMatchObject({
        status: 'failed',
        error: 'Voice-to-text kept failing. Try again in a few minutes.',
      });
      // Each run held credits under its own id, and gave them all back.
      const runs = await usageFor(ids.messageId);
      expect(runs.map((u) => [u.requestId, u.status])).toEqual([
        [`vn-${ids.messageId}-0-1`, 'released'],
        [`vn-${ids.messageId}-0-2`, 'released'],
      ]);
      expect((await wallet()).heldMinor).toBe(0);

      const again = await retry(ids).expect(200);
      expect(
        (again.body as { message: MessageDto }).message.attachments[0]!.transcript?.status,
      ).toBe('pending');
      await retry(ids).expect(409);
      speech.then(FakeSpeech.text('ekhon shunte parchen?'));
      expect(await transcribe(ids.messageId)).toMatchObject({ status: 'done' });
      expect((await usageFor(ids.messageId)).map((u) => u.status)).toEqual([
        'released',
        'released',
        'settled',
      ]);
      const body = (await retry(ids).expect(409)).body as { code: string };
      expect(body.code).toBe('transcript_not_retryable');
    });

    it('does not retry a recording the service cannot read', async () => {
      const ids = await voiceNote();
      speech.then(FakeSpeech.error(400, 'Invalid file format'));
      expect(await transcribe(ids.messageId, { run: 'auto', finalAttempt: false })).toEqual({
        status: 'failed',
        reason: 'The voice-to-text service could not read this recording.',
      });
      await (await queue(QUEUES.ai).getJob(`transcribe-${ids.messageId}-0-auto`))?.remove();
      expect(speech.requests).toHaveLength(1);
    });

    it('marks a recording Meta no longer has as not saved, without transcribing', async () => {
      const externalId = mid();
      expect(
        await receive(
          webhook.whatsappVoice(WA.phoneNumberId, phone(), externalId, 'WA_VOICE_GONE'),
        ),
      ).toEqual(['stored']);
      const stored = await t.db.collection('messages').findOne({ externalId });
      const messageId = stored!._id.toHexString();
      expect(await fetchMedia(messageId)).toEqual({ status: 'done', saved: 0, failed: 1 });
      const voice = await voiceOf({
        messageId,
        conversationId: (stored!.conversationId as Types.ObjectId).toHexString(),
      });
      expect(voice).toMatchObject({
        status: 'failed',
        error: 'Not saved: Meta no longer has this voice note.',
        transcript: null,
      });
      expect(
        (await queue<TranscribeJob>(QUEUES.ai).getJobs(['waiting'])).some(
          (j) => j.name === 'transcribe' && j.data.messageId === messageId,
        ),
      ).toBe(false);
    });
  });

  describe('when a voice note is not turned into text', () => {
    const expectSkipped = async (
      ids: { conversationId: string; messageId: string },
      reason: string,
    ) => {
      expect(await transcribe(ids.messageId, { run: 'auto' })).toEqual({
        status: 'skipped',
        reason,
      });
      expect((await voiceOf(ids)).transcript).toEqual({
        status: 'skipped',
        text: null,
        error: reason,
        credits: null,
      });
      expect(speech.requests).toHaveLength(0);
      expect(await usageFor(ids.messageId)).toHaveLength(0);
    };

    it('respects the business turning it off, and transcribes on retry once it is back on', async () => {
      const view = await O()
        .patch(url('/ai-agent'))
        .send({ transcribeVoiceNotes: false })
        .expect(200);
      expect(view.body.settings.transcribeVoiceNotes).toBe(false);
      const ids = await voiceNote();
      await expectSkipped(ids, 'Turning voice notes into text is off in the AI agent settings.');
      await O().patch(url('/ai-agent')).send({ transcribeVoiceNotes: true }).expect(200);
      await retry(ids).expect(200);
      speech.then(FakeSpeech.text('abar try korlam'));
      expect(await transcribe(ids.messageId)).toMatchObject({ status: 'done' });
    });

    it('needs a plan with the AI sales agent', async () => {
      const spy = vi
        .spyOn(t.app.get(EntitlementsService), 'hasModule')
        .mockResolvedValueOnce(false);
      try {
        await expectSkipped(
          await voiceNote(),
          'Voice notes are turned into text on plans with the AI sales agent.',
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('needs credits', async () => {
      const ids = await voiceNote();
      const walletService = t.app.get(WalletService);
      const { availableMinor } = await wallet();
      await inTenant(() => walletService.hold(availableMinor));
      try {
        await expectSkipped(ids, 'Not turned into text: the AI credit balance is used up.');
      } finally {
        await inTenant(() => walletService.release(availableMinor));
      }
    });

    it('needs a speech-to-text model in the catalogue', async () => {
      const models = (await t.as(platform).get('/v1/platform/billing/ai-models').expect(200))
        .body as {
        id: string;
        purpose: string;
      }[];
      const stt = models.find((m) => m.purpose === 'transcription')!;
      const ready = (await O().get(url('/ai-agent')).expect(200)).body.status.voiceNotes;
      expect(ready).toEqual({
        available: true,
        perMinute: { credits: 15, amountMinor: expect.any(Number), currency: 'BDT' },
        maxSeconds: 300,
      });
      await t
        .as(platform)
        .patch(`/v1/platform/billing/ai-models/${stt.id}`)
        .send({ enabled: false })
        .expect(200);
      try {
        const off = (await O().get(url('/ai-agent')).expect(200)).body.status.voiceNotes;
        expect(off.available).toBe(false);
        await expectSkipped(await voiceNote(), NOT_SET_UP);
      } finally {
        await t
          .as(platform)
          .patch(`/v1/platform/billing/ai-models/${stt.id}`)
          .send({ enabled: true })
          .expect(200);
      }
    });

    it('needs a voice note price in the credit price list', async () => {
      const rates = (await t.as(platform).get('/v1/platform/billing/credit-rates').expect(200))
        .body as {
        currency: string;
        version: number;
        creditPriceMinor: number;
        tiers: unknown[];
        minimumCreditsPerRequest: number;
        transcriptionCreditsPerMinute: number | null;
        usdRate: number;
      }[];
      const current = rates.find((r) => r.currency === 'BDT')!;
      expect(current.transcriptionCreditsPerMinute).toBe(15);
      const publish = (extra: Record<string, unknown>) =>
        t
          .as(platform)
          .post('/v1/platform/billing/credit-rates')
          .send({
            currency: 'BDT',
            creditPriceMinor: current.creditPriceMinor,
            tiers: current.tiers,
            minimumCreditsPerRequest: current.minimumCreditsPerRequest,
            usdRate: current.usdRate,
            ...extra,
          })
          .expect(201);
      await publish({ note: 'no voice price' });
      try {
        const view = (await O().get(url('/ai-agent')).expect(200)).body.status.voiceNotes;
        expect(view).toMatchObject({ available: false, perMinute: null });
        await expectSkipped(await voiceNote(), NOT_SET_UP);
      } finally {
        const back = await publish({ transcriptionCreditsPerMinute: 15, note: 'voice price back' });
        expect(back.body.transcriptionCreditsPerMinute).toBe(15);
      }
    });

    it('keeps recordings longer than the limit as audio only', async () => {
      const ids = await voiceNote();
      await t.db
        .collection('messages')
        .updateOne(
          { _id: new Types.ObjectId(ids.messageId) },
          { $set: { 'attachments.0.durationMs': 301_000 } },
        );
      await expectSkipped(ids, 'Longer than 5:00, so it was not turned into text.');
    });
  });

  describe('access', () => {
    it('lets only staff who can reply retry, and never across businesses', async () => {
      const ids = await voiceNote();
      speech.then(FakeSpeech.error(400));
      await transcribe(ids.messageId, { run: 'auto' });
      await retry(ids, fulfillment).expect(403);
      await retry(ids, rival, rivalOrgId).expect(404);
      await t
        .as(rival.token)
        .get(
          url(
            `/conversations/${ids.conversationId}/messages/${ids.messageId}/attachments/0`,
            rivalOrgId,
          ),
        )
        .expect(404);
      await retry(ids).expect(200);
      await (
        await queue<TranscribeJob>(QUEUES.ai).getJobs(['waiting'])
      )
        .find((j) => j.name === 'transcribe' && j.data.messageId === ids.messageId)
        ?.remove();
    });

    it('only retries voice notes', async () => {
      const externalId = mid('wamid.TEXT');
      await receive(webhook.whatsapp(WA.phoneNumberId, phone(), externalId, 'hello'));
      const stored = await t.db.collection('messages').findOne({ externalId });
      await retry({
        messageId: stored!._id.toHexString(),
        conversationId: (stored!.conversationId as Types.ObjectId).toHexString(),
      }).expect(404);
    });
  });

  describe('the model catalogue', () => {
    it('lists the speech-to-text model with its price per minute, apart from chat tiers', async () => {
      const models = (await t.as(platform).get('/v1/platform/billing/ai-models').expect(200))
        .body as {
        id: string;
        purpose: string;
        tier: string;
        isDefaultForTier: boolean;
        audioUsdPerMinute: number | null;
      }[];
      expect(models.find((m) => m.purpose === 'transcription')).toMatchObject({
        audioUsdPerMinute: 0.003,
        isDefaultForTier: true,
      });
      const chatDefaults = models.filter((m) => m.purpose === 'chat' && m.isDefaultForTier);
      expect(chatDefaults.map((m) => m.tier).sort()).toEqual(['advanced', 'fast', 'standard']);

      await t
        .as(platform)
        .post('/v1/platform/billing/ai-models')
        .send({
          provider: 'openai',
          model: 'speech-without-price',
          label: 'No price',
          purpose: 'transcription',
          tier: 'fast',
          inputUsdPerMTok: 0,
          outputUsdPerMTok: 0,
        })
        .expect(422);
      // A second speech-to-text default takes over from the first, never from a chat tier.
      const added = await t
        .as(platform)
        .post('/v1/platform/billing/ai-models')
        .send({
          provider: 'other',
          model: 'whisper-large-v3',
          label: 'Whisper (self-hosted)',
          purpose: 'transcription',
          tier: 'fast',
          inputUsdPerMTok: 0,
          outputUsdPerMTok: 0,
          audioUsdPerMinute: 0.001,
          isDefaultForTier: true,
        })
        .expect(201);
      const after = (await t.as(platform).get('/v1/platform/billing/ai-models').expect(200))
        .body as typeof models;
      expect(
        after.filter((m) => m.purpose === 'transcription' && m.isDefaultForTier).map((m) => m.id),
      ).toEqual([added.body.id]);
      expect(after.filter((m) => m.purpose === 'chat' && m.isDefaultForTier)).toHaveLength(3);

      // That provider has no adapter here, so voice notes say so rather than fail later.
      try {
        const ids = await voiceNote();
        expect(await transcribe(ids.messageId, { run: 'auto' })).toEqual({
          status: 'skipped',
          reason: NOT_SET_UP,
        });
      } finally {
        await t
          .as(platform)
          .patch(`/v1/platform/billing/ai-models/${added.body.id as string}`)
          .send({ enabled: false, isDefaultForTier: false })
          .expect(200);
      }
    });
  });
});
