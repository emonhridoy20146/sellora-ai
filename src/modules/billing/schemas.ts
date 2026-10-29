import { Schema, type Types } from 'mongoose';
import { platformSchema, tenantSchema } from '../../infra/database/schema-helpers.js';
import {
  BILLING_INTERVALS,
  FEATURE_MODULE_KEYS,
  type BillingInterval,
  type FeatureModule,
  type PlanLimits,
} from './feature-modules.js';

const limitsDefinition = {
  seats: { type: Number, default: null },
  stores: { type: Number, default: null },
  customDomains: { type: Number, default: null },
  products: { type: Number, default: null },
  channels: { type: Number, default: null },
  ordersPerMonth: { type: Number, default: null },
  conversationsPerMonth: { type: Number, default: null },
  landingPages: { type: Number, default: null },
  storageMb: { type: Number, default: null },
};
const limitsSchema = new Schema(limitsDefinition, { _id: false, strict: 'throw' });

export interface PlanPrice {
  interval: BillingInterval;
  currency: string;
  amountMinor: number;
}

/** A sellable plan. Prices and contents are set by the super-admin. */
export interface Plan {
  code: string;
  name: string;
  description: string;
  modules: FeatureModule[];
  limits: PlanLimits;
  prices: PlanPrice[];
  includedCreditsPerMonth: number;
  isPublic: boolean;
  isActive: boolean;
  trialEligible: boolean;
  highlight: boolean;
  sortOrder: number;
  version: number;
  updatedBy?: string;
}

