import { Schema, type Types } from 'mongoose';
import { platformSchema, tenantSchema } from '../../infra/database/schema-helpers.js';
import type { BillingInterval } from './feature-modules.js';

export const GATEWAYS = ['sslcommerz', 'bkash', 'stripe', 'manual'] as const;
export type GatewayKey = (typeof GATEWAYS)[number];
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded';

/** A payment the business makes to the platform (wallet top-up or plan purchase). */
export interface Payment {
  orgId: Types.ObjectId;
  purpose: 'wallet_topup' | 'subscription';
  amountMinor: number;
  currency: string;
  gateway: GatewayKey;
  status: PaymentStatus;
  gatewaySessionId?: string;
  gatewayRef?: string;
  /** Where to send the payer to pay (gateway checkout page). */
  checkoutUrl?: string;
  /** Bank transfer, bKash or Nagad send-money the business reports for manual review. */
  manual?: {
    method: 'bkash' | 'nagad' | 'rocket' | 'bank' | 'cash';
    senderAccount: string;
    transactionRef: string;
    note?: string;
  };
  reviewedBy?: string;
  reviewNote?: string;
  idempotencyKey: string;
  plan?: { code: string; interval: BillingInterval };
  createdBy: Types.ObjectId;
  succeededAt?: Date;
  failureReason?: string;
  events: { at: Date; type: string; data: Record<string, unknown> }[];
}

export const paymentSchema = tenantSchema<Payment>(
  {
    purpose: { type: String, enum: ['wallet_topup', 'subscription'], required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    gateway: { type: String, enum: GATEWAYS, required: true },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'canceled', 'refunded'],
      default: 'pending',
    },
    gatewaySessionId: String,
    gatewayRef: String,
    checkoutUrl: String,
    manual: {
      type: new Schema(
        {
          method: {
            type: String,
            enum: ['bkash', 'nagad', 'rocket', 'bank', 'cash'],
            required: true,
          },
          senderAccount: { type: String, required: true },
          transactionRef: { type: String, required: true },
          note: String,
        },
        { _id: false, strict: 'throw' },
      ),
    },
    reviewedBy: String,
    reviewNote: String,
    idempotencyKey: { type: String, required: true },
    plan: { type: new Schema({ code: String, interval: String }, { _id: false, strict: 'throw' }) },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    succeededAt: Date,
    failureReason: String,
    events: {
      type: [
        new Schema(
          { at: Date, type: String, data: Schema.Types.Mixed },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: [],
    },
  },
  { collection: 'payments' },
);
paymentSchema.index({ orgId: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ gateway: 1, gatewaySessionId: 1 });
paymentSchema.index({ orgId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, gateway: 1, createdAt: -1 });
// A transfer reference can be claimed once across the platform, so one payment cannot top up twice.
paymentSchema.index(
  { 'manual.transactionRef': 1, 'manual.method': 1 },
  { unique: true, partialFilterExpression: { 'manual.transactionRef': { $exists: true } } },
);

export type WithdrawalStatus = 'requested' | 'approved' | 'paid' | 'rejected' | 'canceled';

/** A request to take unused wallet money back out. Paid manually after approval. */
export interface Withdrawal {
  orgId: Types.ObjectId;
  amountMinor: number;
  currency: string;
  method: 'bkash' | 'nagad' | 'bank' | 'original_method';
  destination: string;
  status: WithdrawalStatus;
  requestedBy: Types.ObjectId;
  reviewedBy?: string;
  reviewedAt?: Date;
  reviewNote?: string;
  payoutRef?: string;
  paidAt?: Date;
}

export const withdrawalSchema = tenantSchema<Withdrawal>(
  {
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    method: { type: String, enum: ['bkash', 'nagad', 'bank', 'original_method'], required: true },
    destination: { type: String, required: true },
    status: {
      type: String,
      enum: ['requested', 'approved', 'paid', 'rejected', 'canceled'],
      default: 'requested',
    },
    requestedBy: { type: Schema.Types.ObjectId, required: true },
    reviewedBy: String,
    reviewedAt: Date,
    reviewNote: String,
    payoutRef: String,
    paidAt: Date,
  },
  { collection: 'withdrawals' },
);
withdrawalSchema.index({ orgId: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: 1 });

/** Invoice / receipt for anything the business paid the platform. */
export interface Invoice {
  orgId: Types.ObjectId;
  number: string;
  kind: 'subscription' | 'wallet_topup';
  currency: string;
  lines: { description: string; quantity: number; unitMinor: number; totalMinor: number }[];
  subtotalMinor: number;
  taxMinor: number;
  taxRateBps: number;
  totalMinor: number;
  paidWith: 'wallet' | 'sslcommerz' | 'bkash' | 'stripe' | 'manual';
  paymentId?: Types.ObjectId;
  issuedAt: Date;
  billTo: { name: string; email?: string; address?: string };
}

export const invoiceSchema = tenantSchema<Invoice>(
  {
    number: { type: String, required: true },
    kind: { type: String, enum: ['subscription', 'wallet_topup'], required: true },
    currency: { type: String, required: true },
    lines: {
      type: [
        new Schema(
          { description: String, quantity: Number, unitMinor: Number, totalMinor: Number },
          { _id: false, strict: 'throw' },
        ),
      ],
      required: true,
    },
    subtotalMinor: { type: Number, required: true },
    taxMinor: { type: Number, required: true },
    taxRateBps: { type: Number, required: true },
    totalMinor: { type: Number, required: true },
    paidWith: { type: String, required: true },
    paymentId: Schema.Types.ObjectId,
    issuedAt: { type: Date, required: true },
    billTo: {
      type: new Schema(
        { name: String, email: String, address: String },
        { _id: false, strict: 'throw' },
      ),
      required: true,
    },
  },
  { collection: 'invoices' },
);
invoiceSchema.index({ number: 1 }, { unique: true });
invoiceSchema.index({ orgId: 1, issuedAt: -1 });

/** Gateway credentials, encrypted, managed by the super-admin. */
export interface GatewayConfig {
  _id: GatewayKey;
  enabled: boolean;
  sandbox: boolean;
  credentialsEnc: string;
  updatedBy: string;
}

export const gatewayConfigSchema = platformSchema<GatewayConfig>(
  {
    _id: { type: String, enum: GATEWAYS, required: true },
    enabled: { type: Boolean, default: false },
    sandbox: { type: Boolean, default: true },
    credentialsEnc: { type: String, required: true },
    updatedBy: { type: String, required: true },
  },
  { collection: 'payment_gateways' },
);
