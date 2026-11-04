import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../../../config/app-config.js';
import {
  SMS_FETCH,
  SmsError,
  bdMsisdn,
  maskedHint,
  type SmsContext,
  type SmsDescriptor,
  type SmsErrorKind,
  type SmsProvider,
  type SmsSendRequest,
  type SmsSendResult,
} from '../sms.types.js';
import { SmsHttp, asText, field, shortText } from './sms-http.js';

const credentials = z.object({ apiKey: z.string().trim().min(8).max(200) }).strict();
export type AlphaSmsCredentials = z.infer<typeof credentials>;

/** Alpha SMS's `error` codes (0 is success), sorted by what Sellora does about them. */
const CODES: Record<string, { kind: SmsErrorKind; message: string }> = {
  '400': { kind: 'rejected', message: 'A parameter was missing or invalid' },
  '403': { kind: 'auth', message: 'The API key may not do this' },
  '404': { kind: 'rejected', message: 'Not found' },
  '405': { kind: 'auth', message: 'The API key was not accepted' },
  '409': { kind: 'unavailable', message: 'The provider had an unknown error' },
  '410': { kind: 'auth', message: 'The account has expired' },
  '411': { kind: 'auth', message: 'The reseller account has expired or is suspended' },
  '412': { kind: 'rejected', message: 'The schedule is invalid' },
  '413': { kind: 'rejected', message: 'The sender id is invalid' },
  '414': { kind: 'rejected', message: 'The message is empty' },
  '415': { kind: 'rejected', message: 'The message is too long' },
  '416': { kind: 'rejected', message: 'No valid number was found' },
  '417': { kind: 'balance', message: 'The SMS balance is too low' },
  '420': { kind: 'rejected', message: 'The message content was blocked' },
};

/**
 * Alpha SMS (sms.net.bd, Alpha Net). API: POST /sendsms with api_key, msg, to (880…) and an
 * optional sender_id; GET /user/balance/ for the balance. Answers carry `error` (0 means
 * accepted), `msg` and `data.request_id`.
 */
@Injectable()
export class AlphaSmsProvider implements SmsProvider<AlphaSmsCredentials> {
  readonly descriptor: SmsDescriptor = {
    key: 'alpha_sms',
    name: 'Alpha SMS (sms.net.bd)',
    credentialFields: [{ key: 'apiKey', label: 'API key', secret: true, help: 'SMS panel › API' }],
    senderId: 'optional',
    senderIdHelp: 'Your approved sender id. Leave empty to use the account default.',
    reach: 'bd_mobile',
    deliveryReports: false,
    canVerify: true,
  };
  readonly credentials = credentials;
  private readonly http: SmsHttp;
  private readonly base: string;

  constructor(@Inject(SMS_FETCH) fetchFn: typeof fetch, config: AppConfig) {
    this.http = new SmsHttp(fetchFn, 'Alpha SMS', config.get('SMS_HTTP_TIMEOUT_MS'));
    this.base = config.get('SMS_ALPHA_BASE_URL').replace(/\/$/, '');
  }

  hint(c: AlphaSmsCredentials): string {
    return maskedHint('API key', c.apiKey);
  }

  async verify(ctx: SmsContext<AlphaSmsCredentials>): Promise<{ summary: string }> {
    const url = `${this.base}/user/balance/?${new URLSearchParams({ api_key: ctx.credentials.apiKey }).toString()}`;
    const { body } = await this.http.send({ method: 'GET', url });
    const code = asText(field(body, 'error'));
    if (code !== '0') throw this.error(code, body);
    const balance = Number(field(field(body, 'data'), 'balance'));
    return {
      summary: Number.isFinite(balance)
        ? `Connected. Balance ৳${balance.toFixed(2)}.`
        : 'Connected.',
    };
  }

  async send(ctx: SmsContext<AlphaSmsCredentials>, req: SmsSendRequest): Promise<SmsSendResult> {
    const { body } = await this.http.send({
      method: 'POST',
      url: `${this.base}/sendsms`,
      form: {
        api_key: ctx.credentials.apiKey,
        msg: req.text,
        to: bdMsisdn(req.to),
        ...(ctx.senderId ? { sender_id: ctx.senderId } : {}),
      },
      sends: true,
    });
    const code = asText(field(body, 'error'));
    if (code !== '0') throw this.error(code, body);
    const id = field(field(body, 'data'), 'request_id');
    return {
      ...(id !== undefined && id !== null ? { providerMessageId: asText(id) } : {}),
      providerStatus: shortText(field(body, 'msg') ?? 'accepted'),
    };
  }

  private error(code: string, body: unknown): SmsError {
    const known = CODES[code];
    const text = shortText(field(body, 'msg') ?? (typeof body === 'string' ? body : ''));
    if (known)
      return new SmsError(
        known.kind,
        `Alpha SMS: ${known.message} (${code})${text && text !== known.message ? `: ${text}` : ''}.`,
        code,
      );
    return new SmsError(
      'rejected',
      `Alpha SMS refused the request${code ? ` (${code})` : ''}${text ? `: ${text}` : '.'}`,
      code || undefined,
    );
  }
}
