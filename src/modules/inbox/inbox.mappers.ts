import type { WithId } from '../../infra/database/schema-helpers.js';
import type { Contact, Conversation, Message } from './schemas.js';

export type ContactDoc = WithId<Contact>;
export type ConversationDoc = WithId<Conversation>;
export type MessageDoc = WithId<Message>;

export function toContactDto(c: ContactDoc) {
  return {
    id: c._id.toHexString(),
    channelId: c.channelId.toHexString(),
    name: c.name,
    phone: c.phone ?? null,
    email: c.email ?? null,
    avatarUrl: c.avatarUrl ?? null,
    customerId: c.customerId?.toHexString() ?? null,
    lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

export type ContactDto = ReturnType<typeof toContactDto>;

export function toConversationDto(
  c: ConversationDoc,
  contact: ContactDoc | null | undefined,
  currentMonth: string,
) {
  const locked = c.limitedMonth === currentMonth;
  return {
    id: c._id.toHexString(),
    channelId: c.channelId.toHexString(),
    channelType: c.channelType,
    status: c.status,
    assigneeId: c.assigneeId?.toHexString() ?? null,
    ai: {
      mode: c.ai.mode,
      changedAt: c.ai.changedAt?.toISOString() ?? null,
      changedBy: c.ai.changedBy ?? null,
      reason: c.ai.reason ?? null,
    },
    lastMessage: c.lastMessage
      ? {
          // A locked thread's content stays hidden until the plan allows it.
          text: locked ? '' : c.lastMessage.text,
          at: c.lastMessage.at.toISOString(),
          direction: c.lastMessage.direction,
          senderType: c.lastMessage.senderType,
        }
      : null,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    unread: c.unread,
    tags: c.tags,
    /** The customer wrote after this month's conversation limit was used up. */
    locked,
    contact: contact ? toContactDto(contact) : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export type ConversationDto = ReturnType<typeof toConversationDto>;

export function toMessageDto(m: MessageDoc) {
  return {
    id: m._id.toHexString(),
    conversationId: m.conversationId.toHexString(),
    direction: m.direction,
    type: m.type,
    sender: { type: m.sender.type, id: m.sender.id ?? null, name: m.sender.name ?? null },
    text: m.text,
    attachments: m.attachments.map((a) => ({
      url: a.url,
      contentType: a.contentType ?? null,
      name: a.name ?? null,
      size: a.size ?? null,
    })),
    clientId: m.clientId ?? null,
    delivery: { status: m.delivery.status, error: m.delivery.error ?? null },
    ai: m.ai ? { credits: m.ai.credits } : null,
    createdAt: m.createdAt.toISOString(),
  };
}

export type MessageDto = ReturnType<typeof toMessageDto>;

/** Message types a customer can see. Notes and system lines are staff-only. */
export const CUSTOMER_VISIBLE_TYPES = ['text', 'image', 'file'] as const;

/** What a website visitor sees: no staff ids, no internal fields, no AI cost. */
export function toVisitorMessageDto(m: MessageDoc, businessName: string) {
  const mine = m.direction === 'in';
  return {
    id: m._id.toHexString(),
    from: mine ? ('visitor' as const) : ('business' as const),
    name: mine ? null : m.sender.type === 'user' ? (m.sender.name ?? businessName) : businessName,
    type: m.type,
    text: m.text,
    attachments: m.attachments.map((a) => ({
      url: a.url,
      contentType: a.contentType ?? null,
      name: a.name ?? null,
    })),
    clientId: mine ? (m.clientId ?? null) : null,
    createdAt: m.createdAt.toISOString(),
  };
}

export type VisitorMessageDto = ReturnType<typeof toVisitorMessageDto>;

/** First 140 characters, for list previews. */
export function preview(text: string, type: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat) return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  return type === 'image' ? 'Photo' : type === 'file' ? 'File' : '';
}
