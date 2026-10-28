import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { zonedParts } from '../../common/time/zoned.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import type { ChannelDoc } from './channels.service.js';
import { InboxRealtime } from './inbox-realtime.service.js';
import {
  CUSTOMER_VISIBLE_TYPES,
  preview,
  toConversationDto,
  toMessageDto,
  toVisitorMessageDto,
  type ContactDoc,
  type ConversationDoc,
  type ConversationDto,
  type MessageDoc,
} from './inbox.mappers.js';
import { OutboxQueue } from './outbox.js';
import { replyWindowOpen, sendsThroughMeta } from './reply-window.js';
import { ContactRepository, ConversationRepository, MessageRepository } from './repositories.js';
import type {
  ConversationAi,
  DeliveryStatus,
  Message,
  MessageAttachment,
  MessageType,
  SenderType,
} from './schemas.js';

/** Emitted after a customer message is stored. The AI agent listens for it. */
export const INBOX_MESSAGE_RECEIVED = 'inbox.message.received';

/** Emitted when a person turns the AI back on in a conversation. */
export const INBOX_AI_RESUMED = 'inbox.ai.resumed';

export interface InboxAiResumedEvent {
  orgId: string;
  conversationId: string;
}

export interface InboxMessageReceivedEvent {
  orgId: string;
  channelId: string;
  conversationId: string;
  messageId: string;
  /** False when the thread is locked by the monthly limit: nobody may act on it. */
  actionable: boolean;
}

export interface InboundContact {
  /** The channel's id for the person. */
  externalId: string;
  name?: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
}

export interface InboundMessage {
  externalId?: string;
  clientId?: string;
  type: Extract<MessageType, 'text' | 'image' | 'file'>;
  text: string;
  attachments?: MessageAttachment[];
}

export interface InboundResult {
  contact: ContactDoc;
  conversation: ConversationDoc;
  message: MessageDoc;
  /** The channel delivered this message before; nothing was changed. */
  duplicate: boolean;
}

export interface OutgoingInput {
  type: MessageType;
  text: string;
  sender: { type: SenderType; id?: string; name?: string };
  clientId?: string;
  attachments?: MessageAttachment[];
  ai?: Message['ai'];
}

/** Statuses a message may move to a given status from; delivery never goes backwards. */
const DELIVERY_FROM: Record<Exclude<DeliveryStatus, 'pending'>, DeliveryStatus[]> = {
  sent: ['pending'],
  delivered: ['pending', 'sent'],
  read: ['pending', 'sent', 'delivered'],
  failed: ['pending', 'sent'],
};

