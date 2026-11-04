import { z } from 'zod';

/** Graph ids are decimal strings. */
const graphId = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{5,30}$/, `Enter the ${label} (digits only)`);

export const pageLoginFinishBody = z
  .object({
    code: z.string().min(1).max(2_000),
    state: z.string().min(1).max(4_000),
  })
  .strict();

export const connectSessionId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Unknown session');

export const connectPageBody = z
  .object({
    sessionId: connectSessionId,
    pageId: graphId('page id'),
    messenger: z.boolean(),
    instagram: z.boolean(),
  })
  .strict();

export const connectWhatsAppBody = z
  .object({
    phoneNumberId: graphId('phone number id'),
    wabaId: graphId('WhatsApp Business Account id'),
    accessToken: z.string().trim().min(20, 'Paste the whole access token').max(1_000),
  })
  .strict();

export const connectWhatsAppEmbeddedBody = z
  .object({
    code: z.string().min(1).max(2_000),
    phoneNumberId: graphId('phone number id'),
    wabaId: graphId('WhatsApp Business Account id'),
  })
  .strict();
