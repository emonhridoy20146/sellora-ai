import { Schema, type Types } from 'mongoose';
import { tenantSchema, uniquePerTenant } from '../../infra/database/schema-helpers.js';
import type { SmsLanguage } from '../sms/templates.js';
import type { CartStep, QuietHours } from './cart-templates.js';

export const CART_SOURCES = ['store', 'landing_page'] as const;
export type CartSource = (typeof CART_SOURCES)[number];
export const CART_STATUSES = ['open', 'ordered', 'dismissed'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

/** Why a due reminder did not go out (the latest reason is kept on the cart). */
export const CART_SKIPS = [
  'reminders_off',
  'not_in_plan',
  'quiet_hours',
  'recent_reminder',
  'below_minimum',
  'sms_off',
  'opted_out',
] as const;
export type CartSkip = (typeof CART_SKIPS)[number];

export interface CartLine {
  productId: string;
  variantId: string;
  quantity: number;
  name: string;
  variantTitle: string;
  unitPriceMinor: number;
}

/** A landing page cart: what the shopper chose on the order form. */
export interface LandingSelection {
  packageId: string | null;
  variantId: string;
  quantity: number;
  addOn: boolean;
}

export interface CartReminder {
  /** The step (1 or 2), or 0 for one staff sent by hand. */
  step: number;
  manual: boolean;
  at: Date;
  messageId?: string;
  /** Set when the SMS layer wrote nothing (SMS off, or the number opted out meanwhile). */
  skipped?: 'off' | 'opted_out';
  by?: string;
}

/** A cart a shopper left with a phone number, saved for reminders (ADR 0018). */
export interface Cart {
  orgId: Types.ObjectId;
  source: CartSource;
  storeId: Types.ObjectId;
  storeName: string;
  /** The store's address when the cart was last saved; the reminder link starts with it. */
  baseUrl: string;
  landingPage?: { id: string; name: string; slug: string };
  /** Random value from the shopper's browser; later saves with it update this cart. */
  token: string;
  /** In the reminder link (`<store>/r/<code>`); unique across Sellora. */
  code: string;
  phone: string;
  name: string;
  items: CartLine[];
  selection?: LandingSelection;
  totalMinor: number;
  currency: string;
  status: CartStatus;
  lastActivityAt: Date;
  /** Index into the enabled steps of the next automatic reminder. */
  nextStep: number;
  /** When the sweep should look at this cart next; null when nothing is planned. */
  nextReminderAt: Date | null;
  reminders: CartReminder[];
  lastReminderAt?: Date;
  manualReminders: number;
  lastSkip?: { reason: CartSkip; at: Date };
  clicks: number;
  lastClickAt?: Date;
  order?: { id: string; number: string; totalMinor: number; at: Date };
  recovered: boolean;
  expiresAt: Date;
}

const lineSchema = new Schema<CartLine>(
  {
    productId: { type: String, required: true },
    variantId: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    name: { type: String, required: true },
    variantTitle: { type: String, default: '' },
    unitPriceMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false, strict: 'throw' },
);

const reminderSchema = new Schema<CartReminder>(
  {
    step: { type: Number, required: true, min: 0 },
    manual: { type: Boolean, default: false },
    at: { type: Date, required: true },
    messageId: String,
    skipped: { type: String, enum: ['off', 'opted_out'] },
    by: String,
  },
  { _id: false, strict: 'throw' },
);

export const cartSchema = tenantSchema<Cart>({
  source: { type: String, enum: CART_SOURCES, required: true },
  storeId: { type: Schema.Types.ObjectId, required: true },
  storeName: { type: String, required: true },
  baseUrl: { type: String, required: true },
  landingPage: {
    type: new Schema({ id: String, name: String, slug: String }, { _id: false, strict: 'throw' }),
    default: undefined,
  },
  token: { type: String, required: true },
  code: { type: String, required: true },
  phone: { type: String, required: true },
  name: { type: String, default: '' },
  items: { type: [lineSchema], default: [] },
  selection: {
    type: new Schema(
      { packageId: String, variantId: String, quantity: Number, addOn: Boolean },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  totalMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true },
  status: { type: String, enum: CART_STATUSES, default: 'open' },
  lastActivityAt: { type: Date, required: true },
  nextStep: { type: Number, default: 0, min: 0 },
  nextReminderAt: { type: Date, default: null },
  reminders: { type: [reminderSchema], default: [] },
  lastReminderAt: Date,
  manualReminders: { type: Number, default: 0, min: 0 },
  lastSkip: {
    type: new Schema(
      { reason: { type: String, enum: CART_SKIPS }, at: Date },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  clicks: { type: Number, default: 0, min: 0 },
  lastClickAt: Date,
  order: {
    type: new Schema(
      { id: String, number: String, totalMinor: Number, at: Date },
      { _id: false, strict: 'throw' },
    ),
    default: undefined,
  },
  recovered: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
});
cartSchema.index({ orgId: 1, token: 1 }, { unique: true });
cartSchema.index({ code: 1 }, { unique: true });
cartSchema.index({ orgId: 1, status: 1, phone: 1 });
cartSchema.index({ orgId: 1, phone: 1, lastReminderAt: -1 });
cartSchema.index({ orgId: 1, _id: -1 });
cartSchema.index({ orgId: 1, status: 1, recovered: 1, _id: -1 });
// The sweep: due carts across businesses.
cartSchema.index(
  { nextReminderAt: 1 },
  { partialFilterExpression: { status: 'open', nextReminderAt: { $type: 'date' } } },
);
cartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** One per business: whether carts are saved and when and what the reminders say. */
export interface CartSettings {
  orgId: Types.ObjectId;
  enabled: boolean;
  language: SmsLanguage;
  steps: CartStep[];
  /** Carts below this total get no reminder (0 = any cart). */
  minTotalMinor: number;
  quietHours: QuietHours;
}

const stepSchema = new Schema<CartStep>(
  {
    enabled: { type: Boolean, default: false },
    delayMinutes: { type: Number, required: true },
    text: { type: String, default: '' },
  },
  { _id: false, strict: 'throw' },
);

export const cartSettingsSchema = tenantSchema<CartSettings>({
  enabled: { type: Boolean, default: false },
  language: { type: String, enum: ['en', 'bn'], default: 'en' },
  steps: { type: [stepSchema], default: [] },
  minTotalMinor: { type: Number, default: 0, min: 0 },
  quietHours: {
    type: new Schema(
      {
        enabled: { type: Boolean, default: true },
        startHour: { type: Number, default: 22, min: 0, max: 23 },
        endHour: { type: Number, default: 9, min: 0, max: 23 },
      },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
});
uniquePerTenant(cartSettingsSchema);
