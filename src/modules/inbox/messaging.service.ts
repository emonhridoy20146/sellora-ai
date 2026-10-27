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
  preview,
  toConversationDto,
  toMessageDto,
  toVisitorMessageDto,
  type ContactDoc,
  type ConversationDoc,
  type ConversationDto,
  type MessageDoc,
} from './inbox.mappers.js';
import { ContactRepository, ConversationRepository, MessageRepository } from './repositories.js';
import type { Message, MessageAttachment, MessageType, SenderType } from './schemas.js';

/** Emitted after a customer message is stored. The AI agent listens for it. */
export const INBOX_MESSAGE_RECEIVED = 'inbox.message.received';

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
      if (channel.type !== 'web_chat')
        throw AppError.conflict(
          'channel_send_unavailable',
          'Sending on this channel is not available yet.',
        );
    }

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
        delivery: { status: 'sent', at: now },
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
