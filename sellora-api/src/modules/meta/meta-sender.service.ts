import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { RequestContext, type Actor } from '../../common/context/request-context.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { ChannelsService, type ChannelDoc } from '../inbox/channels.service.js';
import type { MessageDoc } from '../inbox/inbox.mappers.js';
import { MessagingService } from '../inbox/messaging.service.js';
import type { OutboxJob } from '../inbox/outbox.js';
import { replyWindowOpen } from '../inbox/reply-window.js';
import {
  ContactRepository,
  ConversationRepository,
  MessageRepository,
} from '../inbox/repositories.js';
import { MetaGraph, MetaGraphError } from './meta-graph.js';
import {
  CHANNEL_NAME,
  isMetaChannel,
  MAX_TEXT,
  splitText,
  type MetaChannelType,
} from './meta.types.js';

const ACTOR: Actor = { type: 'system', id: 'meta-outbox' };

/** How often a message waits for an earlier one in its conversation (2 s each) before going anyway. */
export const MAX_ORDER_WAITS = 60;
const PROGRESS_TTL_S = 24 * 3600;

export type SendOutcome =
  | { status: 'sent'; parts: number; externalId: string }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string }
  /** An earlier message in the conversation is still on its way; try again shortly. */
  | { status: 'wait' };

const WINDOW_TEXT =
  'Not delivered: more than 24 hours had passed since the customer’s last message, so Meta does not allow a reply.';

/**
 * Delivers queued messages on Messenger, Instagram and WhatsApp and records the outcome on
 * the message. Long texts go out in parts; a retry continues after the last part that went
 * out, so the customer never gets a part twice.
 */
@Injectable()
export class MetaSender {
  private readonly logger = new Logger(MetaSender.name);

