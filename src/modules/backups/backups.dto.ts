import { z } from 'zod';
import { objectIdSchema, otpCodeSchema } from '../../common/validation/schemas.js';
import { RESTORE_PART_KEYS } from './backup-rules.js';

const reasonSchema = z.string().trim().min(5, 'Say why, in a few words').max(300);

export const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    keep: z
      .object({
        daily: z.number().int().min(1).max(60).optional(),
        weekly: z.number().int().min(0).max(52).optional(),
        monthly: z.number().int().min(0).max(36).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const runsQuery = z.object({
  scope: z.enum(['platform', 'tenant']).optional(),
  orgId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const downloadBody = z.object({ code: otpCodeSchema, reason: reasonSchema }).strict();

export const previewBody = z.object({ runId: objectIdSchema }).strict();

export const restoreBody = z
  .object({
    runId: objectIdSchema,
    parts: z
      .array(z.enum(RESTORE_PART_KEYS as [string, ...string[]]))
      .min(1)
      .max(RESTORE_PART_KEYS.length),
    reason: reasonSchema,
    confirmName: z.string().trim().min(1).max(200),
    code: otpCodeSchema,
  })
  .strict();
