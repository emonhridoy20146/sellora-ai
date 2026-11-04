import { Schema, type Types } from 'mongoose';
import {
  platformSchema,
  tenantSchema,
  uniquePerTenant,
} from '../../infra/database/schema-helpers.js';
import type { SmsEncoding } from './segments.js';
import { SMS_PROVIDER_KEYS, type SmsErrorKind, type SmsProviderKey } from './sms.types.js';
import {
  ORDER_SMS_EVENTS,
  SMS_PURPOSES,
  type OrderSmsEvent,
  type OrderTemplate,
  type SmsLanguage,
  type SmsPurpose,
} from './templates.js';

export const SMS_MODES = ['off', 'sellora', 'own'] as const;
export type SmsMode = (typeof SMS_MODES)[number];

export const SENDER_NAME_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type SenderNameStatus = (typeof SENDER_NAME_STATUSES)[number];

/** The business's own SMS provider account (route "own"). */
export interface OwnSmsGateway {
  provider: SmsProviderKey;
  credentialsEnc: string;
  hint: string;
  senderId: string;
  checkedAt?: Date;
  checkSummary?: string;
  lastError?: string;
  lastErrorAt?: Date;
}

/** A sender name (masking) the business asked to send Sellora SMS from. */
export interface SenderNameRequest {
  name: string;
  status: SenderNameStatus;
  reason?: string;
  requestedAt: Date;
  requestedBy: string;
  decidedAt?: Date;
  decidedBy?: string;
}

/** One per business: how it sends SMS and what its order messages say. */
export interface SmsSettings {
  orgId: Types.ObjectId;
  mode: SmsMode;
  language: SmsLanguage;
  /** {shop} in messages; empty uses the business name. */
  shopName: string;
  /** {phone} in messages; empty uses the business's contact phone. */
  contactPhone: string;
  own?: OwnSmsGateway;
  senderName?: SenderNameRequest;
  /** Send Sellora SMS from the approved sender name instead of the shared sender. */
  useSenderName: boolean;
  orderTemplates: Record<OrderSmsEvent, OrderTemplate>;
  /** Messages a day; null uses SMS_DAILY_LIMIT. Set by the super-admin. */
  dailyLimit: number | null;
}

const templateSchema = new Schema(
  { enabled: { type: Boolean, default: false }, text: { type: String, default: '' } },
  { _id: false, strict: 'throw' },
);