  constructor(
    private readonly graph: MetaGraph,
    private readonly channels: ChannelsService,
    private readonly messaging: MessagingService,
    private readonly messages: MessageRepository,
    private readonly conversations: ConversationRepository,
    private readonly contacts: ContactRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  send(job: OutboxJob, opts: { finalAttempt: boolean }): Promise<SendOutcome> {
    return RequestContext.withTenant(job.orgId, () => this.deliver(job, opts), ACTOR);
  }

  private async deliver(job: OutboxJob, opts: { finalAttempt: boolean }): Promise<SendOutcome> {
    if (!Types.ObjectId.isValid(job.messageId)) return { status: 'skipped', reason: 'bad_id' };
    const message = await this.messages.findById(job.messageId);
    if (!message) return { status: 'skipped', reason: 'message_missing' };
    if (message.delivery.status !== 'pending') return { status: 'skipped', reason: 'not_pending' };

    // Keep the conversation's order: an earlier message still on its way goes first.
    const earlier = await this.messages.exists({
      conversationId: message.conversationId,
      _id: { $lt: message._id },
      direction: 'out',
      'delivery.status': 'pending',
    });
    if (earlier && (job.waits ?? 0) < MAX_ORDER_WAITS) return { status: 'wait' };

    try {
      return await this.attempt(message, opts);
    } catch (err) {
      // Unexpected trouble (a database blip): the queue tries again, then the message fails.
      if (!opts.finalAttempt) throw err;
      this.logger.error({ err, messageId: job.messageId }, 'Could not deliver a message');
      return this.fail(
        message,
        'Not delivered because of an error on our side. Try sending it again.',
      );
    }
  }

  private async attempt(
    message: MessageDoc,
    opts: { finalAttempt: boolean },
  ): Promise<SendOutcome> {
    const conv = await this.conversations.findById(message.conversationId);
    if (!conv) return this.fail(message, 'Not delivered: the conversation no longer exists.');
    const channel = await this.channels.find(message.channelId.toHexString());
    if (!channel?.meta || !isMetaChannel(channel.type))
      return this.fail(message, 'Not delivered: the channel was removed.');
    if (channel.status === 'disabled')
      return this.fail(message, 'Not delivered: the channel was turned off before it went out.');
    if (channel.status === 'error')
      return this.fail(
        message,
        'Not delivered: Meta stopped accepting messages from this channel. Reconnect it in Settings › Channels.',
      );
    if (!this.graph.configured())
      return this.fail(
        message,
        'Not delivered: Messenger, Instagram and WhatsApp are not set up on this platform.',
      );
    if (!replyWindowOpen(channel.type, conv.lastInboundAt)) return this.fail(message, WINDOW_TEXT);
    const contact = await this.contacts.findById(conv.contactId);
    if (!contact) return this.fail(message, 'Not delivered: the customer’s contact was removed.');

    const parts = splitText(message.text, MAX_TEXT[channel.type]);
    if (!parts.length) return this.fail(message, 'Not delivered: the message is empty.');

    let token: string;
    try {
      token = this.channels.metaToken(channel);
    } catch (err) {
      this.logger.error({ err, channelId: channel._id }, 'Stored Meta token cannot be decrypted');
      await this.needsReconnect(channel);
      return this.fail(
        message,
        'Not delivered: the channel’s access could not be read. Reconnect it.',
      );
    }

    const key = `outbox:sent:${message._id.toHexString()}`;
    const [doneRaw, firstSaved] = await this.redis.hmget(key, 'parts', 'first');
    let done = Number(doneRaw ?? 0);
    let first = firstSaved ?? undefined;
    try {
      for (; done < parts.length; done += 1) {
        const id = await this.sendPart(channel, token, contact.externalId, parts[done]!);
        first ??= id;
        await this.redis.hset(key, { parts: String(done + 1), first });
        await this.redis.expire(key, PROGRESS_TTL_S);
      }
    } catch (err) {
      if (!(err instanceof MetaGraphError)) throw err;
      return this.graphFailed(message, channel, err, opts.finalAttempt, done, parts.length);
    }
    // Forget the progress only once the result is saved: if saving fails, the retry finds
    // every part already sent and records it without messaging the customer again.
    await this.messaging.updateDelivery({ _id: message._id }, 'sent', {
      ...(first ? { externalId: first } : {}),
    });
    await this.redis.del(key);
    return { status: 'sent', parts: parts.length, externalId: first ?? '' };
  }

  /** Sends one text and returns Meta's message id. */
  private async sendPart(
    channel: ChannelDoc,
    token: string,
    to: string,
    text: string,
  ): Promise<string> {
    const type = channel.type as MetaChannelType;
    if (type === 'whatsapp') {
      const res = await this.graph.post<{ messages?: { id?: string }[] }>(
        `${channel.meta!.externalId}/messages`,
        token,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text, preview_url: false },
        },
      );
      const id = res.messages?.[0]?.id;
      if (!id) throw new MetaGraphError('transient', 'WhatsApp returned no message id');
      return id;
    }
    // Messenger and Instagram (through the linked page) share the Send API.
    const res = await this.graph.post<{ message_id?: string }>(
      `${channel.meta!.pageId ?? 'me'}/messages`,
      token,
      { recipient: { id: to }, messaging_type: 'RESPONSE', message: { text } },
    );
    if (!res.message_id)
      throw new MetaGraphError('transient', `${CHANNEL_NAME[type]} returned no message id`);
    return res.message_id;
  }

  private async graphFailed(
    message: MessageDoc,
    channel: ChannelDoc,
    err: MetaGraphError,
    finalAttempt: boolean,
    sentParts: number,
    totalParts: number,
  ): Promise<SendOutcome> {
    if (err.retryable && !finalAttempt) throw err;
    const partly =
      sentParts > 0 ? ` Only ${sentParts} of ${totalParts} parts reached the customer.` : '';
    let reason: string;
    switch (err.kind) {
      case 'auth':
        await this.needsReconnect(channel);
        reason =
          'Not delivered: Meta rejected the channel’s access (the token expired or a permission was removed). Reconnect it in Settings › Channels.';
        break;
      case 'outside_window':
        reason = WINDOW_TEXT;
        break;
      case 'not_configured':
        reason =
          'Not delivered: Messenger, Instagram and WhatsApp are not set up on this platform.';
        break;
      case 'rate_limited':
      case 'transient':
      case 'network':
        reason = 'Not delivered: Meta did not accept the message after several tries. Try again.';
        break;
      case 'bad_request':
        reason = `Not delivered: Meta refused the message (${err.message}).`;
        break;
    }
    this.logger.warn(
      { kind: err.kind, code: err.code, subcode: err.subcode, messageId: message._id },
      'Meta refused a message',
    );
    return this.fail(message, `${reason}${partly}`);
  }

  private async needsReconnect(channel: ChannelDoc): Promise<void> {
    await this.channels.markNeedsReconnect(
      channel._id,
      'Meta stopped accepting this connection (the token expired, the password changed or a permission was removed). Reconnect it.',
    );
  }

  private async fail(message: MessageDoc, reason: string): Promise<SendOutcome> {
    await this.messaging.updateDelivery({ _id: message._id }, 'failed', { error: reason });
    return { status: 'failed', reason };
  }
}
