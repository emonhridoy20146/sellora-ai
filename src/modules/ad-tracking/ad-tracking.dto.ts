import { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import {
  AD_PLATFORMS,
  BROWSER_COPY_EVENTS,
  CONSENT_MODES,
  PURCHASE_WHEN,
} from './ad-tracking.types.js';

const text = (max: number) => z.string().trim().max(max);
const ids = z.array(objectIdSchema).max(200);

export const createDestinationBody = z
  .object({
    platform: z.enum(AD_PLATFORMS),
    name: text(80).optional(),
    publicId: text(40).min(4),
    conversionLabel: text(60).optional(),
    secret: text(500).optional(),
    testCode: text(60).optional(),
    everywhere: z.boolean().optional(),
    storeIds: ids.optional(),
    landingPageIds: ids.optional(),
    purchaseWhen: z.enum(PURCHASE_WHEN).optional(),
    chatOrders: z.boolean().optional(),
  })
  .strict();

export const updateDestinationBody = z
  .object({
    name: text(80).optional(),
    secret: text(500).optional(),
    testCode: text(60).optional(),
    conversionLabel: text(60).optional(),
    enabled: z.boolean().optional(),
    everywhere: z.boolean().optional(),
    storeIds: ids.optional(),
    landingPageIds: ids.optional(),
    purchaseWhen: z.enum(PURCHASE_WHEN).optional(),
    chatOrders: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

export const settingsBody = z.object({ consent: z.enum(CONSENT_MODES) }).strict();

export const logQuery = z.object({
  destinationId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Cookie and click ids as the browser has them; malformed values are dropped later. */
const browserId = z.string().trim().max(600).optional();

/** What the shopper's browser knew, sent with an event or an order (ADR 0030). */
export const browserIds = z
  .object({
    consent: z.boolean().optional(),
    url: z.string().trim().max(1000).optional(),
    referrer: z.string().trim().max(1000).optional(),
    fbp: browserId,
    fbc: browserId,
    ttp: browserId,
    ttclid: browserId,
    fbclid: browserId,
    ga: browserId,
    gaSession: browserId,
    visitorId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
  })
  .strict();

export const eventId = z.string().regex(/^[A-Za-z0-9_.-]{8,80}$/, 'Send an event id');

/** A product view, add to cart or checkout start, for the server copy. */
export const browserEventBody = browserIds
  .extend({
    event: z.enum(BROWSER_COPY_EVENTS),
    eventId,
    items: z
      .array(
        z
          .object({
            productId: objectIdSchema,
            variantId: objectIdSchema.optional(),
            quantity: z.number().int().min(1).max(999),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
