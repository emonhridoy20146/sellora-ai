import { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { COURIER_KEYS } from './courier.types.js';

const text = (max: number) => z.string().trim().max(max);
const name = z.string().trim().min(1).max(60);
const positiveId = z.number().int().positive().max(2_147_483_647);
const courierRef = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use the id exactly as the courier shows it');

/** Field names and rules differ per courier; the courier's adapter validates the values. */
const credentials = z.record(z.string().max(40), z.string().max(4000));

const deliveryType = text(30);
const storeId = z.string().regex(/^\d{1,20}$/, 'Invalid store id');

const settings = z
  .object({ deliveryType: deliveryType.optional(), storeId: storeId.optional() })
  .strict();

/** On update a missing key keeps the saved value and null clears it. */
const settingsPatch = z
  .object({
    deliveryType: deliveryType.nullable().optional(),
    storeId: storeId.nullable().optional(),
  })
  .strict();

const weight = z.number().int().min(1).max(100_000);

export const createAccountBody = z
  .object({
    provider: z.enum(COURIER_KEYS),
    name,
    credentials,
    sandbox: z.boolean().optional(),
    settings: settings.optional(),
    defaultWeightGrams: weight.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const updateAccountBody = z
  .object({
    name: name.optional(),
    credentials: credentials.optional(),
    sandbox: z.boolean().optional(),
    settings: settingsPatch.optional(),
    defaultWeightGrams: weight.optional(),
    enabled: z.boolean().optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict();

export const locationsQuery = z.object({
  kind: z.enum(['city', 'zone', 'area']),
  parent: z.coerce.number().int().positive().optional(),
  q: text(60).optional(),
});

const location = z
  .object({
    cityId: positiveId.optional(),
    cityName: text(80).optional(),
    zoneId: positiveId.optional(),
    zoneName: text(80).optional(),
    areaId: positiveId.optional(),
    areaName: text(120).optional(),
  })
  .strict();

export const bookParcelBody = z
  .object({
    accountId: objectIdSchema.optional(),
    /** Cash to collect; defaults to what the customer still owes. */
    codMinor: z.number().int().min(0).max(100_000_000).optional(),
    weightGrams: weight.optional(),
    note: text(250).optional(),
    location: location.optional(),
  })
  .strict();

export const bulkBookBody = z
  .object({
    orderIds: z.array(objectIdSchema).min(1).max(100),
    accountId: objectIdSchema.optional(),
    weightGrams: weight.optional(),
    note: text(250).optional(),
  })
  .strict();

export const cancelParcelBody = z.object({ note: text(200).optional() }).strict();

export const linkParcelBody = z
  .object({ consignmentId: courierRef, trackingCode: courierRef.optional() })
  .strict();

export const webhookKey = z.string().regex(/^cw_[A-Za-z0-9_-]{32}$/);
