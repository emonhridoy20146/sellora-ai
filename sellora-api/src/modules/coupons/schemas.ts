import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import {
  COUPON_KINDS,
  COUPON_LANDING_SCOPES,
  type CouponKind,
  type CouponLandingScope,
} from './coupon-rules.js';

/**
 * A discount code a shopper types at store checkout or in a landing page's order form
 * (ADR 0031). `used` counts orders that used it and were not cancelled or returned.
 */
export interface Coupon {
  orgId: Types.ObjectId;
  /** Upper case, unique per business. */
  code: string;
  /** The business's own note ("Eid campaign"); shoppers never see it. */
  note: string;
  kind: CouponKind;
  percent?: number;
  amountMinor?: number;
  /** Percent coupons: the most they take off. */
  maxDiscountMinor?: number;
  /** Goods (after package savings) must cost at least this. 0 for no minimum. */
  minOrderMinor: number;
  startsAt?: Date;
  endsAt?: Date;
  /** Orders that may use it in all; unset for no limit. */
  usageLimit?: number;
  /** Orders one phone number may use it for; unset for no limit. */
  perCustomerLimit?: number;
  store: boolean;
  landing: CouponLandingScope;
  landingPageIds: Types.ObjectId[];
  active: boolean;
  used: number;
  /** Total taken off orders that used it (kept with `used`). */
  discountGivenMinor: number;
  createdBy?: Types.ObjectId;
}

export const couponSchema = tenantSchema<Coupon>({
  code: { type: String, required: true, uppercase: true, maxlength: 20 },
  note: { type: String, default: '', maxlength: 120 },
  kind: { type: String, enum: COUPON_KINDS, required: true },
  percent: { type: Number, min: 1, max: 90 },
  amountMinor: { type: Number, min: 1 },
  maxDiscountMinor: { type: Number, min: 1 },
  minOrderMinor: { type: Number, default: 0, min: 0 },
  startsAt: Date,
  endsAt: Date,
  usageLimit: { type: Number, min: 1 },
  perCustomerLimit: { type: Number, min: 1 },
  store: { type: Boolean, default: true },
  landing: { type: String, enum: COUPON_LANDING_SCOPES, default: 'all' },
  landingPageIds: { type: [Schema.Types.ObjectId], default: [] },
  active: { type: Boolean, default: true },
  used: { type: Number, default: 0, min: 0 },
  discountGivenMinor: { type: Number, default: 0, min: 0 },
  createdBy: Schema.Types.ObjectId,
});
couponSchema.index({ orgId: 1, code: 1 }, { unique: true });
couponSchema.index({ orgId: 1, createdAt: -1 });

/** How many orders one phone number used a coupon for (the per-customer limit). */
export interface CouponUse {
  orgId: Types.ObjectId;
  couponId: Types.ObjectId;
  phone: string;
  count: number;
}

export const couponUseSchema = tenantSchema<CouponUse>(
  {
    couponId: { type: Schema.Types.ObjectId, required: true },
    phone: { type: String, required: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { collection: 'coupon_uses' },
);
couponUseSchema.index({ couponId: 1, phone: 1 }, { unique: true });
