import { z } from 'zod';
import type { GatewayKey } from '../payment-schemas.js';

/** Injected fetch, so gateway adapters can be exercised against fakes in tests. */
export const GATEWAY_FETCH = Symbol('GATEWAY_FETCH');
export type GatewayFetch = typeof fetch;

export const GATEWAY_TIMEOUT_MS = 20_000;

export interface CheckoutRequest {
  paymentId: string;
  amountMinor: number;
  currency: string;
  description: string;
  customer: { name: string; email?: string; phone?: string };
  /** Absolute URLs the gateway sends the payer or its server back to. */
  urls: { success: string; fail: string; cancel: string; notify: string };
}

export interface CheckoutSession {
  sessionId: string;
  redirectUrl: string;
  raw: Record<string, unknown>;
}

/** The gateway's own answer about a payment, after we asked it (never the browser's word). */
export interface VerifiedPayment {
  status: 'succeeded' | 'failed' | 'pending';
  gatewayRef?: string;
  amountMinor?: number;
  currency?: string;
  reason?: string;
  raw: Record<string, unknown>;
}

export class GatewayError extends Error {
  constructor(
    readonly gateway: GatewayKey,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export const sslcommerzCredentials = z
  .object({ storeId: z.string().min(1), storePassword: z.string().min(1) })
  .strict();
export const bkashCredentials = z
  .object({
    appKey: z.string().min(1),
    appSecret: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();
export const stripeCredentials = z
  .object({
    secretKey: z.string().regex(/^sk_(test|live)_/, 'Must be a Stripe secret key'),
    webhookSecret: z.string().regex(/^whsec_/, 'Must be a Stripe webhook signing secret'),
  })
  .strict();
export const manualCredentials = z
  .object({
    instructions: z.string().max(2_000).default(''),
    accounts: z
      .array(
        z
          .object({
            method: z.enum(['bkash', 'nagad', 'rocket', 'bank']),
            label: z.string().max(80),
            account: z.string().max(120),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();

export const GATEWAY_CREDENTIAL_SCHEMAS = {
  sslcommerz: sslcommerzCredentials,
  bkash: bkashCredentials,
  stripe: stripeCredentials,
  manual: manualCredentials,
} as const;

export type GatewayCredentials = {
  sslcommerz: z.infer<typeof sslcommerzCredentials>;
  bkash: z.infer<typeof bkashCredentials>;
  stripe: z.infer<typeof stripeCredentials>;
  manual: z.infer<typeof manualCredentials>;
};

/** Currencies each gateway can take. bKash is BDT only. */
export const GATEWAY_CURRENCIES: Record<GatewayKey, readonly string[] | 'any'> = {
  sslcommerz: ['BDT', 'USD', 'EUR', 'GBP', 'SGD', 'INR', 'MYR'],
  bkash: ['BDT'],
  stripe: 'any',
  manual: ['BDT'],
};

/** Decimal string with the currency's minor units, as BD gateways expect ("1250.00"). */
export function decimalAmount(minor: number, minorUnits = 2): string {
  if (minorUnits === 0) return String(minor);
  const div = 10 ** minorUnits;
  return `${Math.floor(minor / div)}.${String(minor % div).padStart(minorUnits, '0')}`;
}

/** Reads a scalar field from a gateway JSON body as text; anything else becomes `fallback`. */
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
