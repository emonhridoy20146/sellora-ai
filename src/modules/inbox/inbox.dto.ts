import { z } from 'zod';
import {
  emailSchema,
  nameSchema,
  objectIdSchema,
  paginationQuerySchema,
  rawPhoneSchema,
} from '../../common/validation/schemas.js';
import { MEMORY_LIMITS } from './schemas.js';

const origin = z
  .string()
  .trim()
  .max(200)
  .transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value.includes('://') ? value : `https://${value}`);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a site address like https://myshop.com' });
      return z.NEVER;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      ctx.addIssue({ code: 'custom', message: 'Only http and https sites can show the chat' });
      return z.NEVER;
    }
    return url.origin;
  });

const webChatFields = {
  allowedOrigins: z
    .array(origin)
    .max(20)
    .transform((list) => [...new Set(list)]),
  greeting: z.string().trim().max(500),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2563eb')
    .transform((c) => c.toLowerCase()),
  askContact: z.boolean(),
};

export const createWebChatBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    aiEnabled: z.boolean().optional(),
    allowedOrigins: webChatFields.allowedOrigins.optional(),
    greeting: webChatFields.greeting.optional(),
    color: webChatFields.color.optional(),
    askContact: webChatFields.askContact.optional(),
  })
  .strict();

export const updateChannelBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    aiEnabled: z.boolean().optional(),
    webChat: z
      .object({
        allowedOrigins: webChatFields.allowedOrigins.optional(),
        greeting: webChatFields.greeting.optional(),
        color: webChatFields.color.optional(),
        askContact: webChatFields.askContact.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const conversationListQuery = paginationQuerySchema.extend({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  /** me, unassigned, or a member's user id. */
  assignee: z.union([z.enum(['me', 'unassigned']), objectIdSchema]).optional(),
  channelId: objectIdSchema.optional(),
  ai: z.enum(['auto', 'paused']).optional(),
  q: z.string().trim().max(100).optional(),
});

export const messageListQuery = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const sendMessageBody = z
  .object({
    text: z.string().trim().min(1, 'Write a message').max(4000),
    /** An internal note only staff see. */
    note: z.boolean().default(false),
    /** The client's id for this message, so a retried send is stored once. */
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
  })
  .strict();

export const aiModeBody = z
  .object({
    mode: z.enum(['auto', 'paused']),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const assignBody = z.object({ assigneeId: objectIdSchema.nullable() }).strict();

export const statusBody = z.object({ status: z.enum(['open', 'closed']) }).strict();

export const contactPatchBody = z
  .object({
    name: nameSchema.optional(),
    phone: rawPhoneSchema.nullable().optional(),
    email: emailSchema.nullable().optional(),
    /** Replaces what the AI remembered (staff remove wrong or private facts). */
    memory: z
      .object({
        facts: z
          .array(z.string().trim().min(1).max(MEMORY_LIMITS.fact))
          .max(MEMORY_LIMITS.facts),
        address: z.string().trim().max(MEMORY_LIMITS.address).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ------------------------------------------------------------------ web chat

export const visitorSessionBody = z
  .object({
    /** A token from an earlier visit, kept by the widget. */
    token: z.string().max(600).optional(),
  })
  .strict();

export const visitorMessageBody = z
  .object({
    text: z.string().trim().min(1).max(2000),
    clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();

export const visitorContactBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    phone: rawPhoneSchema.optional(),
    email: emailSchema.optional(),
  })
  .strict()
  .refine((v) => v.name || v.phone || v.email, { message: 'Enter your name or phone' });

export const visitorHistoryQuery = z.object({
  before: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
