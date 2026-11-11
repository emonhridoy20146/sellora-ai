import { Schema, type Types } from 'mongoose';
import { tenantSchema, uniquePerTenant } from '../../infra/database/schema-helpers.js';
import {
  AD_EVENT_NAMES,
  AD_PLATFORMS,
  CONSENT_MODES,
  PURCHASE_WHEN,
  type AdEventName,
  type AdPlatform,
  type ConsentMode,
  type PurchaseWhen,
} from './ad-tracking.types.js';

export const CHECK_STATES = ['ok', 'failed', 'unchecked'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/**
 * One of the business's own tracking ids (ADR 0030): a Meta pixel, a TikTok pixel, a GA4
 * stream or a Google Ads conversion. The server key (Conversions API token, Events API token,
 * Measurement Protocol secret) is optional, encrypted (AES-256-GCM, bound to the id) and
 * never returned.
 */
export interface AdDestination {
  orgId: Types.ObjectId;
  platform: AdPlatform;
  name: string;
  publicId: string;
  /** Google Ads: the purchase conversion's label. */
  conversionLabel?: string;
  secretEnc?: string;
  secretHint?: string;
  testCode?: string;
  enabled: boolean;
  /** Every store and landing page of the business, or only those listed. */
  everywhere: boolean;
  storeIds: Types.ObjectId[];
  landingPageIds: Types.ObjectId[];
  purchaseWhen: PurchaseWhen;
  /** Orders taken in the inbox or added by hand are sent too (server only). */
  chatOrders: boolean;
  lastCheck: { at: Date; state: CheckState; summary: string };
  lastSentAt?: Date;
  lastError?: { at: Date; message: string };
  createdBy?: Types.ObjectId;
}

export const adDestinationSchema = tenantSchema<AdDestination>({
  platform: { type: String, enum: AD_PLATFORMS, required: true },
  name: { type: String, required: true, maxlength: 80 },
  publicId: { type: String, required: true, maxlength: 40 },
  conversionLabel: { type: String, maxlength: 60 },
  secretEnc: String,
  secretHint: String,
  testCode: { type: String, maxlength: 60 },
  enabled: { type: Boolean, default: true },
  everywhere: { type: Boolean, default: true },
  storeIds: { type: [Schema.Types.ObjectId], default: [] },
  landingPageIds: { type: [Schema.Types.ObjectId], default: [] },
  purchaseWhen: { type: String, enum: PURCHASE_WHEN, default: 'placed' },
  chatOrders: { type: Boolean, default: false },
  lastCheck: {
    type: new Schema(
      { at: Date, state: { type: String, enum: CHECK_STATES }, summary: String },
      { _id: false, strict: 'throw' },
    ),
    required: true,
  },
  lastSentAt: Date,
  lastError: new Schema({ at: Date, message: String }, { _id: false, strict: 'throw' }),
  createdBy: Schema.Types.ObjectId,
});
adDestinationSchema.index({ orgId: 1, platform: 1, publicId: 1 }, { unique: true });

/** Whether shoppers are asked before anything tracks them, one per business. */
export interface AdTrackingSettings {
  orgId: Types.ObjectId;
  consent: ConsentMode;
}

export const adTrackingSettingsSchema = tenantSchema<AdTrackingSettings>({
  consent: { type: String, enum: CONSENT_MODES, default: 'off' },
});
adTrackingSettingsSchema.path('orgId').index(false);
uniquePerTenant(adTrackingSettingsSchema);

/** How long the browser details of an order are kept for a purchase counted on delivery. */
export const ORDER_CONTEXT_DAYS = 35;

/**
 * What the shopper's browser knew when an order was placed on a store or landing page, kept
 * only to send that order's purchase (also when it counts on delivery). Removed by MongoDB
 * after ORDER_CONTEXT_DAYS.
 */
export interface AdOrderContext {
  orgId: Types.ObjectId;
  orderId: Types.ObjectId;
  consent: boolean;
  url?: string;
  referrer?: string;
  ip?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
  ttp?: string;
  gaClientId?: string;
  gaSessionId?: string;
  visitorId?: string;
}

export const adOrderContextSchema = tenantSchema<AdOrderContext>({
  orderId: { type: Schema.Types.ObjectId, required: true },
  consent: { type: Boolean, required: true },
  url: String,
  referrer: String,
  ip: String,
  userAgent: String,
  fbp: String,
  fbc: String,
  ttp: String,
  gaClientId: String,
  gaSessionId: String,
  visitorId: String,
});
adOrderContextSchema.index({ orgId: 1, orderId: 1 }, { unique: true });
adOrderContextSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: ORDER_CONTEXT_DAYS * 24 * 3600 },
);

export const AD_SENT_STATUSES = ['sent', 'failed'] as const;
export type AdSentStatus = (typeof AD_SENT_STATUSES)[number];
export const AD_EVENT_SOURCES = ['browser', 'order', 'test'] as const;
export type AdEventSource = (typeof AD_EVENT_SOURCES)[number];

/** How long the event log keeps a line. */
export const EVENT_LOG_DAYS = 14;

/**
 * One server event and what the platform answered (no shopper details), for the event log
 * in Settings › Ad tracking. Removed by MongoDB after EVENT_LOG_DAYS.
 */
export interface AdEventLog {
  orgId: Types.ObjectId;
  destinationId: Types.ObjectId;
  platform: AdPlatform;
  event: AdEventName;
  eventId: string;
  source: AdEventSource;
  orderId?: Types.ObjectId;
  orderNumber?: string;
  status: AdSentStatus;
  detail: string;
}

export const adEventLogSchema = tenantSchema<AdEventLog>({
  destinationId: { type: Schema.Types.ObjectId, required: true },
  platform: { type: String, enum: AD_PLATFORMS, required: true },
  event: { type: String, enum: AD_EVENT_NAMES, required: true },
  eventId: { type: String, required: true },
  source: { type: String, enum: AD_EVENT_SOURCES, required: true },
  orderId: Schema.Types.ObjectId,
  orderNumber: String,
  status: { type: String, enum: AD_SENT_STATUSES, required: true },
  detail: { type: String, default: '' },
});
adEventLogSchema.index({ orgId: 1, createdAt: -1 });
adEventLogSchema.index({ orgId: 1, destinationId: 1, createdAt: -1 });
adEventLogSchema.index({ orgId: 1, orderId: 1, destinationId: 1, event: 1, status: 1 });
adEventLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: EVENT_LOG_DAYS * 24 * 3600 });
