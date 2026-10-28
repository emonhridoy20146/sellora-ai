import { z } from 'zod';
import { MODEL_TIERS } from '../billing/credit-schemas.js';
import { AI_LANGUAGES, AI_LIMITS, AI_TONES } from './agent-settings.schema.js';

const faq = z
  .object({
    question: z.string().trim().min(1).max(AI_LIMITS.faqQuestion),
    answer: z.string().trim().min(1).max(AI_LIMITS.faqAnswer),
  })
  .strict();

export const agentSettingsPatch = z
  .object({
    enabled: z.boolean(),
    assistantName: z.string().trim().max(AI_LIMITS.assistantName),
    tone: z.enum(AI_TONES),
    language: z.enum(AI_LANGUAGES),
    tier: z.enum(MODEL_TIERS),
    businessInfo: z.string().trim().max(AI_LIMITS.businessInfo),
    instructions: z.string().trim().max(AI_LIMITS.instructions),
    faqs: z.array(faq).max(AI_LIMITS.faqs),
    takeOrders: z.boolean(),
    confirmOrders: z.boolean(),
    handoverKeywords: z
      .array(z.string().trim().min(1).max(AI_LIMITS.keyword))
      .max(AI_LIMITS.handoverKeywords)
      .transform((list) => [...new Set(list.map((k) => k.toLocaleLowerCase('en')))]),
    handoverMessage: z.string().trim().max(AI_LIMITS.handoverMessage),
    replyDelaySeconds: z.number().int().min(0).max(AI_LIMITS.replyDelaySeconds),
    maxRepliesPerDay: z.number().int().min(1).max(AI_LIMITS.maxRepliesPerDay),
  })
  .partial()
  .strict();

export const previewBody = z
  .object({
    messages: z
      .array(
        z
          .object({
            from: z.enum(['customer', 'assistant']),
            text: z.string().trim().min(1).max(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine((list) => list.at(-1)?.from === 'customer', {
        message: 'The last message must be from the customer',
      }),
    draft: agentSettingsPatch
      .pick({
        assistantName: true,
        tone: true,
        language: true,
        tier: true,
        businessInfo: true,
        instructions: true,
        faqs: true,
        takeOrders: true,
      })
      .optional(),
  })
  .strict();
