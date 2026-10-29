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
export type BulkSmsBdCredentials = z.infer<typeof credentials>;

/** BulkSMSBD's answer codes (202 is success), sorted by what Sellora does about them. */
const CODES: Record<string, { kind: SmsErrorKind; message: string }> = {
  '1001': { kind: 'rejected', message: 'The number was refused as invalid' },
  '1002': { kind: 'rejected', message: 'The sender id is not correct or is disabled' },
  '1003': { kind: 'rejected', message: 'A required field was missing' },
  '1005': { kind: 'rejected', message: 'The sender id was not found on the account' },
  '1006': { kind: 'balance', message: 'The SMS balance has expired' },
  '1007': { kind: 'balance', message: 'The SMS balance is too low' },
  '1011': { kind: 'auth', message: 'The account was not found' },
  '1012': { kind: 'rejected', message: 'Masking SMS must be written in Bangla' },
  '1013': { kind: 'rejected', message: 'The sender id has no gateway on this API key' },
  '1014': { kind: 'rejected', message: 'The sender type was not found for this sender id' },
  '1015': { kind: 'rejected', message: 'The sender id has no valid gateway on this API key' },
  '1016': { kind: 'rejected', message: 'The sender id has no active price' },
  '1017': { kind: 'rejected', message: 'The sender id has no price' },
  '1018': { kind: 'auth', message: 'The account owner is disabled' },
  '1019': { kind: 'rejected', message: 'The sender type price is disabled' },
  '1020': { kind: 'auth', message: 'The parent account was not found' },
  '1021': { kind: 'auth', message: 'The parent account has no active price' },
  '1031': { kind: 'auth', message: 'The account is not verified' },
  '1032': { kind: 'auth', message: "The server's IP address is not on the account's allowed list" },
};

/**
 * BulkSMSBD (bulksmsbd.net). API: GET /api/smsapi with api_key, type, number (880…),
 * senderid and message; GET /api/getBalanceApi for the balance. Answers carry a
 * `response_code`: 202 means the message was accepted.
 */
@Injectable()
export class BulkSmsBdProvider implements SmsProvider<BulkSmsBdCredentials> {
  readonly descriptor: SmsDescriptor = {
    key: 'bulksmsbd',
    name: 'BulkSMSBD',
    credentialFields: [
      { key: 'apiKey', label: 'API key', secret: true, help: 'BulkSMSBD panel › API' },
    ],
    senderId: 'required',
    senderIdHelp:
      'Your approved sender id from the BulkSMSBD panel (a number, or your masking name).',
    reach: 'bd_mobile',
    deliveryReports: false,
    canVerify: true,
  };
  readonly credentials = credentials;
  private readonly http: SmsHttp;
  private readonly base: string;

  constructor(@Inject(SMS_FETCH) fetchFn: typeof fetch, config: AppConfig) {
    this.http = new SmsHttp(fetchFn, 'BulkSMSBD', config.get('SMS_HTTP_TIMEOUT_MS'));
    this.base = config.get('SMS_BULKSMSBD_BASE_URL').replace(/\/$/, '');
  }

  hint(c: BulkSmsBdCredentials): string {
    return maskedHint('API key', c.apiKey);
  }

  async verify(ctx: SmsContext<BulkSmsBdCredentials>): Promise<{ summary: string }> {
    const url = `${this.base}/api/getBalanceApi?${new URLSearchParams({ api_key: ctx.credentials.apiKey }).toString()}`;
    const { body } = await this.http.send({ method: 'GET', url });
    const code = asText(field(body, 'response_code'));
    if (code !== '202') throw this.error(code, body);
    const balance = Number(field(body, 'balance'));
    return {
      summary: Number.isFinite(balance)
        ? `Connected. Balance ৳${balance.toFixed(2)}.`
        : 'Connected.',
    };
  }

  async send(ctx: SmsContext<BulkSmsBdCredentials>, req: SmsSendRequest): Promise<SmsSendResult> {
    if (!ctx.senderId) throw new SmsError('rejected', 'BulkSMSBD needs a sender id.');
    const params = new URLSearchParams({
      api_key: ctx.credentials.apiKey,
      type: 'text',
      number: bdMsisdn(req.to),
      senderid: ctx.senderId,
      message: req.text,
    });
    const { body } = await this.http.send({
      method: 'GET',
      url: `${this.base}/api/smsapi?${params.toString()}`,
      sends: true,
    });
    const code = asText(field(body, 'response_code'));
    if (code !== '202') throw this.error(code, body);
    const id = field(body, 'message_id');
    return {
      ...(id !== undefined && id !== null && id !== '' ? { providerMessageId: asText(id) } : {}),
      providerStatus: shortText(field(body, 'success_message') ?? 'accepted'),
    };
  }

  private error(code: string, body: unknown): SmsError {
    const known = CODES[code];
    if (known) return new SmsError(known.kind, `BulkSMSBD: ${known.message} (${code}).`, code);
    const text = shortText(field(body, 'error_message') ?? (typeof body === 'string' ? body : ''));
    return new SmsError(
      'rejected',
      `BulkSMSBD refused the request${code ? ` (${code})` : ''}${text ? `: ${text}` : '.'}`,
      code || undefined,
    );
  }
}
