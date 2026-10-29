import type { z } from 'zod';

/** SMS providers Sellora can send through. Each has an adapter in ./providers. */
export const SMS_PROVIDER_KEYS = ['bulksmsbd', 'alpha_sms', 'ssl_wireless', 'twilio'] as const;
export type SmsProviderKey = (typeof SMS_PROVIDER_KEYS)[number];

/** Injection token for the fetch SMS adapters use, so tests can play the provider's part. */
export const SMS_FETCH = Symbol('SMS_FETCH');

/**
 * How a send failed, which decides what Sellora does next:
 * - rejected: the provider refused this message (number, text, sender). Nothing was sent.
 * - auth: the provider did not accept the credentials. Nothing was sent.
 * - balance: the provider account has no SMS balance left. Nothing was sent.
 * - busy: rate limited. Nothing was sent; try again later.
 * - unavailable: the provider could not be reached before it saw the request. Try again.
 * - uncertain: the request was sent but the answer was lost; the provider may have sent the
 *   message, so it must not be sent again.
 */
export type SmsErrorKind = 'rejected' | 'auth' | 'balance' | 'busy' | 'unavailable' | 'uncertain';

export class SmsError extends Error {
  constructor(
    readonly kind: SmsErrorKind,
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'SmsError';
  }
}

/** A credential copied from the provider's panel. */
export interface SmsField {
  key: string;
  label: string;
  /** Never shown again after saving. */
  secret: boolean;
  help?: string;
}

export interface SmsDescriptor {
  key: SmsProviderKey;
  name: string;
  credentialFields: SmsField[];
  /** Whether a sender id must be given, and what the provider calls it. */
  senderId: 'required' | 'optional';
  senderIdHelp: string;
  /** Numbers the provider can reach: Bangladeshi mobiles only, or any country. */
  reach: 'bd_mobile' | 'any';
  /** The provider reports delivery to the handset (by a callback Sellora can check). */
  deliveryReports: boolean;
  /** Credentials can be checked without sending (a balance call). */
  canVerify: boolean;
}

export interface SmsContext<C> {
  credentials: C;
  senderId?: string;
  /** Where the provider should report delivery, for providers that do. */
  statusCallbackUrl?: string;
}

export interface SmsSendRequest {
  /** E.164: +8801712345678. */
  to: string;
  text: string;
  /** Sellora's message id, unique; providers that accept a client reference get it. */
  reference: string;
  /** The text needs Unicode (Bangla, emoji); some providers want to be told. */
  unicode: boolean;
}

export interface SmsSendResult {
  providerMessageId?: string;
  /** The provider's own word for what happened, kept as it came. */
  providerStatus: string;
}

/** What a delivery callback says about a message, in Sellora's words. */
export interface SmsCallbackStatus {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'failed';
  error?: string;
}

/**
 * One SMS provider's API behind a common shape. Everything provider-specific (addresses,
 * parameter names, number formats, answer codes) stays inside the adapter.
 */
export interface SmsProvider<C = unknown> {
  readonly descriptor: SmsDescriptor;
  readonly credentials: z.ZodType<C>;
  /** A non-secret hint to recognise the credentials later (masked key, account id). */
  hint(credentials: C): string;
  /** Checks the credentials with a call that sends nothing (balance). */
  verify?(ctx: SmsContext<C>): Promise<{ summary: string }>;
  send(ctx: SmsContext<C>, req: SmsSendRequest): Promise<SmsSendResult>;
  /**
   * Reads a delivery callback, after checking that it comes from the provider. Null when the
   * callback is not genuine or says nothing Sellora tracks.
   */
  readCallback?(
    credentials: C,
    call: { url: string; params: Record<string, string>; headers: Record<string, string> },
  ): SmsCallbackStatus | null;
}

/** Bangladeshi mobile numbers in E.164: +8801 then 3–9, then 8 digits. */
export const BD_MOBILE_RE = /^\+8801[3-9]\d{8}$/;

/** The number as Bangladeshi providers want it: 8801712345678 (no plus). */
export function bdMsisdn(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** Whether a provider can reach this number at all. */
export function canReach(reach: SmsDescriptor['reach'], e164: string): boolean {
  return reach === 'any' ? /^\+[1-9]\d{6,14}$/.test(e164) : BD_MOBILE_RE.test(e164);
}

/** The last characters of a secret, for recognising it later. */
export function maskedHint(label: string, value: string): string {
  return `${label} …${value.slice(-4)}`;
}
