import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { safeEqual } from '../../../common/crypto/tokens.js';
import { AppConfig } from '../../../config/app-config.js';
import {
  SMS_FETCH,
  SmsError,
  type SmsCallbackStatus,
  type SmsContext,
  type SmsDescriptor,
  type SmsErrorKind,
  type SmsProvider,
  type SmsSendRequest,
  type SmsSendResult,
} from '../sms.types.js';
import { SmsHttp, asText, field, shortText } from './sms-http.js';

const credentials = z
  .object({
    accountSid: z
      .string()
      .trim()
      .regex(/^AC[0-9a-fA-F]{32}$/, 'An Account SID starts with AC and has 34 characters'),
    authToken: z.string().trim().min(16).max(100),
  })
  .strict();
export type TwilioCredentials = z.infer<typeof credentials>;

/** Twilio error codes Sellora treats specially; everything else in 4xx is a refusal. */
const CODES: Record<string, SmsErrorKind> = {
  '20003': 'auth',
  '20404': 'auth',
  '20429': 'busy',
  '30001': 'busy',
  '21606': 'rejected',
  '21211': 'rejected',
  '21610': 'rejected',
  '21614': 'rejected',
};

/**
 * Twilio Programmable Messaging. POST /2010-04-01/Accounts/{sid}/Messages.json (form body:
 * To, From or MessagingServiceSid, Body, StatusCallback) with HTTP Basic auth; the balance
 * call checks credentials. Twilio reports delivery to the status callback, signed with the
 * auth token (X-Twilio-Signature: HMAC-SHA1 of the URL and the sorted form fields).
 */
@Injectable()
export class TwilioProvider implements SmsProvider<TwilioCredentials> {
  readonly descriptor: SmsDescriptor = {
    key: 'twilio',
    name: 'Twilio',
    credentialFields: [
      { key: 'accountSid', label: 'Account SID', secret: false, help: 'Twilio Console › Account' },
      { key: 'authToken', label: 'Auth token', secret: true },
    ],
    senderId: 'required',
    senderIdHelp:
      'A Twilio number in +E.164 form, an alphanumeric sender where the country allows it, or a Messaging Service SID (MG…).',
    reach: 'any',
    deliveryReports: true,
    canVerify: true,
  };
  readonly credentials = credentials;
  private readonly http: SmsHttp;
  private readonly base: string;

  constructor(@Inject(SMS_FETCH) fetchFn: typeof fetch, config: AppConfig) {
    this.http = new SmsHttp(fetchFn, 'Twilio', config.get('SMS_HTTP_TIMEOUT_MS'));
    this.base = config.get('SMS_TWILIO_BASE_URL').replace(/\/$/, '');
  }

  hint(c: TwilioCredentials): string {
    return `Account ${c.accountSid.slice(0, 6)}…${c.accountSid.slice(-4)}`;
  }

  private auth(c: TwilioCredentials): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`,
    };
  }

  async verify(ctx: SmsContext<TwilioCredentials>): Promise<{ summary: string }> {
    const { status, body } = await this.http.send({
      method: 'GET',
      url: `${this.base}/2010-04-01/Accounts/${ctx.credentials.accountSid}/Balance.json`,
      headers: this.auth(ctx.credentials),
    });
    if (status >= 300) throw this.error(status, body);
    const balance = Number(field(body, 'balance'));
    const currency = asText(field(body, 'currency'));
    return {
      summary: Number.isFinite(balance)
        ? `Connected. Balance ${balance.toFixed(2)} ${currency}.`.replace(' .', '.')
        : 'Connected.',
    };
  }

  async send(ctx: SmsContext<TwilioCredentials>, req: SmsSendRequest): Promise<SmsSendResult> {
    if (!ctx.senderId) throw new SmsError('rejected', 'Twilio needs a sender (From).');
    const sender: Record<string, string> = ctx.senderId.startsWith('MG')
      ? { MessagingServiceSid: ctx.senderId }
      : { From: ctx.senderId };
    const { status, body } = await this.http.send({
      method: 'POST',
      url: `${this.base}/2010-04-01/Accounts/${ctx.credentials.accountSid}/Messages.json`,
      headers: this.auth(ctx.credentials),
      form: {
        To: req.to,
        Body: req.text,
        ...sender,
        ...(ctx.statusCallbackUrl ? { StatusCallback: ctx.statusCallbackUrl } : {}),
      },
      sends: true,
    });
    if (status >= 300) throw this.error(status, body);
    const sid = field(body, 'sid');
    return {
      ...(typeof sid === 'string' ? { providerMessageId: sid } : {}),
      providerStatus: asText(field(body, 'status'), 'queued'),
    };
  }

  readCallback(
    c: TwilioCredentials,
    call: { url: string; params: Record<string, string>; headers: Record<string, string> },
  ): SmsCallbackStatus | null {
    const signature = call.headers['x-twilio-signature'] ?? '';
    if (!signature || !safeEqual(signature, twilioSignature(c.authToken, call.url, call.params)))
      return null;
    const id = call.params.MessageSid;
    const word = call.params.MessageStatus;
    if (!id || !word) return null;
    if (word === 'delivered') return { providerMessageId: id, status: 'delivered' };
    if (word === 'undelivered' || word === 'failed')
      return {
        providerMessageId: id,
        status: 'failed',
        error: `Twilio: not delivered${call.params.ErrorCode ? ` (${call.params.ErrorCode})` : ''}.`,
      };
    if (word === 'sent') return { providerMessageId: id, status: 'sent' };
    return null;
  }

  private error(status: number, body: unknown): SmsError {
    const code = asText(field(body, 'code'));
    const text = shortText(field(body, 'message') ?? '');
    const kind: SmsErrorKind =
      CODES[code] ??
      (status === 401 || status === 403 ? 'auth' : status === 429 ? 'busy' : 'rejected');
    return new SmsError(
      kind,
      `Twilio refused the request${code ? ` (${code})` : ` (HTTP ${status})`}${text ? `: ${text}` : '.'}`,
      code || undefined,
    );
  }
}

/** Twilio's request signature: base64 HMAC-SHA1 of the URL followed by each sorted key and value. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}