export const planSchema = platformSchema<Plan>(
  {
    code: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    modules: { type: [{ type: String, enum: FEATURE_MODULE_KEYS }], default: [] },
    limits: { type: limitsSchema, default: () => ({}) },
    prices: {
      type: [
        new Schema(
          {
            interval: { type: String, enum: BILLING_INTERVALS, required: true },
            currency: { type: String, required: true },
            amountMinor: { type: Number, required: true, min: 0 },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: [],
    },
    includedCreditsPerMonth: { type: Number, default: 0, min: 0 },
    isPublic: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    trialEligible: { type: Boolean, default: true },
    highlight: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    updatedBy: String,
  },
  { collection: 'plans' },
);
planSchema.index({ code: 1 }, { unique: true });

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';

export interface EntitlementOverrides {
  addModules: FeatureModule[];
  removeModules: FeatureModule[];
  limits: Partial<PlanLimits>;
  note?: string;
  expiresAt?: Date;
}

/** The business's current plan, with a snapshot of what it bought. One per business. */
export interface Subscription {
  orgId: Types.ObjectId;
  planId: Types.ObjectId;
  planCode: string;
  planName: string;
  planVersion: number;
  status: SubscriptionStatus;
  interval: BillingInterval | 'trial';
  currency: string;
  priceMinor: number;
  modules: FeatureModule[];
  limits: PlanLimits;
  includedCreditsPerMonth: number;
  currentPeriodStart: Date;
  currentPeriodEnd?: Date;
  trialEndsAt?: Date;
  pastDueSince?: Date;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  source: 'trial' | 'wallet' | 'gateway' | 'platform' | 'free';
  overrides: EntitlementOverrides;
  /** When the next batch of included AI credits is due (monthly, also on yearly plans). */
  nextCreditGrantAt?: Date;
  lastCreditGrant?: { amountMinor: number; at: Date };
}

export const subscriptionSchema = tenantSchema<Subscription>(
  {
    planId: { type: Schema.Types.ObjectId, required: true },
    planCode: { type: String, required: true },
    planName: { type: String, required: true },
    planVersion: { type: Number, required: true },
    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'canceled', 'expired'],
      required: true,
    },
    interval: { type: String, enum: [...BILLING_INTERVALS, 'trial'], required: true },
    currency: { type: String, required: true },
    priceMinor: { type: Number, required: true, min: 0 },
    modules: { type: [String], default: [] },
    limits: { type: limitsSchema, default: () => ({}) },
    includedCreditsPerMonth: { type: Number, default: 0 },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: Date,
    trialEndsAt: Date,
    pastDueSince: Date,
    autoRenew: { type: Boolean, default: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    canceledAt: Date,
    source: {
      type: String,
      enum: ['trial', 'wallet', 'gateway', 'platform', 'free'],
      required: true,
    },
    overrides: {
      type: new Schema(
        {
          addModules: { type: [String], default: [] },
          removeModules: { type: [String], default: [] },
          limits: {
            type: new Schema(limitsDefinition, { _id: false, strict: 'throw' }),
            default: () => ({}),
          },
          note: String,
          expiresAt: Date,
        },
        { _id: false, strict: 'throw' },
      ),
      default: () => ({ addModules: [], removeModules: [], limits: {} }),
    },
    nextCreditGrantAt: Date,
    lastCreditGrant: {
      type: new Schema({ amountMinor: Number, at: Date }, { _id: false, strict: 'throw' }),
    },
  },
  { collection: 'subscriptions' },
);
// One subscription per business: replace the default orgId index with a unique one.
subscriptionSchema.path('orgId').index(false);
subscriptionSchema.index({ orgId: 1 }, { unique: true });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
subscriptionSchema.index({ status: 1, trialEndsAt: 1 });
subscriptionSchema.index({ nextCreditGrantAt: 1 });

/** Prepaid balance used for AI credits and plan payments. Amounts in minor units. */
export interface Wallet {
  orgId: Types.ObjectId;
  currency: string;
  balanceMinor: number;
  heldMinor: number;
  /** Part of the balance that came from free credits; spent first, never withdrawable. */
  bonusMinor: number;
  lifetimeTopupMinor: number;
  lifetimeSpentMinor: number;
  status: 'active' | 'frozen';
  lowBalanceThresholdMinor: number;
  lowBalanceNotifiedAt?: Date;
}

export const walletSchema = tenantSchema<Wallet>(
  {
    currency: { type: String, required: true },
    balanceMinor: { type: Number, default: 0 },
    heldMinor: { type: Number, default: 0, min: 0 },
    bonusMinor: { type: Number, default: 0, min: 0 },
    lifetimeTopupMinor: { type: Number, default: 0 },
    lifetimeSpentMinor: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'frozen'], default: 'active' },
    lowBalanceThresholdMinor: { type: Number, default: 10_000 },
    lowBalanceNotifiedAt: Date,
  },
  { collection: 'wallets' },
);
// One wallet per business: replace the default orgId index with a unique one.
walletSchema.path('orgId').index(false);
walletSchema.index({ orgId: 1 }, { unique: true });

export const LEDGER_TYPES = [
  'topup',
  'ai_usage',
  'sms_usage',
  'subscription',
  'refund',
  'adjustment',
  'withdrawal',
  'bonus',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** Append-only wallet history. Every balance change has exactly one entry. */
export interface LedgerEntry {
  orgId: Types.ObjectId;
  type: LedgerType;
  amountMinor: number;
  balanceAfterMinor: number;
  currency: string;
  idempotencyKey: string;
  description: string;
  reference?: { type: string; id: string };
  credits?: number;
  actor: { type: string; id: string };
  metadata: Record<string, unknown>;
}

export const ledgerEntrySchema = tenantSchema<LedgerEntry>(
  {
    type: { type: String, enum: LEDGER_TYPES, required: true },
    amountMinor: { type: Number, required: true },
    balanceAfterMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    description: { type: String, required: true },
    reference: { type: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }) },
    credits: Number,
    actor: {
      type: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }),
      required: true,
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'wallet_ledger', timestamps: { createdAt: true, updatedAt: false } },
);
ledgerEntrySchema.index({ orgId: 1, idempotencyKey: 1 }, { unique: true });
ledgerEntrySchema.index({ orgId: 1, createdAt: -1 });
ledgerEntrySchema.index({ orgId: 1, type: 1, createdAt: -1 });
