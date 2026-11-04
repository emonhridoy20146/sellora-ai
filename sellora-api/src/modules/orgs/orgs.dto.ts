import { z } from 'zod';
import {
  countrySchema,
  currencySchema,
  emailSchema,
  nameSchema,
  phoneSchema,
  slugSchema,
  timezoneSchema,
} from '../../common/validation/schemas.js';
import { BUSINESS_CATEGORY_KEYS } from './business-categories.js';

export const createOrgBody = z.object({
  name: nameSchema,
  slug: slugSchema.optional(),
  category: z.enum(BUSINESS_CATEGORY_KEYS).default('other'),
  country: countrySchema.default('BD'),
  currency: currencySchema.default('BDT'),
  timezone: timezoneSchema.default('Asia/Dhaka'),
  locale: z.enum(['en', 'bn']).default('en'),
  phone: phoneSchema().optional(),
});

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const updateOrgBody = z
  .object({
    name: nameSchema.optional(),
    legalName: nullableText(200),
    category: z.enum(BUSINESS_CATEGORY_KEYS).optional(),
    timezone: timezoneSchema.optional(),
    locale: z.enum(['en', 'bn']).optional(),
    orderNumberPrefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,6}$/, 'Use 1 to 6 letters or digits')
      .optional(),
    contact: z
      .object({
        phone: phoneSchema().nullable().optional(),
        email: emailSchema.nullable().optional(),
        address: nullableText(500),
        website: z.url().max(300).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const changeRoleBody = z.object({ roleKey: z.string().min(2).max(64) });
export const memberStatusBody = z.object({ status: z.enum(['active', 'suspended']) });
export const transferOwnershipBody = z.object({
  memberId: z.string().regex(/^[a-f0-9]{24}$/i),
  password: z.string().min(1).max(128),
});

export const createRoleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string().max(64)).min(1).max(100),
});
export const updateRoleBody = createRoleBody.partial().strict();

export const createInvitationBody = z.object({
  email: emailSchema,
  roleKey: z.string().min(2).max(64),
});
export const acceptInvitationBody = z.object({ token: z.string().min(10).max(200) });

export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  actorId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
