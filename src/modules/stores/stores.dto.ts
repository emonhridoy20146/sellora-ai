import { z } from 'zod';
import { emailSchema, moneyMinorSchema, objectIdSchema } from '../../common/validation/schemas.js';
import { BUSINESS_CATEGORY_KEYS } from '../orgs/business-categories.js';
import { STORE_STATUSES } from './schemas.js';
import { THEME_KEYS, themeSettingsSchema } from './themes.js';

const text = (max: number) => z.string().trim().max(max);
/** Optional text: an empty string clears it. */
const optText = (max: number) => text(max).optional();
const httpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https:\/\/[^\s]+$/i.test(v), 'Use a full https:// link');

export const handleSchema = z.string().trim().toLowerCase().max(64);

// ---------------------------------------------------------------- merchant

export const createStoreBody = z
  .object({
    name: text(80).min(2),
    handle: handleSchema.optional(),
    category: z.enum(BUSINESS_CATEGORY_KEYS).optional(),
    language: z.enum(['en', 'bn']).optional(),
    themeKey: z.enum(THEME_KEYS).optional(),
    /** Which of the theme's colour palettes to start with. */
    palette: z.number().int().min(0).max(9).optional(),
  })
  .strict();

const contact = z
  .object({
    phone: optText(30),
    whatsapp: optText(30),
    email: z.union([z.literal(''), emailSchema]).optional(),
    address: optText(300),
  })
  .strict();

const social = z
  .object({
    facebook: httpUrl.optional(),
    instagram: httpUrl.optional(),
    youtube: httpUrl.optional(),
    tiktok: httpUrl.optional(),
  })
  .strict();

const pages = z
  .object({
    about: optText(5000),
    shipping: optText(5000),
    returns: optText(5000),
    privacy: optText(10000),
    terms: optText(10000),
  })
  .strict();

export const updateStoreBody = z
  .object({
    name: text(80).min(2).optional(),
    handle: handleSchema.optional(),
    category: z.enum(BUSINESS_CATEGORY_KEYS).optional(),
    language: z.enum(['en', 'bn']).optional(),
    contact: contact.optional(),
    social: social.optional(),
    seo: z
      .object({ title: optText(70), description: optText(170) })
      .strict()
      .optional(),
    pages: pages.optional(),
    checkout: z
      .object({ note: optText(300), minOrderMinor: moneyMinorSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();

export const themeBody = z
  .object({ themeKey: z.enum(THEME_KEYS), theme: themeSettingsSchema })
  .strict();

export const handleCheckQuery = z.object({
  handle: handleSchema.min(1),
  /** The store being renamed, so its own address counts as free. */
  storeId: objectIdSchema.optional(),
});

export const storeIdParam = objectIdSchema;

// ---------------------------------------------------------------- platform

export const platformStoresQuery = z.object({
  status: z.enum(STORE_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const reasonBody = z.object({ reason: text(500).min(5) }).strict();
export const approveBody = z.object({ note: optText(500) }).strict();

// ---------------------------------------------------------------- storefront (shoppers)

export const resolveQuery = z.object({ host: z.string().trim().min(3).max(260) });

export const productSlugParam = z.string().trim().min(1).max(120);

export const productListQuery = z.object({
  category: z.string().trim().max(80).optional(),
  q: z.string().trim().max(80).optional(),
  sort: z.enum(['newest', 'popular', 'price_asc', 'price_desc']).default('newest'),
  page: z.coerce.number().int().min(1).max(50).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

const cartItem = z
  .object({
    productId: objectIdSchema,
    variantId: objectIdSchema,
    quantity: z.number().int().min(1).max(50),
  })
  .strict();

export const cartBody = z
  .object({
    items: z.array(cartItem).max(30),
    zoneId: z.string().trim().max(40).nullable().optional(),
  })
  .strict();

export const checkoutBody = z
  .object({
    items: z.array(cartItem).min(1).max(30),
    customer: z
      .object({
        name: text(80).min(2),
        phone: text(30).min(6),
        email: z.union([z.literal(''), emailSchema]).optional(),
      })
      .strict(),
    address: z
      .object({
        line1: text(200).min(4),
        area: optText(80),
        city: optText(80),
        district: optText(80),
      })
      .strict(),
    zoneId: z.string().trim().max(40).nullable(),
    note: optText(500),
    /** Left empty by people; bots fill every field. */
    website: z.string().max(200).optional(),
  })
  .strict();

export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,80}$/, 'Send an Idempotency-Key of 8 to 80 letters, digits, - or _');

export const trackBody = z.object({ number: text(40).min(3), phone: text(30).min(6) }).strict();

export const receiptQuery = z.object({ receipt: z.string().min(10).max(400) });

export const domainCheckQuery = z.object({ domain: z.string().trim().min(3).max(260) });
