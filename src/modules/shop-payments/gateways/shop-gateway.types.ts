import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { z } from 'zod';
import type { ShopGatewayKey } from '../../commerce/schemas.js';

/** What a payment start sends to a gateway. All amounts are the order's currency (BDT). */
export interface ShopStartRequest {
  /** Our reference for the attempt, sent as the gateway's order or transaction id. */
  ref: string;
  amountMinor: number;
  currency: string;
  description: string;
  customer: { name: string; phone: string; email?: string; address: string; city?: string };
  shopperIp?: string;
  /** Where the gateway sends the shopper back; `{outcome}` is replaced per gateway. */
  returnUrl: (outcome: 'done' | 'success' | 'fail' | 'cancel') => string;
  /** Where the gateway's server tells us (SSLCommerz IPN). */
  notifyUrl: string;
}

export interface ShopStarted {
  /** The gateway's own id for the payment (bKash paymentID, Nagad payment reference, ...). */
  sessionId: string;
  redirectUrl: string;
}

/**
 * The gateway's own answer about an attempt, after we asked it with the business's keys.
 * `settled` is true when the answer is final (complete, failed or cancelled at the gateway);
 * a cancel the browser reported is not settled, because only the gateway can say no money moved.
 */
export interface ShopVerified {
  status: 'succeeded' | 'failed' | 'cancelled' | 'pending';
  settled: boolean;
  gatewayRef?: string;
  amountMinor?: number;
  currency?: string;
  /** Our reference as the gateway knows the payment; must match the attempt. */
  ref?: string;
  reason?: string;
  raw?: Record<string, unknown>;
}

export interface ShopAttempt {
  ref: string;
  sessionId?: string;
}

export interface ShopGatewayField {
  key: string;
  label: string;
  secret: boolean;
  multiline?: boolean;
  placeholder?: string;
}

export interface ShopGatewayDescriptor {
  key: ShopGatewayKey;
  name: string;
  /** Shown to shoppers under the gateway's name. */
  shopperHint: string;
  fields: ShopGatewayField[];
  /** Whether the keys can be checked with the gateway before a payment. */
  checkable: boolean;
  help: string;
}

/** Each gateway as Sellora uses it for shops: start, verify after return, look up later. */
export interface ShopGatewayAdapter<C = Record<string, string>> {
  readonly descriptor: ShopGatewayDescriptor;
  readonly credentials: z.ZodType<C>;
  hint(c: C): string;
  /** Asks the gateway whether the keys work; `checked: false` when it has no way to. */
  check(c: C, sandbox: boolean): Promise<{ checked: boolean; summary: string }>;
  start(c: C, sandbox: boolean, req: ShopStartRequest): Promise<ShopStarted>;
  /** After the shopper came back, or a server notice, with what the gateway sent along. */
  complete(
    c: C,
    sandbox: boolean,
    attempt: ShopAttempt,
    outcome: 'done' | 'success' | 'fail' | 'cancel' | 'notify',
    params: Record<string, string>,
  ): Promise<ShopVerified>;
  /** What the gateway says now, without the browser (for shoppers who never came back). */
  lookup(c: C, sandbox: boolean, attempt: ShopAttempt): Promise<ShopVerified>;
}

const text = (max = 200) => z.string().trim().min(1).max(max);

export const shopGatewayCredentials = {
  bkash: z
    .object({ appKey: text(), appSecret: text(), username: text(), password: text() })
    .strict(),
  nagad: z
    .object({
      merchantId: z
        .string()
        .trim()
        .regex(/^\d{6,20}$/, 'The merchant id is the number Nagad gave you'),
      merchantNumber: z
        .string()
        .trim()
        .regex(/^01\d{9}$/, 'The 11-digit Nagad merchant number'),
      privateKey: text(10_000),
      publicKey: text(10_000),
    })
    .strict(),
  sslcommerz: z.object({ storeId: text(), storePassword: text() }).strict(),
  aamarpay: z.object({ storeId: text(), signatureKey: text() }).strict(),
  shurjopay: z
    .object({
      username: text(),
      password: text(),
      prefix: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{2,10}$/, 'The order prefix shurjoPay gave you (letters and digits)'),
    })
    .strict(),
} as const;

export type ShopGatewayCredentials = {
  [K in ShopGatewayKey]: z.infer<(typeof shopGatewayCredentials)[K]>;
};

/** "abcd…wxyz": enough to recognise a key without showing it. */
export function mask(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** Stable id for a set of credentials, for caches that must never mix businesses. */
export function credentialKey(sandbox: boolean, parts: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([sandbox, ...parts]))
    .digest('hex');
}

/** Some gateways require an email; shoppers may leave it out. Never delivered anywhere. */
export function shopperEmail(email: string | undefined, phone: string): string {
  return email?.trim() || `${phone.replace(/\D/g, '') || 'shopper'}@noemail.invalid`;
}

/** The shopper's IPv4 address, which Nagad asks for; loopback when there is none. */
export function shopperIpv4(ip: string | undefined): string {
  const v = ip?.replace(/^::ffff:/, '');
  return v && isIPv4(v) ? v : '127.0.0.1';
}
