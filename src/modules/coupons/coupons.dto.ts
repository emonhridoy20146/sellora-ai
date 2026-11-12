import { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { COUPON_KINDS, COUPON_LANDING_SCOPES, MAX_PERCENT } from './coupon-rules.js';

const money = z.number().int().min(1).max(100_000_000);
const when = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time')
  .nullable();

const fields = {
  note: z.string().trim().max(120).optional(),
  percent: z.number().int().min(1).max(MAX_PERCENT).nullable().optional(),
  amountMinor: money.nullable().optional(),
  maxDiscountMinor: money.nullable().optional(),
  minOrderMinor: z.number().int().min(0).max(100_000_000).optional(),
  startsAt: when.optional(),
  endsAt: when.optional(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  perCustomerLimit: z.number().int().min(1).max(1000).nullable().optional(),
  store: z.boolean().optional(),
  landing: z.enum(COUPON_LANDING_SCOPES).optional(),
  landingPageIds: z.array(objectIdSchema).max(200).optional(),
  active: z.boolean().optional(),
};

export const createCouponBody = z
  .object({ code: z.string().trim().min(1).max(40), kind: z.enum(COUPON_KINDS), ...fields })
  .strict();

export const updateCouponBody = z
  .object({
    code: z.string().trim().min(1).max(40).optional(),
    kind: z.enum(COUPON_KINDS).optional(),
    ...fields,
  })
  .strict();

/** A shopper's code in the storefront (store checkout or a landing page's order form). */
export const couponCodeSchema = z.string().trim().min(1).max(40);
