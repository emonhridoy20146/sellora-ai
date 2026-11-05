import { z } from 'zod';
import { CSV_UPLOAD_MAX_BYTES } from './connectors/sheet.connector.js';
import { SYNC_INTERVALS } from './schemas.js';

const url = z.string().trim().min(3).max(2000);
const interval = z
  .number()
  .int()
  .refine((n) => (SYNC_INTERVALS as readonly number[]).includes(n), {
    message: `One of ${SYNC_INTERVALS.join(', ')} minutes (0: only when asked)`,
  });

export const shopifyCredentials = z
  .object({
    accessToken: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{20,200}$/, 'Paste the Admin API access token (it starts with shpat_)'),
  })
  .strict();

export const wooCredentials = z
  .object({
    consumerKey: z
      .string()
      .trim()
      .regex(/^ck_[A-Za-z0-9]{20,100}$/, 'The consumer key starts with ck_'),
    consumerSecret: z
      .string()
      .trim()
      .regex(/^cs_[A-Za-z0-9]{20,100}$/, 'The consumer secret starts with cs_'),
  })
  .strict();

const csvText = z
  .string()
  .min(1, 'The file is empty')
  .refine((t) => Buffer.byteLength(t) <= CSV_UPLOAD_MAX_BYTES, {
    message: `CSV files can be up to ${Math.round(CSV_UPLOAD_MAX_BYTES / 1024)} KB; use a Google Sheet link for a bigger catalog`,
  });

/** What "Check" and "Add" take; one shape per kind. */
export const sourceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shopify'), url, credentials: shopifyCredentials }).strict(),
  z.object({ kind: z.literal('woocommerce'), url, credentials: wooCredentials }).strict(),
  z.object({ kind: z.literal('sheet'), url }).strict(),
  z
    .object({ kind: z.literal('csv'), filename: z.string().trim().min(1).max(200), csv: csvText })
    .strict(),
]);
export type SourceInput = z.infer<typeof sourceInput>;

const settings = {
  name: z.string().trim().min(1).max(80).optional(),
  intervalMinutes: interval.optional(),
  newProductStatus: z.enum(['active', 'draft']).optional(),
  syncStock: z.boolean().optional(),
  archiveMissing: z.boolean().optional(),
};

export const createSourceBody = z.object({ source: sourceInput, ...settings }).strict();
export type CreateSourceBody = z.infer<typeof createSourceBody>;

export const updateSourceBody = z
  .object({
    ...settings,
    status: z.enum(['active', 'paused']).optional(),
    /** New address or key: checked again before it is saved. */
    url: url.optional(),
    credentials: z.union([shopifyCredentials, wooCredentials]).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateSourceBody = z.infer<typeof updateSourceBody>;

export const uploadCsvBody = z
  .object({ filename: z.string().trim().min(1).max(200), csv: csvText })
  .strict();

export const runsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(200).optional(),
  })
  .strict();
