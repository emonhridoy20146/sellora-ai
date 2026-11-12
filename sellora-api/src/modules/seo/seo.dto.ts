import { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { APPLY_FIELDS } from './seo-audit.service.js';
import {
  CONTENT_KINDS,
  CONTENT_TONES,
  KEYWORD_INTENTS,
  KEYWORD_MIXES,
  KEYWORD_SCRIPTS,
  TRANSLATE_TO,
  WRITER_LANGUAGES,
} from './writer-tasks.js';

const text = (max: number) => z.string().trim().max(max);
const label = (max: number) => z.string().trim().min(1).max(max);
const keyword = label(80);

export const writeProductBody = z
  .object({
    productId: objectIdSchema.optional(),
    name: label(200),
    description: text(20_000).default(''),
    tags: z.array(label(40)).max(30).default([]),
    categoryId: objectIdSchema.nullable().default(null),
    imageCount: z.number().int().min(0).max(20).default(0),
    priceMinor: z.number().int().min(0).nullable().default(null),
    focusKeyword: keyword.nullable().default(null),
    language: z.enum(WRITER_LANGUAGES),
  })
  .strict();

export const writePageBody = z
  .object({
    kind: z.enum(['store', 'landing']),
    name: label(200),
    about: text(8_000).default(''),
    focusKeyword: keyword.nullable().default(null),
    language: z.enum(WRITER_LANGUAGES),
  })
  .strict();

export const researchBody = z
  .object({
    seed: keyword,
    mix: z.enum(KEYWORD_MIXES).default('all'),
    volumes: z.boolean().default(true),
    about: text(300).optional(),
  })
  .strict();

export const listNameBody = z.object({ name: label(60) }).strict();

export const addKeywordsBody = z
  .object({
    keywords: z
      .array(
        z
          .object({
            keyword,
            volume: z.number().int().min(0).nullable().optional(),
            competition: z.enum(['low', 'medium', 'high']).nullable().optional(),
            script: z.enum(KEYWORD_SCRIPTS).optional(),
            intent: z.enum(KEYWORD_INTENTS).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const removeKeywordsBody = z.object({ keywords: z.array(keyword).min(1).max(500) }).strict();

export const duplicatesQuery = z.object({
  title: text(200).optional(),
  meta: text(300).optional(),
  exceptId: objectIdSchema.optional(),
});

export const bulkBody = z
  .object({
    /** Chosen products; leave out to take the lowest scores below `below`. */
    productIds: z.array(objectIdSchema).min(1).max(50).optional(),
    below: z.number().int().min(1).max(100).default(80),
    language: z.enum(WRITER_LANGUAGES),
  })
  .strict();

export const applyBody = z
  .object({
    fields: z
      .array(z.enum(APPLY_FIELDS))
      .min(1)
      .default(['title', 'meta', 'keywords', 'faq', 'alts']),
  })
  .strict();

export const reportQuery = z.object({
  days: z
    .enum(['7', '28', '90'])
    .default('28')
    .transform((d) => Number(d) as 7 | 28 | 90),
});

export const connectBody = z.object({ storeId: objectIdSchema }).strict();

export const contentBody = z
  .object({
    kind: z.enum(CONTENT_KINDS),
    productId: objectIdSchema.optional(),
    productName: text(200).optional(),
    source: label(8_000),
    language: z.enum(WRITER_LANGUAGES),
    tone: z.enum(CONTENT_TONES).default('friendly'),
    translateTo: z.enum(TRANSLATE_TO).default('bn'),
    notes: text(500).default(''),
    variants: z.number().int().min(1).max(5).default(3),
  })
  .strict();

export const googleCallbackQuery = z.object({
  code: z.string().max(2000).optional(),
  state: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});
