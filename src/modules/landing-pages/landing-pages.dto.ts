import { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { cartToken } from '../carts/carts.dto.js';
import { attribution } from '../stores/stores.dto.js';
import { LANDING_LANGUAGES, landingContentSchema, MAX_FREE_QUANTITY } from './blocks.js';
import { REVIEW_FILTERS } from './landing-review.service.js';
import { TEMPLATE_KEYS } from './templates.js';
import { paymentChoice } from '../shop-payments/shop-payments.dto.js';

const text = (max: number) => z.string().trim().max(max);
/** Checked in full by the service (format and reserved words); this only bounds the size. */
const slug = z.string().trim().toLowerCase().min(1).max(60);

export const pageIdParam = objectIdSchema;

// ---------------------------------------------------------------- merchant

export const createBody = z
  .object({
    storeId: objectIdSchema,
    name: text(80).min(2),
    slug: slug.optional(),
    productId: objectIdSchema,
    template: z.enum(TEMPLATE_KEYS),
    language: z.enum(LANDING_LANGUAGES).optional(),
  })
  .strict();

export const settingsBody = z
  .object({
    name: text(80).min(2).optional(),
    slug: slug.optional(),
    language: z.enum(LANDING_LANGUAGES).optional(),
  })
  .strict();

export const saveBody = z
  .object({
    content: landingContentSchema,
    /** The revision the editor loaded; a newer one on the server refuses the save. */
    revision: z.number().int().min(1),
  })
  .strict();

export const slugCheckQuery = z.object({ storeId: objectIdSchema, slug });

export const duplicateBody = z
  .object({ name: text(80).min(2).optional(), slug: slug.optional() })
  .strict();

export const versionParam = z.coerce.number().int().min(1).max(1_000_000);

export const previewBody = z
  .object({ kind: z.enum(['draft', 'submission']).default('draft') })
  .strict();

export const statsQuery = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) });

// ---------------------------------------------------------------- platform

export const platformListQuery = z.object({
  status: z.enum(REVIEW_FILTERS).default('pending'),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const approveBody = z
  .object({ revision: z.number().int().min(1), note: text(500).optional() })
  .strict();

export const rejectBody = z
  .object({ revision: z.number().int().min(1), reason: text(1000).min(5) })
  .strict();

export const reasonBody = z.object({ reason: text(1000).min(5) }).strict();

// ---------------------------------------------------------------- storefront (shoppers)

export const slugParam = slug;

export const visitBody = z
  .object({
    visitorId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
  })
  .strict();

export const orderBody = z
  .object({
    packageId: z
      .string()
      .regex(/^[a-z0-9]{6,12}$/)
      .nullable(),
    variantId: objectIdSchema,
    quantity: z.number().int().min(1).max(MAX_FREE_QUANTITY).default(1),
    addOn: z.boolean().default(false),
    customer: z.object({ name: text(80).min(2), phone: text(30).min(6) }).strict(),
    address: z
      .object({
        line1: text(200).min(4),
        area: text(80).optional(),
        city: text(80).optional(),
        district: text(80).optional(),
      })
      .strict(),
    zoneId: z.string().trim().max(40).nullable(),
    note: text(500).optional(),
    /** Left empty by people; bots fill every field. */
    website: z.string().max(200).optional(),
    attribution: attribution.optional(),
    /** The saved cart this order comes from (abandoned cart reminders). */
    cartToken: cartToken.optional(),
    /** Cash on delivery (the default) or online, with the gateway (ADR 0029). */
    payment: paymentChoice.optional(),
  })
  .strict();

export const receiptQuery = z.object({ receipt: z.string().min(10).max(400) });
