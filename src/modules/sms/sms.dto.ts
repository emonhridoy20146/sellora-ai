import { z } from 'zod';
import {
  currencySchema,
  objectIdSchema,
  paginationQuerySchema,
} from '../../common/validation/schemas.js';
import { SENDER_NAME_STATUSES, SMS_MODES, SMS_STATUSES } from './schemas.js';
import { SMS_PROVIDER_KEYS } from './sms.types.js';
import { ORDER_SMS_EVENTS, SMS_PURPOSES } from './templates.js';

/** Field names and rules differ per provider; the provider's adapter validates the values. */
const credentials = z.record(z.string().max(40), z.string().max(4000));
const senderId = z.string().trim().max(20);
const phone = z.string().trim().min(5).max(20);
const language = z.enum(['en', 'bn']);

const template = z
  .object({ enabled: z.boolean().optional(), text: z.string().max(2000).optional() })
  .strict();

export const updateSettingsBody = z
  .object({
    mode: z.enum(SMS_MODES).optional(),
    language: language.optional(),
    shopName: z.string().trim().max(40).optional(),
    contactPhone: z
      .string()
      .trim()
      .max(20)
      .regex(/^[+\d][\d -]*$|^$/, 'Digits, spaces, + and - only')
      .optional(),
    useSenderName: z.boolean().optional(),
    orderTemplates: z
      .object(Object.fromEntries(ORDER_SMS_EVENTS.map((e) => [e, template.optional()])))
      .strict()
      .optional(),
  })
  .strict();

export const resetTemplatesBody = z.object({ language: language.optional() }).strict();

export const connectGatewayBody = z
  .object({
    provider: z.enum(SMS_PROVIDER_KEYS),
    credentials,
    senderId: senderId.optional(),
  })
  .strict();

export const updateGatewayBody = z
  .object({ credentials: credentials.optional(), senderId: senderId.optional() })
  .strict()
  .refine((b) => b.credentials !== undefined || b.senderId !== undefined, {
    message: 'Nothing to change',
  });

export const senderNameBody = z.object({ name: z.string().trim().min(1).max(20) }).strict();

export const testBody = z
  .object({ to: phone, text: z.string().trim().max(480).optional() })
  .strict();

export const messagesQuery = paginationQuerySchema.extend({
  status: z.enum(SMS_STATUSES).optional(),
  purpose: z.enum(SMS_PURPOSES).optional(),
  phone: phone.optional(),
  orderId: objectIdSchema.optional(),
});

export const optOutBody = z.object({ phone }).strict();

// ---------------------------------------------------------------- super-admin

const price = z
  .object({
    currency: currencySchema,
    perPartMinor: z.number().int().min(0).max(100_000),
    senderNamePerPartMinor: z.number().int().min(0).max(100_000),
  })
  .strict();

export const platformUpdateBody = z
  .object({
    enabled: z.boolean().optional(),
    senderId: senderId.optional(),
    prices: z.array(price).max(20).optional(),
    costs: z.array(price).max(20).optional(),
  })
  .strict();

export const senderNamesQuery = z.object({
  status: z.enum([...SENDER_NAME_STATUSES, 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const approveSenderNameBody = z.object({ name: z.string().trim().min(1).max(20) }).strict();

export const rejectSenderNameBody = z
  .object({ name: z.string().trim().min(1).max(20), reason: z.string().trim().min(3).max(500) })
  .strict();

export const dailyLimitBody = z
  .object({ dailyLimit: z.number().int().min(0).max(1_000_000).nullable() })
  .strict();

export const platformTestBody = testBody;

// ---------------------------------------------------------------- public

export const linkCode = z.string().regex(/^[A-Za-z0-9]{6,16}$/, 'Invalid link');
export const providerParam = z.enum(SMS_PROVIDER_KEYS);
