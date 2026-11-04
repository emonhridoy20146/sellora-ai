import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';

export const CHANNEL_TYPES = ['web_chat', 'messenger', 'instagram', 'whatsapp'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_STATUSES = ['active', 'disabled', 'error'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Settings of the website chat widget. */
export interface WebChatConfig {
  /** Identifies the widget in the embed code. Not a secret: it is visible in the page. */
  publicKey: string;
  /** Sites allowed to show the widget (scheme + host). Empty means any site. */
  allowedOrigins: string[];
  greeting: string;
  color: string;
  /** Ask for name and phone before the first message. */
  askContact: boolean;
}

/** Messenger, Instagram or WhatsApp. Tokens are encrypted with DATA_ENCRYPTION_KEYS. */
export interface MetaChannelConfig {
  /** Page id (Messenger), Instagram account id, or WhatsApp phone number id. */
  externalId: string;
  displayName: string;
  /** Encrypted with the channel type and externalId as associated data (see MetaTokens). */
  accessTokenEnc: string;
  /** The Facebook page behind a Messenger or Instagram channel (webhook subscription, sending). */
  pageId?: string;
  /** Instagram @username. */
  username?: string;
  /** WhatsApp Business Account id. */
  wabaId?: string;
}

/** A place customers write from: the website widget, a Facebook page, an Instagram account. */
export interface Channel {
  orgId: Types.ObjectId;
  type: ChannelType;
  name: string;
  status: ChannelStatus;
  statusReason?: string;
  /** Whether the AI agent answers on this channel. */
  aiEnabled: boolean;
  webChat?: WebChatConfig;
  meta?: MetaChannelConfig;
  createdBy?: Types.ObjectId;
}

const webChatSchema = new Schema<WebChatConfig>(
  {
    publicKey: { type: String, required: true },
    allowedOrigins: { type: [String], default: [] },
    greeting: { type: String, default: '' },
    color: { type: String, default: '#2563eb' },
    askContact: { type: Boolean, default: true },
  },
  { _id: false, strict: 'throw' },
);

const metaSchema = new Schema<MetaChannelConfig>(
  {
    externalId: { type: String, required: true },
    displayName: { type: String, default: '' },
    accessTokenEnc: { type: String, required: true },
    pageId: String,
    username: String,
    wabaId: String,
  },
  { _id: false, strict: 'throw' },
);

export const channelSchema = tenantSchema<Channel>({
  type: { type: String, enum: CHANNEL_TYPES, required: true },
  name: { type: String, required: true },
  status: { type: String, enum: CHANNEL_STATUSES, default: 'active' },
  statusReason: String,
  aiEnabled: { type: Boolean, default: true },
  webChat: webChatSchema,
  meta: metaSchema,
  createdBy: Schema.Types.ObjectId,
});
channelSchema.index({ orgId: 1, type: 1 });
// Widget lookups and webhooks arrive without a tenant; these find the channel.
channelSchema.index(
  { 'webChat.publicKey': 1 },
  { unique: true, partialFilterExpression: { 'webChat.publicKey': { $type: 'string' } } },
);
channelSchema.index(
  { type: 1, 'meta.externalId': 1 },
  { unique: true, partialFilterExpression: { 'meta.externalId': { $type: 'string' } } },
);

/** Someone writing on a channel: a website visitor, a Messenger user, a WhatsApp number. */
export interface Contact {
  orgId: Types.ObjectId;
  channelId: Types.ObjectId;
  /** The channel's id for this person (visitor id, page-scoped id, WhatsApp number). */
  externalId: string;
  name: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
  /** The commerce customer this person is, once known. */
  customerId?: Types.ObjectId;
  lastSeenAt?: Date;
  /** What the AI agent remembered about this person. Staff can see and edit it. */
  memory?: ContactMemory;
}

export interface ContactMemory {
  /** Short lasting facts: "wears size M", "prefers bKash". */
  facts: string[];
  /** Delivery address the customer gave in the chat. */
  address?: string;
  updatedAt?: Date;
}

export const MEMORY_LIMITS = { facts: 20, fact: 200, address: 300 } as const;

export const contactSchema = tenantSchema<Contact>({
  channelId: { type: Schema.Types.ObjectId, required: true },
  externalId: { type: String, required: true },
  name: { type: String, default: '' },
  phone: String,
  email: String,
  avatarUrl: String,
  customerId: Schema.Types.ObjectId,
  lastSeenAt: Date,
  memory: new Schema<ContactMemory>(
    { facts: { type: [String], default: [] }, address: String, updatedAt: Date },
    { _id: false, strict: 'throw' },
  ),
});
contactSchema.index({ orgId: 1, channelId: 1, externalId: 1 }, { unique: true });
contactSchema.index({ orgId: 1, customerId: 1 });
contactSchema.index({ orgId: 1, phone: 1 });

export const CONVERSATION_STATUSES = ['open', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface ConversationAi {
  /** auto: the AI answers; paused: people answer. */
  mode: 'auto' | 'paused';
  changedAt?: Date;
  changedBy?: { type: string; id: string; name?: string };
  reason?: string;
}

/** One thread per contact. New messages reopen it. */
export interface Conversation {
  orgId: Types.ObjectId;
  channelId: Types.ObjectId;
  channelType: ChannelType;
  contactId: Types.ObjectId;
  status: ConversationStatus;
  /** User id of the staff member handling it. */
  assigneeId?: Types.ObjectId;
  ai: ConversationAi;
  lastMessage?: { text: string; at: Date; direction: 'in' | 'out'; senderType: string };
  lastMessageAt: Date;
  /** Last message from the customer; Messenger and WhatsApp only allow free replies for 24h. */
  lastInboundAt?: Date;
  /** Customer messages since a staff member last read the thread. */
  unread: number;
  tags: string[];
  /**
   * Month ('YYYY-MM', business time zone) the customer last wrote in, when that month counted
   * against the plan's conversationsPerMonth.
   */
  activeMonth?: string;
  /** Month in which the customer wrote after the monthly limit was used up; the thread is locked. */
  limitedMonth?: string;
}

export const conversationSchema = tenantSchema<Conversation>({
  channelId: { type: Schema.Types.ObjectId, required: true },
  channelType: { type: String, enum: CHANNEL_TYPES, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: CONVERSATION_STATUSES, default: 'open' },
  assigneeId: Schema.Types.ObjectId,
  ai: new Schema<ConversationAi>(
    {
      mode: { type: String, enum: ['auto', 'paused'], default: 'auto' },
      changedAt: Date,
      changedBy: new Schema({ type: String, id: String, name: String }, { _id: false }),
      reason: String,
    },
    { _id: false, strict: 'throw' },
  ),
  lastMessage: new Schema(
    { text: String, at: Date, direction: String, senderType: String },
    { _id: false, strict: 'throw' },
  ),
  lastMessageAt: { type: Date, required: true },
  lastInboundAt: Date,
  unread: { type: Number, default: 0, min: 0 },
  tags: { type: [String], default: [] },
  activeMonth: String,
  limitedMonth: String,
});
conversationSchema.index({ orgId: 1, contactId: 1 }, { unique: true });
conversationSchema.index({ orgId: 1, activeMonth: 1 });
conversationSchema.index({ orgId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ orgId: 1, assigneeId: 1, lastMessageAt: -1 });
conversationSchema.index({ orgId: 1, channelId: 1, lastMessageAt: -1 });

export const MESSAGE_TYPES = ['text', 'image', 'file', 'note', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const SENDER_TYPES = ['contact', 'user', 'ai', 'system'] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

export const DELIVERY_STATUSES = ['pending', 'sent', 'delivered', 'read', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ATTACHMENT_STATUSES = ['pending', 'ready', 'failed'] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

/**
 * A photo or file on a message. Customers' photos from Messenger, Instagram and WhatsApp
 * arrive `pending` with where to fetch them (`source`, never shown to anyone), and are
 * `ready` once saved to the business's storage (`fileId`), or `failed`. Older attachments
 * and links have only `url`.
 */
export interface MessageAttachment {
  url: string;
  contentType?: string;
  name?: string;
  size?: number;
  fileId?: Types.ObjectId;
  /** Absent means ready. */
  status?: AttachmentStatus;
  /** Where to fetch it: a Meta CDN link, or `wa:<media id>` for WhatsApp. */
  source?: string;
  /** Why it could not be saved (for staff, in plain words). */
  error?: string;
}

export interface Message {
  orgId: Types.ObjectId;
  conversationId: Types.ObjectId;
  channelId: Types.ObjectId;
  direction: 'in' | 'out';
  type: MessageType;
  sender: { type: SenderType; id?: string; name?: string };
  text: string;
  attachments: MessageAttachment[];
  /** The channel's message id, so a webhook delivered twice is stored once. */
  externalId?: string;
  /** The sender's own id for this message (widget retries), unique per conversation. */
  clientId?: string;
  delivery: { status: DeliveryStatus; error?: string; at?: Date };
  /** Set on AI replies: what the reply cost. */
  ai?: { requestId: string; credits: number };
}

export const messageSchema = tenantSchema<Message>({
  conversationId: { type: Schema.Types.ObjectId, required: true },
  channelId: { type: Schema.Types.ObjectId, required: true },
  direction: { type: String, enum: ['in', 'out'], required: true },
  type: { type: String, enum: MESSAGE_TYPES, default: 'text' },
  sender: new Schema(
    { type: { type: String, enum: SENDER_TYPES, required: true }, id: String, name: String },
    { _id: false, strict: 'throw' },
  ),
  text: { type: String, default: '' },
  attachments: {
    type: [
      new Schema(
        {
          url: { type: String, default: '' },
          contentType: String,
          name: String,
          size: Number,
          fileId: Schema.Types.ObjectId,
          status: { type: String, enum: ATTACHMENT_STATUSES },
          source: String,
          error: String,
        },
        { _id: false, strict: 'throw' },
      ),
    ],
    default: [],
  },
  externalId: String,
  clientId: String,
  delivery: new Schema(
    {
      status: { type: String, enum: DELIVERY_STATUSES, default: 'sent' },
      error: String,
      at: Date,
    },
    { _id: false, strict: 'throw' },
  ),
  ai: new Schema(
    { requestId: { type: String, required: true }, credits: { type: Number, required: true } },
    { _id: false, strict: 'throw' },
  ),
});
messageSchema.index({ orgId: 1, conversationId: 1, _id: -1 });
messageSchema.index(
  { orgId: 1, channelId: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
);
messageSchema.index(
  { orgId: 1, conversationId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
