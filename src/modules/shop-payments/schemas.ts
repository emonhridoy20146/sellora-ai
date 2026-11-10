import { Schema, type Types } from 'mongoose';
import { tenantSchema, uniquePerTenant } from '../../infra/database/schema-helpers.js';
import { SHOP_GATEWAYS, type ShopGatewayKey } from '../commerce/schemas.js';

/**
 * A business's own merchant account with a payment gateway, for shoppers paying at checkout
 * (ADR 0029). One per gateway per business. Credentials are encrypted (AES-256-GCM, bound to
 * the account id) and never returned by the API.
 */
export interface ShopPaymentAccount {
  orgId: Types.ObjectId;
  gateway: ShopGatewayKey;
  /** Off: not offered to shoppers. Payments already started still finish. */
  enabled: boolean;
  sandbox: boolean;
  credentialsEnc: string;
  credentialsHint: string;
  /** The last check with the gateway; `checked: false` when the gateway has no way to. */
  lastCheck: { at: Date; checked: boolean; summary: string };
  /** The last payment start the gateway refused, until one works again. */
  lastError?: { at: Date; message: string };
  lastPaymentAt?: Date;
  createdBy?: Types.ObjectId;
}

export const shopPaymentAccountSchema = tenantSchema<ShopPaymentAccount>({
  gateway: { type: String, enum: SHOP_GATEWAYS, required: true },
  enabled: { type: Boolean, default: true },
  sandbox: { type: Boolean, default: false },
  credentialsEnc: { type: String, required: true },
  credentialsHint: { type: String, default: '' },
  lastCheck: {
    type: new Schema(
      { at: Date, checked: Boolean, summary: String },
      { _id: false, strict: 'throw' },
    ),
    required: true,
  },
  lastError: new Schema({ at: Date, message: String }, { _id: false, strict: 'throw' }),
  lastPaymentAt: Date,
  createdBy: Schema.Types.ObjectId,
});
shopPaymentAccountSchema.index({ orgId: 1, gateway: 1 }, { unique: true });

export const ADVANCE_MODES = ['off', 'delivery', 'fixed', 'percent'] as const;
export type AdvanceMode = (typeof ADVANCE_MODES)[number];

/** How shoppers may pay at checkout, one per business (ADR 0029). */
export interface ShopPaymentSettings {
  orgId: Types.ObjectId;
  /** Cash on delivery offered. Always offered while no gateway is switched on. */
  cod: boolean;
  /** Paying the whole order online offered (with a switched-on gateway). */
  fullOnline: boolean;
  advance: {
    mode: AdvanceMode;
    fixedMinor: number;
    percent: number;
    /** Only for these delivery areas; empty means every area. */
    zoneIds: string[];
    /** Only from this order total; 0 means every order. */
    minTotalMinor: number;
  };
}

export const shopPaymentSettingsSchema = tenantSchema<ShopPaymentSettings>({
  cod: { type: Boolean, default: true },
  fullOnline: { type: Boolean, default: true },
  advance: {
    type: new Schema(
      {
        mode: { type: String, enum: ADVANCE_MODES, default: 'off' },
        fixedMinor: { type: Number, default: 0, min: 0 },
        percent: { type: Number, default: 0, min: 0, max: 100 },
        zoneIds: { type: [String], default: [] },
        minTotalMinor: { type: Number, default: 0, min: 0 },
      },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
});
shopPaymentSettingsSchema.path('orgId').index(false);
uniquePerTenant(shopPaymentSettingsSchema);

export const SHOP_PAYMENT_STATUSES = ['started', 'succeeded', 'failed', 'cancelled'] as const;
export type ShopPaymentStatus = (typeof SHOP_PAYMENT_STATUSES)[number];

/**
 * One attempt by a shopper to pay an order online (ADR 0029). `ref` is our id for it at the
 * gateway; `sessionId` the gateway's. `settled` is true once the gateway itself gave a final
 * answer; until then the worker keeps asking (a cancel the browser reported is not final).
 */
export interface ShopPayment {
  orgId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  ref: string;
  gateway: ShopGatewayKey;
  accountId: Types.ObjectId;
  sandbox: boolean;
  purpose: 'full' | 'advance';
  amountMinor: number;
  currency: string;
  status: ShopPaymentStatus;
  settled: boolean;
  sessionId?: string;
  gatewayRef?: string;
  reason?: string;
  /** Where the shopper is sent after the gateway (the receipt or thank-you page). */
  returnUrl: string;
  /** What the gateway answered when it confirmed the payment, without personal data. */
  raw?: Record<string, unknown>;
  verifiedAt?: Date;
  lastCheckedAt?: Date;
}

export const shopPaymentSchema = tenantSchema<ShopPayment>({
  orderId: { type: Schema.Types.ObjectId, required: true },
  orderNumber: { type: String, required: true },
  ref: { type: String, required: true },
  gateway: { type: String, enum: SHOP_GATEWAYS, required: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  sandbox: { type: Boolean, default: false },
  purpose: { type: String, enum: ['full', 'advance'], required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  status: { type: String, enum: SHOP_PAYMENT_STATUSES, default: 'started' },
  settled: { type: Boolean, default: false },
  sessionId: String,
  gatewayRef: String,
  reason: String,
  returnUrl: { type: String, required: true },
  raw: { type: Schema.Types.Mixed },
  verifiedAt: Date,
  lastCheckedAt: Date,
});
shopPaymentSchema.index({ ref: 1 }, { unique: true });
shopPaymentSchema.index({ orgId: 1, orderId: 1, createdAt: -1 });
shopPaymentSchema.index(
  { settled: 1, createdAt: 1 },
  { partialFilterExpression: { settled: false } },
);