/** 'YYYY-MM' of `at` in the business's time zone. */
export function monthKey(at: Date, timeZone: string): string {
  const { year, month } = zonedParts(at, timeZone);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Stores messages in both directions and keeps conversations, the monthly conversation
 * count and live clients in step. Channel adapters (web chat, Messenger, WhatsApp) and
 * the AI agent all go through here, so these rules hold for every channel.
 *
 * Callers run inside a tenant scope (a request, or RequestContext.withTenant in jobs and
 * webhooks).
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly contacts: ContactRepository,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly orgs: OrgsService,
    private readonly entitlements: EntitlementsService,
    private readonly realtime: InboxRealtime,
    private readonly events: EventEmitter2,
    private readonly outbox: OutboxQueue,
  ) {}

  orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  async currentMonth(now = new Date()): Promise<string> {
    const org = await this.orgs.get(this.orgId());
    return monthKey(now, org.timezone);
  }

  async conversationDto(
    conversation: ConversationDoc,
    contact?: ContactDoc | null,
    month?: string,
  ): Promise<ConversationDto> {
    const who =
      contact === undefined ? await this.contacts.findById(conversation.contactId) : contact;
    return toConversationDto(conversation, who, month ?? (await this.currentMonth()));
  }

  async publishConversation(
    conversation: ConversationDoc,
    opts: { contact?: ContactDoc | null; previousAssignee?: Types.ObjectId | null } = {},
  ): Promise<ConversationDto> {
    const dto = await this.conversationDto(conversation, opts.contact);
    await this.realtime.conversationUpdated(this.orgId(), dto, opts.previousAssignee);
    return dto;
  }

  // ------------------------------------------------------------ monthly limit

  /**
   * Counts the conversation in this month's usage the first time the customer writes in
   * the month. Past the plan's conversationsPerMonth the thread is locked instead: the
   * message is kept, but staff cannot read it and the AI does not answer until the plan
   * has room (an upgrade, or next month).
   */
  private async countForMonth(conv: ConversationDoc, month: string): Promise<ConversationDoc> {
    if (conv.activeMonth === month) return conv;
    const allowed = await this.monthHasRoom(month);
    const updated = await this.conversations.findOneAndUpdate(
      { _id: conv._id },
      allowed
        ? { $set: { activeMonth: month }, $unset: { limitedMonth: 1 } }
        : { $set: { limitedMonth: month } },
    );
    return updated ?? conv;
  }

  private async monthHasRoom(month: string): Promise<boolean> {
    const limit = (await this.entitlements.forOrg(this.orgId())).limits.conversationsPerMonth;
    if (limit === null) return true;
    return (await this.conversations.count({ activeMonth: month })) < limit;
  }

  /**
   * Throws 402 when the conversation is locked by the monthly limit. If the plan has room
   * again (it was upgraded), the conversation is unlocked and counted instead.
   */
  async ensureUnlocked(conv: ConversationDoc, month?: string): Promise<ConversationDoc> {
    const current = month ?? (await this.currentMonth());
    if (conv.limitedMonth !== current) return conv;
    if (await this.monthHasRoom(current)) {
      const updated = await this.conversations.findOneAndUpdate(
        { _id: conv._id, limitedMonth: current },
        { $set: { activeMonth: current }, $unset: { limitedMonth: 1 } },
      );
      return updated ?? conv;
    }
    const ent = await this.entitlements.forOrg(this.orgId());
    throw AppError.paymentRequired(
      'plan_limit_reached',
      'This month’s conversation limit is used up. Upgrade your plan to open this conversation.',
      {
        limit: 'conversationsPerMonth',
        max: ent.limits.conversationsPerMonth,
        current: await this.conversations.count({ activeMonth: current }),
        planCode: ent.planCode,
      },
    );
  }

  // ------------------------------------------------------------------ inbound

  private async upsertContact(
    channel: ChannelDoc,
    c: InboundContact,
    now: Date,
  ): Promise<ContactDoc> {
    const filter = { channelId: channel._id, externalId: c.externalId };
    const set: Record<string, unknown> = { lastSeenAt: now };
    if (c.avatarUrl) set.avatarUrl = c.avatarUrl;
    const onInsert: Record<string, unknown> = { name: c.name?.trim() ?? '' };
    if (c.phone) onInsert.phone = c.phone;
    if (c.email) onInsert.email = c.email;
    let contact: ContactDoc | null;
    try {
      contact = await this.contacts.findOneAndUpdate(
        filter,
        { $set: set, $setOnInsert: onInsert },
        { upsert: true },
      );
    } catch (err) {
      // Two first messages at once: the other insert won.
      if (!isDuplicateKey(err)) throw err;
      contact = await this.contacts.findOneAndUpdate(filter, { $set: set });
    }
    if (!contact) throw new Error('contact upsert returned nothing');
    if (c.name?.trim() && !contact.name) {
      contact =
        (await this.contacts.findOneAndUpdate(
          { _id: contact._id },
          { $set: { name: c.name.trim() } },
        )) ?? contact;
    }
    return contact;
  }

  private async upsertConversation(
    channel: ChannelDoc,
    contact: ContactDoc,
    now: Date,
  ): Promise<ConversationDoc> {
    const filter = { contactId: contact._id };
    const update = {
      $setOnInsert: {
        channelId: channel._id,
        channelType: channel.type,
        status: 'open',
        ai: { mode: 'auto' },
        unread: 0,
        tags: [],
        lastMessageAt: now,
      },
    };
    try {
      const conv = await this.conversations.findOneAndUpdate(filter, update, { upsert: true });
      if (conv) return conv;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const existing = await this.conversations.findOne(filter);
    if (!existing) throw new Error('conversation upsert returned nothing');
    return existing;
  }

  /** Stores a customer's message. Safe to call again with the same externalId or clientId. */
  async receiveInbound(
    channel: ChannelDoc,
    from: InboundContact,
    input: InboundMessage,
    now = new Date(),
  ): Promise<InboundResult> {
    const contact = await this.upsertContact(channel, from, now);
    let conv = await this.upsertConversation(channel, contact, now);

    let message: MessageDoc;
    try {
      message = await this.messages.create({
        conversationId: conv._id,
        channelId: channel._id,
        direction: 'in',
        type: input.type,
        sender: { type: 'contact', id: contact._id.toHexString(), name: contact.name },
        text: input.text,
        attachments: input.attachments ?? [],
        ...(input.externalId ? { externalId: input.externalId } : {}),
        ...(input.clientId ? { clientId: input.clientId } : {}),
        delivery: { status: 'delivered', at: now },
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await this.messages.findOne(
        input.externalId
          ? { channelId: channel._id, externalId: input.externalId }
          : { conversationId: conv._id, clientId: input.clientId },
      );
      if (!existing) throw err;
      return { contact, conversation: conv, message: existing, duplicate: true };
    }

    const month = await this.currentMonth(now);
    conv = await this.countForMonth(conv, month);
    conv =
      (await this.conversations.findOneAndUpdate(
        { _id: conv._id },
        {
          $set: {
            status: 'open',
            lastMessage: {
              text: preview(input.text, input.type),
              at: now,
              direction: 'in',
              senderType: 'contact',
            },
            lastMessageAt: now,
            lastInboundAt: now,
          },
          $inc: { unread: 1 },
        },
      )) ?? conv;

    const orgId = this.orgId();
    const locked = conv.limitedMonth === month;
    const dto = toConversationDto(conv, contact, month);
    await this.realtime.conversationUpdated(orgId, dto);
    if (!locked) await this.realtime.messageCreated(orgId, conv.assigneeId, toMessageDto(message));
    if (channel.type === 'web_chat') {
      const org = await this.orgs.get(orgId);
      await this.realtime.toVisitor(
        channel._id,
        contact.externalId,
        toVisitorMessageDto(message, org.name),
      );
    }
    const event: InboxMessageReceivedEvent = {
      orgId,
      channelId: channel._id.toHexString(),
      conversationId: conv._id.toHexString(),
      messageId: message._id.toHexString(),
      actionable: !locked,
    };
    this.events.emit(INBOX_MESSAGE_RECEIVED, event);
    return { contact, conversation: conv, message, duplicate: false };
  }

  // ----------------------------------------------------------------- outbound

  /**
   * Stores a message from the business (a staff reply, an AI reply, a note or a system
   * line) and delivers it on the channel. Notes and system lines stay internal.
   */
  async postOutgoing(
    conv: ConversationDoc,
    contact: ContactDoc,
    channel: ChannelDoc | null,
    input: OutgoingInput,
    now = new Date(),
  ): Promise<{ message: MessageDoc; conversation: ConversationDoc; duplicate: boolean }> {
    const internal = input.type === 'note' || input.type === 'system';
    if (!internal) {
      if (!channel)
        throw AppError.conflict(
          'channel_removed',
          'This conversation’s channel was removed, so replies cannot be delivered.',
        );
      if (channel.status === 'disabled')
        throw AppError.conflict(
          'channel_disabled',
          'This channel is turned off. Turn it on in Settings › Channels to reply.',
        );
      if (sendsThroughMeta(channel.type)) {
        if (channel.status === 'error')
          throw AppError.conflict(
            'channel_needs_reconnect',
            'Meta stopped accepting messages from this channel. Reconnect it in Settings › Channels to reply.',
          );
        if (!replyWindowOpen(channel.type, conv.lastInboundAt, now))
          throw AppError.conflict(
            'outside_reply_window',
            'More than 24 hours have passed since the customer’s last message, so Meta does not allow a reply. You can answer when they write again.',
            { lastInboundAt: conv.lastInboundAt?.toISOString() ?? null },
          );
      }
    }
    // Meta channels deliver through the outbox queue; the worker records the outcome.
    const viaMeta = !internal && channel !== null && sendsThroughMeta(channel.type);

    let message: MessageDoc;
    try {
      message = await this.messages.create({
        conversationId: conv._id,
        channelId: conv.channelId,
        direction: 'out',
        type: input.type,
        sender: input.sender,
        text: input.text,
        attachments: input.attachments ?? [],
        ...(input.clientId ? { clientId: input.clientId } : {}),
        // Web chat delivers through the live connection; the visitor's page loads
        // anything it missed when it reconnects.
        delivery: viaMeta ? { status: 'pending' } : { status: 'sent', at: now },
        ...(input.ai ? { ai: input.ai } : {}),
      });
    } catch (err) {
      if (!isDuplicateKey(err) || !input.clientId) throw err;
      const existing = await this.messages.findOne({
        conversationId: conv._id,
        clientId: input.clientId,
      });
      if (!existing) throw err;
      return { message: existing, conversation: conv, duplicate: true };
    }

    const orgId = this.orgId();
    if (viaMeta) await this.outbox.enqueue(orgId, message._id.toHexString());
    if (!internal && channel?.type === 'web_chat') {
      const org = await this.orgs.get(orgId);
      await this.realtime.toVisitor(
        channel._id,
        contact.externalId,
        toVisitorMessageDto(message, org.name),
      );
    }

    const updated = internal
      ? conv
      : ((await this.conversations.findOneAndUpdate(
          { _id: conv._id },
          {
            $set: {
              lastMessage: {
                text: preview(input.text, input.type),
                at: now,
                direction: 'out',
                senderType: input.sender.type,
              },
              lastMessageAt: now,
            },
          },
        )) ?? conv);
    await this.realtime.messageCreated(orgId, updated.assigneeId, toMessageDto(message));
    if (!internal) await this.publishConversation(updated, { contact });
    return { message, conversation: updated, duplicate: false };
  }

  /**
   * Sends a failed Messenger, Instagram or WhatsApp message again. The same window and
   * channel rules as a new reply apply.
   */
  async retryDelivery(
    conv: ConversationDoc,
    channel: ChannelDoc | null,
    messageId: string,
    now = new Date(),
  ): Promise<MessageDoc> {
    const message = Types.ObjectId.isValid(messageId)
      ? await this.messages.findOne({
          _id: new Types.ObjectId(messageId),
          conversationId: conv._id,
        })
      : null;
    if (!message || message.direction !== 'out') throw AppError.notFound('message');
    if (message.delivery.status !== 'failed')
      throw AppError.conflict('not_failed', 'Only a message that failed can be sent again.');
    if (!channel)
      throw AppError.conflict(
        'channel_removed',
        'This conversation’s channel was removed, so replies cannot be delivered.',
      );
    if (!sendsThroughMeta(channel.type))
      throw AppError.conflict('not_failed', 'Only a message that failed can be sent again.');
    if (channel.status !== 'active')
      throw AppError.conflict(
        channel.status === 'error' ? 'channel_needs_reconnect' : 'channel_disabled',
        channel.status === 'error'
          ? 'Meta stopped accepting messages from this channel. Reconnect it in Settings › Channels to reply.'
          : 'This channel is turned off. Turn it on in Settings › Channels to reply.',
      );
    if (!replyWindowOpen(channel.type, conv.lastInboundAt, now))
      throw AppError.conflict(
        'outside_reply_window',
        'More than 24 hours have passed since the customer’s last message, so Meta does not allow a reply. You can answer when they write again.',
        { lastInboundAt: conv.lastInboundAt?.toISOString() ?? null },
      );
    const updated = await this.messages.findOneAndUpdate(
      { _id: message._id, 'delivery.status': 'failed' },
      { $set: { delivery: { status: 'pending' } } },
    );
    if (!updated)
      throw AppError.conflict('not_failed', 'Only a message that failed can be sent again.');
    await this.outbox.enqueue(this.orgId(), updated._id.toHexString(), { retry: true });
    await this.realtime.messageUpdated(this.orgId(), conv.assigneeId, toMessageDto(updated));
    return updated;
  }

  /**
   * Records what happened to a message on the channel. A status only moves forward
   * (pending, sent, delivered, read); a late "sent" never undoes "read".
   */
  async updateDelivery(
    filter: { _id: Types.ObjectId } | { channelId: Types.ObjectId; externalId: string },
    status: Exclude<DeliveryStatus, 'pending'>,
    opts: { error?: string; externalId?: string; at?: Date } = {},
  ): Promise<MessageDoc | null> {
    const set: Record<string, unknown> = {
      'delivery.status': status,
      'delivery.at': opts.at ?? new Date(),
    };
    if (opts.externalId) set.externalId = opts.externalId;
    const update: Record<string, unknown> = { $set: set };
    if (status === 'failed')
      set['delivery.error'] = opts.error ?? 'The message could not be delivered';
    else update.$unset = { 'delivery.error': 1 };
    const message = await this.messages.findOneAndUpdate(
      { ...filter, direction: 'out', 'delivery.status': { $in: DELIVERY_FROM[status] } },
      update,
    );
    if (message) await this.publishMessage(message);
    return message;
  }

  /**
   * Messenger reports reads and deliveries as "everything up to this time". Marks the
   * contact's earlier messages and tells live clients about the newest few.
   */
  async updateDeliveryUpTo(
    channelId: Types.ObjectId,
    contactExternalId: string,
    status: 'delivered' | 'read',
    upTo: Date,
  ): Promise<number> {
    const contact = await this.contacts.findOne({ channelId, externalId: contactExternalId });
    if (!contact) return 0;
    const conv = await this.conversations.findOne({ contactId: contact._id });
    if (!conv) return 0;
    const filter = {
      conversationId: conv._id,
      direction: 'out' as const,
      type: { $in: [...CUSTOMER_VISIBLE_TYPES] },
      'delivery.status': { $in: DELIVERY_FROM[status] },
      createdAt: { $lte: upTo },
    };
    const affected = await this.messages.find(filter, { sort: { _id: -1 }, limit: 20 });
    if (!affected.length) return 0;
    const modified = await this.messages.updateMany(filter, {
      $set: { 'delivery.status': status, 'delivery.at': new Date() },
    });
    for (const m of affected)
      await this.realtime.messageUpdated(
        this.orgId(),
        conv.assigneeId,
        toMessageDto({ ...m, delivery: { status, at: new Date() } }),
      );
    return modified;
  }

  /**
   * Records the outcome of saving one of a message's attachments and tells live clients.
   * Only a still-pending attachment changes, so a late retry never undoes a result.
   */
  async settleAttachment(
    messageId: Types.ObjectId,
    index: number,
    result:
      | { status: 'ready'; fileId: Types.ObjectId; contentType: string; size: number }
      | { status: 'failed'; error: string },
  ): Promise<MessageDoc | null> {
    const at = `attachments.${index}`;
    const message = await this.messages.findOneAndUpdate(
      { _id: messageId, [`${at}.status`]: 'pending' },
      result.status === 'ready'
        ? {
            $set: {
              [`${at}.status`]: 'ready',
              [`${at}.fileId`]: result.fileId,
              [`${at}.contentType`]: result.contentType,
              [`${at}.size`]: result.size,
            },
            $unset: { [`${at}.source`]: 1 },
          }
        : { $set: { [`${at}.status`]: 'failed', [`${at}.error`]: result.error } },
    );
    if (message) await this.publishMessage(message);
    return message;
  }

  private async publishMessage(message: MessageDoc): Promise<void> {
    const conv = await this.conversations.findById(message.conversationId);
    await this.realtime.messageUpdated(this.orgId(), conv?.assigneeId, toMessageDto(message));
  }

  /**
   * Stores a message the business sent from outside the inbox (the Facebook page inbox or
   * the phone app), so the thread shows the whole conversation. Returns null when the
   * customer is unknown here or the message was stored before.
   */
  async recordSentElsewhere(
    channel: ChannelDoc,
    contactExternalId: string,
    input: { externalId: string; text: string; senderName: string },
    now = new Date(),
  ): Promise<{ conversation: ConversationDoc; contact: ContactDoc; message: MessageDoc } | null> {
    const contact = await this.contacts.findOne({
      channelId: channel._id,
      externalId: contactExternalId,
    });
    if (!contact) return null;
    const conv = await this.conversations.findOne({ contactId: contact._id });
    if (!conv) return null;
    if (await this.messages.exists({ channelId: channel._id, externalId: input.externalId }))
      return null;
    let message: MessageDoc;
    try {
      message = await this.messages.create({
        conversationId: conv._id,
        channelId: channel._id,
        direction: 'out',
        type: 'text',
        sender: { type: 'user', name: input.senderName },
        text: input.text,
        attachments: [],
        externalId: input.externalId,
        delivery: { status: 'sent', at: now },
      });
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
    const updated =
      (await this.conversations.findOneAndUpdate(
        { _id: conv._id },
        {
          $set: {
            lastMessage: {
              text: preview(input.text, 'text'),
              at: now,
              direction: 'out',
              senderType: 'user',
            },
            lastMessageAt: now,
          },
        },
      )) ?? conv;
    await this.realtime.messageCreated(this.orgId(), updated.assigneeId, toMessageDto(message));
    await this.publishConversation(updated, { contact });
    return { conversation: updated, contact, message };
  }

  /** Pauses the AI in a conversation (if it is on), with a line for the team. */
  async pauseAi(
    conv: ConversationDoc,
    contact: ContactDoc,
    changedBy: NonNullable<ConversationAi['changedBy']>,
    reason: string,
    line: string,
  ): Promise<ConversationDoc | null> {
    const updated = await this.conversations.findOneAndUpdate(
      { _id: conv._id, 'ai.mode': 'auto' },
      { $set: { ai: { mode: 'paused', changedAt: new Date(), changedBy, reason } } },
    );
    if (!updated) return null;
    await this.systemLine(updated, contact, line);
    await this.publishConversation(updated, { contact });
    return updated;
  }

  /** A staff-only line in the thread, e.g. "Rahim paused the AI". */
  async systemLine(conv: ConversationDoc, contact: ContactDoc, text: string): Promise<MessageDoc> {
    const { message } = await this.postOutgoing(conv, contact, null, {
      type: 'system',
      text,
      sender: { type: 'system' },
    });
    return message;
  }
}
