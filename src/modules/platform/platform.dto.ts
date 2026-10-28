import { z } from 'zod';
import {
  emailSchema,
  nameSchema,
  otpCodeSchema,
  passwordSchema,
} from '../../common/validation/schemas.js';
import { PLATFORM_ROLES } from '../iam/platform-permissions.js';

export const platformLoginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const platformMfaLoginBody = z
  .object({
    mfaToken: z.string().min(10).max(2000),
    code: otpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(8).max(20).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Send either code or recoveryCode',
  });
export const setupTokenBody = z.object({ setupToken: z.string().min(10).max(2000) });
export const completeMfaSetupBody = z.object({
  setupToken: z.string().min(10).max(2000),
  code: otpCodeSchema,
});
export const accountSetupBody = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema.refine(
    (p) => p.length >= 14,
    'Platform passwords need at least 14 characters',
  ),
});
export const accountSetupPreviewBody = z.object({ token: z.string().min(10).max(200) });

export const inviteAdminBody = z.object({
  email: emailSchema,
  name: nameSchema,
  role: z.enum(PLATFORM_ROLES),
});
export const changeAdminRoleBody = z.object({ role: z.enum(PLATFORM_ROLES) });
export const adminStatusBody = z.object({ status: z.enum(['active', 'disabled']) });

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().max(20).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const tenantStatusBody = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(3).max(500),
});
export const demoBody = z.object({
  hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .nullable(),
});
export const userStatusBody = z.object({
  status: z.enum(['active', 'locked', 'disabled']),
  reason: z.string().trim().min(3).max(500),
});
export const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) });

export const settingsBody = z
  .object({
    signupEnabled: z.boolean().optional(),
    trial: z
      .object({
        enabled: z.boolean().optional(),
        days: z.number().int().min(0).max(90).optional(),
        planCode: z.string().trim().toLowerCase().min(1).max(40).optional(),
      })
      .strict()
      .optional(),
    demo: z
      .object({
        defaultHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 30)
          .optional(),
      })
      .strict()
      .optional(),
    maintenance: z
      .object({ enabled: z.boolean().optional(), message: z.string().max(500).optional() })
      .strict()
      .optional(),
    support: z
      .object({ email: emailSchema.optional(), whatsapp: z.string().max(32).optional() })
      .strict()
      .optional(),
    billing: z
      .object({
        withdrawalsEnabled: z.boolean().optional(),
        graceDays: z.number().int().min(0).max(30).optional(),
        taxRateBps: z.number().int().min(0).max(5_000).optional(),
        taxLabel: z.string().trim().min(1).max(20).optional(),
        minTopupMinor: z.number().int().min(1).optional(),
        maxTopupMinor: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    fraudNetwork: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export const platformAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
  scope: z.string().max(30).optional(),
  orgId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
  action: z.string().max(100).optional(),
  actorId: z.string().max(64).optional(),
});
