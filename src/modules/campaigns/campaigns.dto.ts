import { z } from 'zod';
import {
  moneyMinorSchema,
  objectIdSchema,
  rawPhoneSchema,
} from '../../common/validation/schemas.js';
import { CUSTOMER_SOURCES } from '../commerce/schemas.js';
import { MAX_CAMPAIGN_TEXT_CHARS } from './campaign-rules.js';
import {
  AUTOMATION_KINDS,
  AUTOMATION_SEND_STATUSES,
  CAMPAIGN_STATUSES,
  LINK_KINDS,
} from './schemas.js';

const days = z.number().int().min(1).max(3650);

export const audienceBody = z
  .object({
    ordered: z.enum(['any', 'ordered', 'delivered']),
    minOrders: z.number().int().min(1).max(10_000).optional(),
    minSpentMinor: moneyMinorSchema.min(1).optional(),
    orderedWithinDays: days.optional(),
    noOrderForDays: days.optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    sources: z.array(z.enum(CUSTOMER_SOURCES)).max(CUSTOMER_SOURCES.length).optional(),
  })
  .strict()
  .refine(
    (a) => !(a.orderedWithinDays && a.noOrderForDays && a.noOrderForDays >= a.orderedWithinDays),
    {
      message: 'No customer ordered in the last days and also not for longer. Change one of them.',
      path: ['noOrderForDays'],
    },
  );

export const linkBody = z
  .object({
    kind: z.enum(LINK_KINDS),
    storeId: objectIdSchema.optional(),
    targetId: objectIdSchema.optional(),
  })
  .strict();

// Text length and placeholders are checked by the service, with field paths.
const text = z.string().max(MAX_CAMPAIGN_TEXT_CHARS * 2);

export const createBody = z
  .object({
    name: z.string().trim().max(80).optional(),
    text: text.optional(),
    audience: audienceBody.optional(),
    link: linkBody.optional(),
  })
  .strict();

export const updateBody = createBody;

export const checkBody = z.object({ text, link: linkBody.optional() }).strict();

export const startBody = z.object({ at: z.iso.datetime({ offset: true }).optional() }).strict();

export const testBody = z.object({ to: rawPhoneSchema }).strict();

export const listQuery = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const recipientsQuery = z.object({
  status: z.enum(['queued', 'skipped', 'pending', 'ordered']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const campaignIdParam = objectIdSchema;

// ---------------------------------------------------------------- automations

const automationPatch = z
  .object({
    enabled: z.boolean().optional(),
    days: z.number().int().min(1).max(365).optional(),
    text: text.optional(),
    link: linkBody.optional(),
  })
  .strict();

export const automationsBody = z
  .object({
    language: z.enum(['en', 'bn']).optional(),
    after_delivery: automationPatch.optional(),
    win_back: automationPatch.optional(),
  })
  .strict();

export const automationSendsQuery = z.object({
  kind: z.enum(AUTOMATION_KINDS).optional(),
  status: z.enum(AUTOMATION_SEND_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

// ---------------------------------------------------------------- storefront

export const linkCodeParam = z.string().regex(/^[A-Za-z0-9]{8}$/, 'Not a link code');