export const smsSettingsSchema = tenantSchema<SmsSettings>({
  mode: { type: String, enum: SMS_MODES, default: 'off' },
  language: { type: String, enum: ['en', 'bn'], default: 'en' },
  shopName: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  own: {
    type: new Schema(
      {
        provider: { type: String, enum: SMS_PROVIDER_KEYS, required: true },
        credentialsEnc: { type: String, required: true },
        hint: { type: String, required: true },
        senderId: { type: String, default: '' },
        checkedAt: Date,
        checkSummary: String,
        lastError: String,
        lastErrorAt: Date,
      },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  senderName: {
    type: new Schema(
      {
        name: { type: String, required: true },
        status: { type: String, enum: SENDER_NAME_STATUSES, required: true },
        reason: String,
        requestedAt: { type: Date, required: true },
        requestedBy: { type: String, required: true },
        decidedAt: Date,
        decidedBy: String,
      },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  useSenderName: { type: Boolean, default: false },
  orderTemplates: {
    type: new Schema(
      Object.fromEntries(
        ORDER_SMS_EVENTS.map((e) => [e, { type: templateSchema, default: () => ({}) }]),
      ),
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  dailyLimit: { type: Number, default: null, min: 0 },
});
uniquePerTenant(smsSettingsSchema);
smsSettingsSchema.index({ 'senderName.status': 1, 'senderName.requestedAt': 1 });

export const SMS_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'unknown',
] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];
export const SMS_ROUTES = ['sellora', 'own'] as const;
export type SmsRoute = (typeof SMS_ROUTES)[number];

/** Why a message failed without reaching a provider, in Sellora's words. */
export type SmsFailure =
  SmsErrorKind | 'insufficient_balance' | 'daily_limit' | 'not_configured' | 'unreachable_number';

/** One SMS, written down before it is sent; kept a year. */
export interface SmsMessage {
  orgId: Types.ObjectId;
  /** Unique per business: what this message is (order:<id>:shipped, test:<uuid>). */
  key: string;
  to: string;
  body: string;
  purpose: SmsPurpose;
  marketing: boolean;
  ref?: { type: string; id: string; label?: string };
  route: SmsRoute;
  /** Missing when no provider was set up when the message was made (it failed at once). */
  provider?: SmsProviderKey;
  senderId: string;
  encoding: SmsEncoding;
  parts: number;
  /** What the business pays Sellora (Sellora SMS only; 0 on its own gateway). */
  priceMinor: number;
  /** What it costs Sellora (Sellora SMS only), for profit reports. */
  costMinor: number;
  currency: string;
  /** The price is held in the wallet until the message is sent or fails. */
  held: boolean;
  status: SmsStatus;
  failure?: SmsFailure;
  error?: string;
  providerMessageId?: string;
  providerStatus?: string;
  queuedAt: Date;
  sentAt?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  actor: { type: string; id: string };
}

export const smsMessageSchema = tenantSchema<SmsMessage>({
  key: { type: String, required: true },
  to: { type: String, required: true },
  body: { type: String, required: true },
  purpose: { type: String, enum: SMS_PURPOSES, required: true },
  marketing: { type: Boolean, default: false },
  ref: {
    type: new Schema({ type: String, id: String, label: String }, { _id: false, strict: 'throw' }),
    default: undefined,
  },
  route: { type: String, enum: SMS_ROUTES, required: true },
  provider: { type: String, enum: SMS_PROVIDER_KEYS },
  senderId: { type: String, default: '' },
  encoding: { type: String, enum: ['gsm', 'unicode'], required: true },
  parts: { type: Number, required: true, min: 1 },
  priceMinor: { type: Number, default: 0, min: 0 },
  costMinor: { type: Number, default: 0, min: 0 },
  currency: { type: String, required: true },
  held: { type: Boolean, default: false },
  status: { type: String, enum: SMS_STATUSES, required: true },
  failure: String,
  error: String,
  providerMessageId: String,
  providerStatus: String,
  queuedAt: { type: Date, required: true },
  sentAt: Date,
  deliveredAt: Date,
  failedAt: Date,
  actor: {
    type: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }),
    required: true,
  },
});
smsMessageSchema.index({ orgId: 1, key: 1 }, { unique: true });
smsMessageSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
smsMessageSchema.index({ orgId: 1, status: 1, createdAt: -1 });
smsMessageSchema.index({ orgId: 1, 'ref.type': 1, 'ref.id': 1 });
smsMessageSchema.index(
  { provider: 1, providerMessageId: 1 },
  { partialFilterExpression: { providerMessageId: { $type: 'string' } } },
);
smsMessageSchema.index({ route: 1, createdAt: -1 });
smsMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

/** A number the business must not send marketing messages to. */
export interface SmsOptOut {
  orgId: Types.ObjectId;
  phone: string;
  source: 'link' | 'staff';
  by?: string;
}

export const smsOptOutSchema = tenantSchema<SmsOptOut>({
  phone: { type: String, required: true },
  source: { type: String, enum: ['link', 'staff'], required: true },
  by: String,
});
smsOptOutSchema.index({ orgId: 1, phone: 1 }, { unique: true });

/** The short code in a marketing message's opt-out link (one per business and number). */
export interface SmsLink {
  orgId: Types.ObjectId;
  code: string;
  phone: string;
}

export const smsLinkSchema = tenantSchema<SmsLink>({
  code: { type: String, required: true },
  phone: { type: String, required: true },
});
smsLinkSchema.index({ code: 1 }, { unique: true });
smsLinkSchema.index({ orgId: 1, phone: 1 }, { unique: true });

/** What Sellora SMS costs per part in one currency. */
export interface SmsPrice {
  currency: string;
  /** Per part from the shared sender. */
  perPartMinor: number;
  /** Per part from the business's own sender name. */
  senderNamePerPartMinor: number;
}

/** Sellora's own SMS account (route "sellora"), set up by the super-admin. One document. */
export interface SmsPlatform {
  _id: string;
  enabled: boolean;
  provider?: SmsProviderKey;
  credentialsEnc?: string;
  hint?: string;
  /** The shared sender (a non-masking number or Sellora's own name). */
  senderId: string;
  checkedAt?: Date;
  checkSummary?: string;
  /** What businesses pay. */
  prices: SmsPrice[];
  /** What Sellora pays the provider, for profit reports. */
  costs: SmsPrice[];
  updatedBy?: string;
}

const priceSchema = new Schema(
  {
    currency: { type: String, required: true, uppercase: true },
    perPartMinor: { type: Number, required: true, min: 0 },
    senderNamePerPartMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false, strict: 'throw' },
);

export const smsPlatformSchema = platformSchema<SmsPlatform>({
  _id: { type: String, required: true },
  enabled: { type: Boolean, default: false },
  provider: { type: String, enum: SMS_PROVIDER_KEYS },
  credentialsEnc: String,
  hint: String,
  senderId: { type: String, default: '' },
  checkedAt: Date,
  checkSummary: String,
  prices: { type: [priceSchema], default: [] },
  costs: { type: [priceSchema], default: [] },
  updatedBy: String,
});
