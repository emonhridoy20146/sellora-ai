import { z } from 'zod';
import { REPORT_KINDS } from './reports.service.js';
import { TOPIC_KEYS } from './schemas.js';

const topics = z
  .array(z.enum(TOPIC_KEYS as [string, ...string[]]))
  .max(TOPIC_KEYS.length)
  .transform((t) => [...new Set(t)]);

/** Telegram chat ids: a private chat's user id, or a negative group id. */
export const chatIdSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/, 'A Telegram chat id is a number, such as 123456789 or -1001234567890');

export const settingsBody = z
  .object({
    reports: z
      .object({
        daily: z.boolean().optional(),
        weekly: z.boolean().optional(),
        monthly: z.boolean().optional(),
        hour: z.number().int().min(0).max(23).optional(),
        timezone: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    alerts: z
      .object({
        enabled: z.boolean().optional(),
        queueBacklog: z.number().int().min(0).max(1_000_000).optional(),
        loginFailures: z.number().int().min(0).max(100_000).optional(),
        aiErrors: z.number().int().min(0).max(100_000).optional(),
        aiSpendFactor: z.number().min(0).max(100).optional(),
        emailFallback: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b.reports ?? {}).length + Object.keys(b.alerts ?? {}).length > 0, {
    message: 'Nothing to change',
  });

export const addChatBody = z.object({ chatId: chatIdSchema }).strict();

export const chatTopicsBody = z.object({ topics }).strict();

export const reportBody = z
  .object({ kind: z.enum(REPORT_KINDS as [string, ...string[]]) })
  .strict();

export const messagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The parts of an update the webhook keeps; the rest is dropped. */
export const updateBody = z
  .object({
    update_id: z.number().int(),
    message: z
      .object({
        message_id: z.number().int(),
        date: z.number().int(),
        chat: z
          .object({
            id: z.number().int(),
            type: z.enum(['private', 'group', 'supergroup', 'channel']),
            title: z.string().max(256).optional(),
            username: z.string().max(64).optional(),
            first_name: z.string().max(256).optional(),
            last_name: z.string().max(256).optional(),
          })
          .strip(),
        from: z
          .object({
            id: z.number().int(),
            is_bot: z.boolean(),
            first_name: z.string().max(256).optional(),
            username: z.string().max(64).optional(),
          })
          .strip()
          .optional(),
        text: z.string().max(4096).optional(),
      })
      .strip()
      .optional(),
  })
  .strip();
