import { z } from 'zod';
import {
  emailSchema,
  localeSchema,
  nameSchema,
  otpCodeSchema,
  passwordSchema,
  phoneSchema,
  timezoneSchema,
} from '../../common/validation/schemas.js';

export const signupBody = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  locale: localeSchema,
  phone: phoneSchema().optional(),
  acceptTerms: z.literal(true, { message: 'You must accept the terms of service' }),
});

export const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(128) });

export const mfaLoginBody = z
  .object({
    mfaToken: z.string().min(10).max(2000),
    code: otpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(8).max(20).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Send either code or recoveryCode',
  });

export const refreshBody = z
  .object({ refreshToken: z.string().min(20).max(300).optional() })
  .default({});

export const tokenBody = z.object({ token: z.string().min(10).max(200) });
export const emailBody = z.object({ email: emailSchema });
export const resetPasswordBody = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
});
export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const updateProfileBody = z
  .object({
    name: nameSchema.optional(),
    phone: phoneSchema().nullable().optional(),
    locale: z.enum(['en', 'bn']).optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

export const codeBody = z.object({ code: otpCodeSchema });
export const passwordBody = z.object({ password: z.string().min(1).max(128) });
export const disableMfaBody = z
  .object({
    password: z.string().min(1).max(128),
    code: otpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(8).max(20).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Send either code or recoveryCode',
  });

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: z.string(),
});

export const sessionResponse = z.object({
  status: z.literal('ok'),
  user: publicUserSchema,
  accessToken: z.string(),
  expiresIn: z.number(),
  csrfToken: z.string().optional(),
  refreshToken: z.string().optional(),
});

export const mfaRequiredResponse = z.object({
  status: z.literal('mfa_required'),
  mfaToken: z.string(),
});
