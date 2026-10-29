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
  type SmsProvider,
  type SmsSendRequest,
  type SmsSendResult,
} from '../sms.types.js';
import { SmsHttp, asText, field, shortText } from './sms-http.js';

const credentials = z.object({ apiToken: z.string().trim().min(8).max(300) }).strict();
export type SslWirelessCredentials = z.infer<typeof credentials>;

/**
 * SSL Wireless ISMS (smsplus.sslwireless.com), API v3. POST /api/v3/send-sms with a JSON body
 * of api_token, sid (the sender id), msisdn (880…), sms and csms_id (our unique reference).
 * The answer has `status` (SUCCESS or FAILED), `status_code`, `error_message` and `smsinfo`,
 * one entry per number with its own `sms_status`. There is no balance call, so credentials
 * are checked with the first message.
 */
@Injectable()
export class SslWirelessProvider implements SmsProvider<SslWirelessCredentials> {
  readonly descriptor: SmsDescriptor = {
    key: 'ssl_wireless',
    name: 'SSL Wireless',
    credentialFields: [
      { key: 'apiToken', label: 'API token', secret: true, help: 'ISMS panel › API' },
    ],
    senderId: 'required',
    senderIdHelp: 'The SID SSL Wireless gave your account (your masking or non-masking sender).',
    reach: 'bd_mobile',
    deliveryReports: false,
    canVerify: false,
  };
  readonly credentials = credentials;
  private readonly http: SmsHttp;
  private readonly base: string;

  constructor(@Inject(SMS_FETCH) fetchFn: typeof fetch, config: AppConfig) {
    this.http = new SmsHttp(fetchFn, 'SSL Wireless', config.get('SMS_HTTP_TIMEOUT_MS'));
    this.base = config.get('SMS_SSL_WIRELESS_BASE_URL').replace(/\/$/, '');
  }

  hint(c: SslWirelessCredentials): string {
    return maskedHint('API token', c.apiToken);
  }

  async send(ctx: SmsContext<SslWirelessCredentials>, req: SmsSendRequest): Promise<SmsSendResult> {
    if (!ctx.senderId) throw new SmsError('rejected', 'SSL Wireless needs the SID (sender id).');
    const { status, body } = await this.http.send({
      method: 'POST',
      url: `${this.base}/api/v3/send-sms`,
      json: {
        api_token: ctx.credentials.apiToken,
        sid: ctx.senderId,
        msisdn: bdMsisdn(req.to),
        sms: req.text,
        csms_id: req.reference,
      },
      sends: true,
    });
    const overall = asText(field(body, 'status')).toUpperCase();
    const info = field(body, 'smsinfo');
    const first = Array.isArray(info) ? (info[0] as unknown) : undefined;
    const each = asText(field(first, 'sms_status'), overall).toUpperCase();
    if (status < 300 && overall === 'SUCCESS' && each === 'SUCCESS') {
      const id = field(first, 'reference_id') ?? field(first, 'sms_id');
      return {
        ...(id !== undefined && id !== null ? { providerMessageId: asText(id) } : {}),
        providerStatus: 'SUCCESS',
      };
    }
    const code = asText(field(body, 'status_code'), String(status));
    const text = shortText(field(body, 'error_message') ?? field(first, 'status_message') ?? '');
    // 4001 is "Authentication failed"; a 401 or 403 means the same.
    const kind = code === '4001' || status === 401 || status === 403 ? 'auth' : 'rejected';
    throw new SmsError(
      kind,
      `SSL Wireless refused the message (${code})${text ? `: ${text}` : '.'}`,
      code,
    );
  }
}
