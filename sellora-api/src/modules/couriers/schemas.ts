import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import { SHIPMENT_STATUSES, type ShipmentStatus } from '../commerce/schemas.js';
import {
  COURIER_KEYS,
  type CourierKey,
  type CourierSettings,
  type ParcelLocation,
} from './courier.types.js';

/**
 * A business's account with a courier. Credentials are encrypted (AES-256-GCM, bound to the
 * account id) and never returned by the API. `webhookKey` names the account in its webhook
 * address; the webhook secret proves the courier sent it (where the courier supports one).
 */
export interface CourierAccount {
  orgId: Types.ObjectId;
  provider: CourierKey;
  name: string;
  /** Used when staff book without choosing an account. One per business. */
  isDefault: boolean;
  /** Off: no new bookings; parcels already booked are still tracked. */
  enabled: boolean;
  /** error: the courier refused the credentials the last time they were used. */
  status: 'active' | 'error';
  statusReason?: string;
  sandbox: boolean;
  credentialsEnc: string;
  /** A non-secret hint to recognise the credentials (masked key, username). */
  credentialsHint: string;
  settings: CourierSettings;
  defaultWeightGrams: number;
  webhookKey: string;
  webhookSecretEnc: string;
  lastCheck?: { at: Date; ok: boolean; summary: string };
  lastWebhookAt?: Date;
  createdBy?: Types.ObjectId;
}

export const courierAccountSchema = tenantSchema<CourierAccount>({
  provider: { type: String, enum: COURIER_KEYS, required: true },
  name: { type: String, required: true, trim: true },
  isDefault: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
  status: { type: String, enum: ['active', 'error'], default: 'active' },
  statusReason: String,
  sandbox: { type: Boolean, default: false },
  credentialsEnc: { type: String, required: true },
  credentialsHint: { type: String, default: '' },
  settings: {
    type: new Schema(
      { deliveryType: String, storeId: String, storeName: String },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  defaultWeightGrams: { type: Number, default: 500, min: 1 },
  webhookKey: { type: String, required: true },
  webhookSecretEnc: { type: String, required: true },
  lastCheck: new Schema(
    { at: Date, ok: Boolean, summary: String },
    { _id: false, strict: 'throw' },
  ),
  lastWebhookAt: Date,
  createdBy: Schema.Types.ObjectId,
});
courierAccountSchema.index({ webhookKey: 1 }, { unique: true });
courierAccountSchema.index(
  { orgId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

export const PARCEL_EVENT_SOURCES = ['booking', 'poll', 'webhook', 'staff', 'system'] as const;
export type ParcelEventSource = (typeof PARCEL_EVENT_SOURCES)[number];

export interface ParcelEvent {
  at: Date;
  status: ShipmentStatus;
  /** The courier's own word, when the event came from the courier. */
  providerStatus?: string;
  source: ParcelEventSource;
  note?: string;
}

/**
 * One booking of an order with a courier. An order has at most one `current` parcel; a
 * cancelled or refused booking stops being current, so the order can be booked again (with
 * a new invoice: the order number plus -2, -3).
 */
export interface Parcel {
  orgId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  accountId: Types.ObjectId;
  provider: CourierKey;
  accountName: string;
  invoice: string;
  attempt: number;
  status: ShipmentStatus;
  current: boolean;
  providerStatus?: string;
  consignmentId?: string;
  trackingCode?: string;
  recipient: { name: string; phone: string; altPhone?: string; address: string };
  codMinor: number;
  valueMinor: number;
  weightGrams: number;
  quantity: number;
  description: string;
  note?: string;
  location?: ParcelLocation;
  deliveryFeeMinor?: number;
  /** Why the courier refused the booking. */
  error?: string;
  /** Something staff should look at. Cleared when they act or the order settles. */
  attention?: string;
  events: ParcelEvent[];
  bookedAt?: Date;
  sendStartedAt?: Date;
  lastCheckedAt?: Date;
  /** When the tracking job should ask the courier again; unset once the parcel is settled. */
  nextCheckAt?: Date;
  checkFailures: number;
  createdBy: { type: string; id: string };
}

const locationSchema = new Schema<ParcelLocation>(
  {
    cityId: Number,
    cityName: String,
    zoneId: Number,
    zoneName: String,
    areaId: Number,
    areaName: String,
  },
  { _id: false, strict: 'throw' },
);

export const parcelSchema = tenantSchema<Parcel>({
  orderId: { type: Schema.Types.ObjectId, required: true },
  orderNumber: { type: String, required: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  provider: { type: String, enum: COURIER_KEYS, required: true },
  accountName: { type: String, required: true },
  invoice: { type: String, required: true },
  attempt: { type: Number, required: true, min: 1 },
  status: { type: String, enum: SHIPMENT_STATUSES, required: true },
  current: { type: Boolean, required: true },
  providerStatus: String,
  consignmentId: String,
  trackingCode: String,
  recipient: new Schema(
    {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      altPhone: String,
      address: { type: String, required: true },
    },
    { _id: false, strict: 'throw' },
  ),
  codMinor: { type: Number, required: true, min: 0 },
  valueMinor: { type: Number, required: true, min: 0 },
  weightGrams: { type: Number, required: true, min: 1 },
  quantity: { type: Number, required: true, min: 1 },
  description: { type: String, default: '' },
  note: String,
  location: locationSchema,
  deliveryFeeMinor: Number,
  error: String,
  attention: String,
  events: {
    type: [
      new Schema<ParcelEvent>(
        {
          at: { type: Date, required: true },
          status: { type: String, enum: SHIPMENT_STATUSES, required: true },
          providerStatus: String,
          source: { type: String, enum: PARCEL_EVENT_SOURCES, required: true },
          note: String,
        },
        { _id: false, strict: 'throw' },
      ),
    ],
    default: [],
  },
  bookedAt: Date,
  sendStartedAt: Date,
  lastCheckedAt: Date,
  nextCheckAt: Date,
  checkFailures: { type: Number, default: 0 },
  createdBy: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }),
});
parcelSchema.index({ orgId: 1, orderId: 1, createdAt: -1 });
parcelSchema.index(
  { orgId: 1, orderId: 1 },
  { unique: true, partialFilterExpression: { current: true }, name: 'one_current_parcel' },
);
parcelSchema.index({ orgId: 1, invoice: 1 }, { unique: true });
parcelSchema.index({ orgId: 1, accountId: 1, consignmentId: 1 });
parcelSchema.index({ orgId: 1, accountId: 1, trackingCode: 1 });
parcelSchema.index({ orgId: 1, accountId: 1, status: 1 });
// The tracking job scans every business for parcels that are due.
parcelSchema.index(
  { nextCheckAt: 1 },
  { partialFilterExpression: { nextCheckAt: { $type: 'date' } } },
);

/** Statuses the courier still moves on its own, so tracking keeps asking. */
export const TRACKED_STATUSES: readonly ShipmentStatus[] = [
  'booked',
  'picked_up',
  'in_transit',
  'on_hold',
  'returning',
];
