import { z } from 'zod';
import {
  moneyMinorSchema,
  objectIdSchema,
  rawPhoneSchema,
} from '../../common/validation/schemas.js';
import { CART_DELAYS, CART_STEPS, MAX_CART_TEXT_CHARS } from './cart-templates.js';
import { CART_VIEWS } from './carts.service.js';

const step = z
  .object({
    enabled: z.boolean(),
    delayMinutes: z
      .number()
      .int()
      .refine((d) => (CART_DELAYS as readonly number[]).includes(d), {
        message: 'Choose one of the delays',
      }),
    // Checked for length and placeholders by the service, with field paths.
    text: z.string().max(MAX_CART_TEXT_CHARS * 2),
  })
  .strict();

const hour = z.number().int().min(0).max(23);

export const updateSettingsBody = z
  .object({
    enabled: z.boolean().optional(),
    language: z.enum(['en', 'bn']).optional(),
    steps: z.array(step).length(CART_STEPS).optional(),
    minTotalMinor: moneyMinorSchema.optional(),
    quietHours: z
      .object({ enabled: z.boolean(), startHour: hour, endHour: hour })
      .strict()
      .optional(),
  })
  .strict();

export const listQuery = z.object({
  view: z.enum(CART_VIEWS).default('abandoned'),
  phone: rawPhoneSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const cartIdParam = objectIdSchema;

// ---------------------------------------------------------------- storefront

/** The browser's random id for the cart (kept with the cart in its storage). */
export const cartToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Send a cart token');

const shopper = z
  .object({
    name: z.string().trim().max(80).default(''),
    phone: z.string().trim().min(1).max(30),
  })
  .strict();

const cartItem = z
  .object({
    productId: objectIdSchema,
    variantId: objectIdSchema,
    quantity: z.number().int().min(1).max(50),
  })
  .strict();

export const storeCartBody = z
  .object({ token: cartToken, items: z.array(cartItem).min(1).max(30), customer: shopper })
  .strict();

export const landingCartBody = z
  .object({
    token: cartToken,
    packageId: z
      .string()
      .regex(/^[a-z0-9]{6,12}$/)
      .nullable(),
    variantId: objectIdSchema,
    quantity: z.number().int().min(1).max(50).default(1),
    addOn: z.boolean().default(false),
    customer: shopper,
  })
  .strict();

export const cartCodeParam = z.string().regex(/^[A-Za-z0-9]{10}$/, 'Not a cart link');
