import { z } from 'zod';
import { UPLOAD_PURPOSES } from './schemas.js';

export const createUploadBody = z
  .object({
    purpose: z.enum(UPLOAD_PURPOSES),
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(3).max(100),
    size: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024 * 1024),
  })
  .strict();
