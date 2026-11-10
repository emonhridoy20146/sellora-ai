import { z } from 'zod';
import { SHOP_GATEWAYS } from '../commerce/schemas.js';
import { ADVANCE_MODES } from './schemas.js';

const minor = z.number().int().min(0).max(100_000_000);

export const createAccountBody = z
  .object({
    gateway: z.enum(SHOP_GATEWAYS),
    credentials: z.record(z.string(), z.unknown()),
    sandbox: z.boolean().optional(),
  })
  .strict();

export const updateAccountBody = z
  .object({
    credentials: z.record(z.string(), z.unknown()).optional(),
    sandbox: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

export const settingsBody = z
  .object({
    cod: z.boolean().optional(),
    fullOnline: z.boolean().optional(),
    advance: z
      .object({
        mode: z.enum(ADVANCE_MODES).optional(),
        fixedMinor: minor.optional(),
        percent: z.number().min(0).max(100).optional(),
        zoneIds: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
        minTotalMinor: minor.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The shopper's choice at checkout (store and landing pages). */
export const paymentChoice = z
  .object({
    method: z.enum(['cod', 'online']),
    gateway: z.enum(SHOP_GATEWAYS).optional(),
  })
  .strict();

export const payBody = z
  .object({
    receipt: z.string().min(10).max(400),
    gateway: z.enum(SHOP_GATEWAYS),
  })
  .strict();

export const refParam = z.string().regex(/^SP[A-Z0-9]{14}$/);
export const outcomeParam = z.enum(['done', 'success', 'fail', 'cancel']);
