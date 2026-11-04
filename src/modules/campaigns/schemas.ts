import { Schema, type Types } from 'mongoose';
import { tenantSchema, uniquePerTenant } from '../../infra/database/schema-helpers.js';
import { CUSTOMER_SOURCES } from '../commerce/schemas.js';
import type { SmsLanguage } from '../sms/templates.js';
import type { CampaignAudience } from './campaign-rules.js';

/** Kept one year, like the SMS they point at (ADR 0017). */
const KEEP_SECONDS = 365 * 24 * 3600;

// ---------------------------------------------------------------- links

export const LINK_KINDS = ['none', 'store', 'landing_page', 'product'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Where `{link}` goes. The short code is made when the text first goes out. */
export interface LinkChoice {
  kind: LinkKind;
  storeId?: Types.ObjectId;
  /** The landing page or product id. */
  targetId?: string;
  /** Its name, for the dashboard. */
  label?: string;
  /** The path on the store's address: `/`, `/<slug>`, `/products/<slug>`. */
  path?: string;
  code?: string;
}

export const linkChoiceSchema = new Schema<LinkChoice>(
  {
    kind: { type: String, enum: LINK_KINDS, required: true },
    storeId: Schema.Types.ObjectId,
    targetId: String,
    label: String,
    path: String,
    code: String,
  },
  { _id: false, strict: 'throw' },
);

/** A short link `<store>/c/<code>` in campaign and automation texts. */
export interface MarketingLink {
  orgId: Types.ObjectId;
  /** 8 letters and digits, unique across Sellora. */
  code: string;
  storeId: Types.ObjectId;
  path: string;
  /** The `utm_campaign` value the storefront adds. */
  utm: string;
  owner: { type: 'campaign' | 'automation'; id: string };
  clicks: number;
  lastClickAt?: Date;
}

export const marketingLinkSchema = tenantSchema<MarketingLink>({
  code: { type: String, required: true },
  storeId: { type: Schema.Types.ObjectId, required: true },
  path: { type: String, required: true },
  utm: { type: String, required: true },
  owner: {
    type: new Schema(
      { type: { type: String, enum: ['campaign', 'automation'] }, id: String },
      { _id: false, strict: 'throw' },
    ),
    required: true,
  },
  clicks: { type: Number, default: 0, min: 0 },
  lastClickAt: Date,
});
marketingLinkSchema.index({ code: 1 }, { unique: true });
marketingLinkSchema.index({ orgId: 1, 'owner.type': 1, 'owner.id': 1 });

// ---------------------------------------------------------------- campaigns

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
/** `invalid`: a scheduled campaign whose text or link stopped being right (a page went offline). */
export const CAMPAIGN_PAUSES = ['staff', 'wallet', 'sms_off', 'not_in_plan', 'invalid'] as const;
export type CampaignPause = (typeof CAMPAIGN_PAUSES)[number];
export const CAMPAIGN_WAITS = ['night', 'daily_limit'] as const;
export type CampaignWait = (typeof CAMPAIGN_WAITS)[number];

export interface Campaign {
  orgId: Types.ObjectId;
  name: string;
  text: string;
  audience: CampaignAudience;
  link: LinkChoice;
  status: CampaignStatus;
  /** When a scheduled campaign starts. */
  scheduledAt?: Date;
  /** When the sweep should look at it next (start or next batch); null when nothing is due. */
  nextRunAt: Date | null;
  startedAt?: Date;
  finishedAt?: Date;
  cancelledAt?: Date;
  pause?: { reason: CampaignPause; at: Date };
  wait?: { reason: CampaignWait; until: Date };
  /** What it was expected to cost when it started. */
  estimate?: {
    recipients: number;
    parts: number;
    pricePerPartMinor: number;
    totalMinor: number;
    currency: string;
  };
  counts: { recipients: number; queued: number; optedOut: number; unreachable: number };
  orders: { count: number; revenueMinor: number };
  tests: number;
  createdBy?: string;
  startedBy?: string;
}

const audienceSchema = new Schema<CampaignAudience>(
  {
    ordered: { type: String, enum: ['any', 'ordered', 'delivered'], default: 'ordered' },
    minOrders: Number,
    minSpentMinor: Number,
    orderedWithinDays: Number,
    noOrderForDays: Number,
    tags: { type: [String], default: undefined },
    sources: { type: [String], enum: CUSTOMER_SOURCES, default: undefined },
  },
  { _id: false, strict: 'throw' },
);

export const campaignSchema = tenantSchema<Campaign>({
  name: { type: String, required: true, trim: true },
  text: { type: String, default: '' },
  audience: { type: audienceSchema, default: () => ({ ordered: 'ordered' }) },
  link: { type: linkChoiceSchema, default: () => ({ kind: 'none' }) },
  status: { type: String, enum: CAMPAIGN_STATUSES, default: 'draft' },
  scheduledAt: Date,
  nextRunAt: { type: Date, default: null },
  startedAt: Date,
  finishedAt: Date,
  cancelledAt: Date,
  pause: {
    type: new Schema(
      { reason: { type: String, enum: CAMPAIGN_PAUSES }, at: Date },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  wait: {
    type: new Schema(
      { reason: { type: String, enum: CAMPAIGN_WAITS }, until: Date },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  estimate: {
    type: new Schema(
      {
        recipients: Number,
        parts: Number,
        pricePerPartMinor: Number,
        totalMinor: Number,
        currency: String,
      },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  counts: {
    type: new Schema(
      {
        recipients: { type: Number, default: 0 },
        queued: { type: Number, default: 0 },
        optedOut: { type: Number, default: 0 },
        unreachable: { type: Number, default: 0 },
      },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  orders: {
    type: new Schema(
      { count: { type: Number, default: 0 }, revenueMinor: { type: Number, default: 0 } },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  tests: { type: Number, default: 0, min: 0 },
  createdBy: String,
  startedBy: String,
});
campaignSchema.index({ orgId: 1, _id: -1 });
campaignSchema.index({ orgId: 1, status: 1, _id: -1 });
// The sweep: campaigns to start or continue, across businesses.
campaignSchema.index(
  { nextRunAt: 1 },
  {
    partialFilterExpression: {
      status: { $in: ['scheduled', 'sending'] },
      nextRunAt: { $type: 'date' },
    },
  },
);

export const RECIPIENT_STATUSES = ['pending', 'queued', 'skipped'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];
export const RECIPIENT_SKIPS = ['opted_out', 'unreachable', 'off', 'cancelled'] as const;
export type RecipientSkip = (typeof RECIPIENT_SKIPS)[number];

export interface MarketingOrder {
  id: string;
  number: string;
  totalMinor: number;
  at: Date;
}

const marketingOrderSchema = new Schema<MarketingOrder>(
  { id: String, number: String, totalMinor: Number, at: Date },
  { _id: false, strict: 'throw' },
);

/** One customer a campaign was sent to, written down when the campaign started. */
export interface CampaignRecipient {
  orgId: Types.ObjectId;
  campaignId: Types.ObjectId;
  customerId: Types.ObjectId;
  phone: string;
  name: string;
  status: RecipientStatus;
  skip?: RecipientSkip;
  messageId?: string;
  queuedAt?: Date;
  order?: MarketingOrder;
}

export const campaignRecipientSchema = tenantSchema<CampaignRecipient>({
  campaignId: { type: Schema.Types.ObjectId, required: true },
  customerId: { type: Schema.Types.ObjectId, required: true },
  phone: { type: String, required: true },
  name: { type: String, default: '' },
  status: { type: String, enum: RECIPIENT_STATUSES, default: 'pending' },
  skip: { type: String, enum: RECIPIENT_SKIPS },
  messageId: String,
  queuedAt: Date,
  order: { type: marketingOrderSchema, default: undefined },
});
campaignRecipientSchema.index({ orgId: 1, campaignId: 1, phone: 1 }, { unique: true });
campaignRecipientSchema.index({ orgId: 1, campaignId: 1, status: 1, _id: 1 });
campaignRecipientSchema.index({ orgId: 1, campaignId: 1, _id: -1 });
campaignRecipientSchema.index({ orgId: 1, phone: 1, queuedAt: -1 });
campaignRecipientSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });

// ---------------------------------------------------------------- automations

export const AUTOMATION_KINDS = ['after_delivery', 'win_back'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export interface Automation {
  enabled: boolean;
  /** Days after delivery, or days without an order. */
  days: number;
  text: string;
  link: LinkChoice;
  /** When it was last switched on: only events after this count. */
  enabledAt?: Date;
}

const automationSchema = new Schema<Automation>(
  {
    enabled: { type: Boolean, default: false },
    days: { type: Number, required: true },
    text: { type: String, default: '' },
    link: { type: linkChoiceSchema, default: () => ({ kind: 'none' }) },
    enabledAt: Date,
  },
  { _id: false, strict: 'throw' },
);

/** One per business: the texts that go out by themselves. */
export interface AutomationSettings {
  orgId: Types.ObjectId;
  language: SmsLanguage;
  after_delivery: Automation;
  win_back: Automation;
  /** When the sweep last looked for customers whose win-back day came. */
  winBackCheckedAt?: Date;
}

export const automationSettingsSchema = tenantSchema<AutomationSettings>({
  language: { type: String, enum: ['en', 'bn'], default: 'en' },
  after_delivery: { type: automationSchema, required: true },
  win_back: { type: automationSchema, required: true },
  winBackCheckedAt: Date,
});
uniquePerTenant(automationSettingsSchema);
// The sweep: businesses with win-back on.
automationSettingsSchema.index(
  { winBackCheckedAt: 1 },
  { partialFilterExpression: { 'win_back.enabled': true } },
);

export const AUTOMATION_SEND_STATUSES = ['pending', 'sent', 'skipped'] as const;
export const AUTOMATION_SKIPS = [
  'off',
  'not_in_plan',
  'returned',
  'opted_out',
  'late',
  'no_phone',
  /** The customer ordered again (win back) before the text went. */
  'ordered_again',
  'blocked',
  /** The page the link goes to is no longer live or on sale. */
  'link_gone',
] as const;
export type AutomationSkip = (typeof AUTOMATION_SKIPS)[number];

/** One automation text for one customer: planned, then sent or skipped. */
export interface AutomationSend {
  orgId: Types.ObjectId;
  kind: AutomationKind;
  /** Unique per business: `after_delivery:<order>` or `win_back:<customer>:<last order ms>`. */
  key: string;
  customerId?: Types.ObjectId;
  orderId?: Types.ObjectId;
  orderNumber?: string;
  phone: string;
  name: string;
  /** When it should go (moved on by quiet nights and the 24-hour gap). */
  dueAt: Date;
  /** When it was first due; it is skipped once AUTOMATION_MAX_LATE_MS later. */
  firstDueAt: Date;
  status: (typeof AUTOMATION_SEND_STATUSES)[number];
  skip?: AutomationSkip;
  messageId?: string;
  sentAt?: Date;
  order?: MarketingOrder;
}

export const automationSendSchema = tenantSchema<AutomationSend>({
  kind: { type: String, enum: AUTOMATION_KINDS, required: true },
  key: { type: String, required: true },
  customerId: Schema.Types.ObjectId,
  orderId: Schema.Types.ObjectId,
  orderNumber: String,
  phone: { type: String, required: true },
  name: { type: String, default: '' },
  dueAt: { type: Date, required: true },
  firstDueAt: { type: Date, required: true },
  status: { type: String, enum: AUTOMATION_SEND_STATUSES, default: 'pending' },
  skip: { type: String, enum: AUTOMATION_SKIPS },
  messageId: String,
  sentAt: Date,
  order: { type: marketingOrderSchema, default: undefined },
});
automationSendSchema.index({ orgId: 1, key: 1 }, { unique: true });
automationSendSchema.index({ orgId: 1, kind: 1, _id: -1 });
automationSendSchema.index({ orgId: 1, phone: 1, sentAt: -1 });
automationSendSchema.index({ dueAt: 1 }, { partialFilterExpression: { status: 'pending' } });
automationSendSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });
