import { twilioSignature } from '../../src/modules/sms/providers/twilio.provider.js';

export type FakeSmsProvider = 'bulksmsbd' | 'alpha_sms' | 'ssl_wireless' | 'twilio';

export const BULKSMSBD_BASE = 'https://bulksmsbd.net';
export const ALPHA_BASE = 'https://api.sms.net.bd';
export const SSL_WIRELESS_BASE = 'https://smsplus.sslwireless.com';
export const TWILIO_BASE = 'https://api.twilio.com';

/** A message a fake provider accepted. */
export interface FakeSms {
  provider: FakeSmsProvider;
  /** The account that sent it (API key, token or account SID). */
  account: string;
  to: string;
  from: string;
  text: string;
  id: string;
  /** Twilio only: where delivery reports go. */
  statusCallback?: string;
}

/**
 * What the next send does instead of answering normally:
 * - lose-reply: the provider sends the message, then the connection drops;
 * - refused: the connection is refused (nothing sent);
 * - timeout: no answer in time (the provider may have sent it; this fake did not);
 * - a number: answer with that HTTP status and send nothing.
 */
export type SmsFault = 'lose-reply' | 'refused' | 'timeout' | number;

/** The request body the adapters send: always a string (JSON or a form). */
const bodyText = (init?: RequestInit): string => (typeof init?.body === 'string' ? init.body : '');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refusedError = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
  });
const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const resetError = () => Object.assign(new TypeError('fetch failed'), { cause: 'ECONNRESET' });

/**
 * Plays BulkSMSBD, Alpha SMS, SSL Wireless and Twilio for tests, following the request and
 * answer shapes in their public API documentation. It proves our side of the contract; it is
 * not the providers.
 */
export class FakeSmsProviders {
  readonly sent: FakeSms[] = [];
  readonly calls: { provider: FakeSmsProvider; method: string; path: string }[] = [];
  /** API keys BulkSMSBD and Alpha SMS accept, with the balance and approved sender ids. */
  readonly bulkKeys = new Map<string, { balance: number; senders: string[] }>();
  readonly alphaKeys = new Map<string, { balance: number }>();
  readonly sslTokens = new Map<string, { sids: string[] }>();
  /** Twilio accounts by SID: the auth token and the numbers it may send from. */
  readonly twilioAccounts = new Map<string, { authToken: string; from: string[] }>();
  /** Faults for the next sends, used up in order. */
  readonly faults: SmsFault[] = [];
  private seq = 0;

  reset(): void {
    this.sent.length = 0;
    this.calls.length = 0;
    this.faults.length = 0;
  }

  /** The messages sent to a number (E.164 or 880…). */
  to(number: string): FakeSms[] {
    const digits = number.replace(/^\+/, '');
    return this.sent.filter((m) => m.to.replace(/^\+/, '') === digits);
  }

  /** A signed Twilio delivery report for a message, as Twilio would post it. */
  twilioReport(m: FakeSms, status: 'delivered' | 'undelivered' | 'sent', errorCode?: string) {
    const account = this.twilioAccounts.get(m.account)!;
    const params: Record<string, string> = {
      MessageSid: m.id,
      MessageStatus: status,
      AccountSid: m.account,
      To: m.to,
      ...(errorCode ? { ErrorCode: errorCode } : {}),
    };
    return {
      url: m.statusCallback!,
      params,
      signature: twilioSignature(account.authToken, m.statusCallback!, params),
    };
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const provider = this.providerOf(url);
    this.calls.push({ provider, method, path: url.pathname });
    const sends =
      url.pathname.endsWith('/smsapi') ||
      url.pathname.endsWith('/sendsms') ||
      url.pathname.endsWith('/send-sms') ||
      url.pathname.endsWith('/Messages.json');
    const fault = sends ? this.faults.shift() : undefined;
    if (fault === 'refused') return Promise.reject(refusedError());
    if (fault === 'timeout') return Promise.reject(timeoutError());
    if (typeof fault === 'number') return Promise.resolve(json({ message: 'fault' }, fault));
    const answer = this.answer(provider, method, url, init);
    if (fault === 'lose-reply') return Promise.reject(resetError());
    return Promise.resolve(answer);
  };

  private providerOf(url: URL): FakeSmsProvider {
    const base = url.origin;
    if (base === BULKSMSBD_BASE) return 'bulksmsbd';
    if (base === ALPHA_BASE) return 'alpha_sms';
    if (base === SSL_WIRELESS_BASE) return 'ssl_wireless';
    if (base === TWILIO_BASE) return 'twilio';
    throw new Error(`FakeSmsProviders: unexpected request to ${url.href}`);
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(6, '0')}`;
  }

  private answer(
    provider: FakeSmsProvider,
    method: string,
    url: URL,
    init?: RequestInit,
  ): Response {
    switch (provider) {
      case 'bulksmsbd':
        return this.bulksmsbd(url);
      case 'alpha_sms':
        return this.alpha(method, url, init);
      case 'ssl_wireless':
        return this.sslWireless(init);
      case 'twilio':
        return this.twilio(method, url, init);
    }
  }

  private bulksmsbd(url: URL): Response {
    const q = Object.fromEntries(url.searchParams);
    const account = this.bulkKeys.get(q.api_key ?? '');
    if (url.pathname === '/api/getBalanceApi') {
      if (!account) return json({ response_code: 1011, error_message: 'User Id not found' });
      return json({ response_code: 202, balance: account.balance });
    }
    if (url.pathname !== '/api/smsapi') return json({ error: 'not found' }, 404);
    if (!account) return json({ response_code: 1011, error_message: 'User Id not found' });
    if (!q.senderid || !account.senders.includes(q.senderid))
      return json({ response_code: 1005, error_message: 'Sender Id not found' });
    if (!/^8801[3-9]\d{8}$/.test(q.number ?? ''))
      return json({ response_code: 1001, error_message: 'Invalid Number' });
    if (account.balance < 1)
      return json({ response_code: 1007, error_message: 'Balance Insufficient' });
    account.balance -= 1;
    const id = this.id('B');
    this.sent.push({
      provider: 'bulksmsbd',
      account: q.api_key!,
      to: q.number!,
      from: q.senderid,
      text: q.message ?? '',
      id,
    });
    return json({
      response_code: 202,
      message_id: id,
      success_message: 'SMS Submitted Successfully',
    });
  }

  private alpha(method: string, url: URL, init?: RequestInit): Response {
    if (url.pathname === '/user/balance/') {
      const account = this.alphaKeys.get(url.searchParams.get('api_key') ?? '');
      if (!account) return json({ error: 405, msg: 'Authorization Required' });
      return json({ error: 0, msg: 'Success', data: { balance: account.balance.toFixed(4) } });
    }
    if (url.pathname !== '/sendsms' || method !== 'POST')
      return json({ error: 404, msg: 'Not found' });
    const form = Object.fromEntries(new URLSearchParams(bodyText(init)));
    const account = this.alphaKeys.get(form.api_key ?? '');
    if (!account) return json({ error: 405, msg: 'Authorization Required' });
    if (!form.msg) return json({ error: 414, msg: 'Empty message' });
    if (!/^8801[3-9]\d{8}$/.test(form.to ?? ''))
      return json({ error: 416, msg: 'No valid number found' });
    if (account.balance < 1) return json({ error: 417, msg: 'Insufficient balance' });
    account.balance -= 1;
    const id = this.id('');
    this.sent.push({
      provider: 'alpha_sms',
      account: form.api_key!,
      to: form.to!,
      from: form.sender_id ?? '',
      text: form.msg,
      id,
    });
    return json({
      error: 0,
      msg: 'Request successfully submitted',
      data: { request_id: Number(id) },
    });
  }

  private sslWireless(init?: RequestInit): Response {
    const body = JSON.parse(bodyText(init) || '{}') as Record<string, string>;
    const account = this.sslTokens.get(body.api_token ?? '');
    if (!account)
      return json({ status: 'FAILED', status_code: 4001, error_message: 'Authentication failed' });
    if (!account.sids.includes(body.sid ?? ''))
      return json({ status: 'FAILED', status_code: 4003, error_message: 'Invalid SID' });
    const id = this.id('S');
    this.sent.push({
      provider: 'ssl_wireless',
      account: body.api_token!,
      to: body.msisdn ?? '',
      from: body.sid!,
      text: body.sms ?? '',
      id,
    });
    return json({
      status: 'SUCCESS',
      status_code: 200,
      error_message: '',
      smsinfo: [
        {
          sms_status: 'SUCCESS',
          status_message: 'Success',
          msisdn: body.msisdn,
          sms_type: 'EN',
          csms_id: body.csms_id,
          reference_id: id,
        },
      ],
    });
  }

  private twilio(method: string, url: URL, init?: RequestInit): Response {
    const m = /^\/2010-04-01\/Accounts\/([^/]+)\/(Messages|Balance)\.json$/.exec(url.pathname);
    if (!m) return json({ code: 20404, message: 'Not found' }, 404);
    const sid = decodeURIComponent(m[1]!);
    const account = this.twilioAccounts.get(sid);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const expected = account
      ? `Basic ${Buffer.from(`${sid}:${account.authToken}`).toString('base64')}`
      : null;
    if (!account || auth !== expected)
      return json({ code: 20003, message: 'Authenticate', status: 401 }, 401);
    if (m[2] === 'Balance') return json({ account_sid: sid, balance: '12.50', currency: 'USD' });
    if (method !== 'POST') return json({ code: 20004, message: 'Method not allowed' }, 405);
    const form = Object.fromEntries(new URLSearchParams(bodyText(init)));
    const from = form.From ?? form.MessagingServiceSid ?? '';
    if (!account.from.includes(from))
      return json(
        { code: 21606, message: 'The From phone number is not valid for this account' },
        400,
      );
    if (!/^\+[1-9]\d{6,14}$/.test(form.To ?? ''))
      return json({ code: 21211, message: "The 'To' number is not a valid phone number" }, 400);
    const id = this.id('SM');
    this.sent.push({
      provider: 'twilio',
      account: sid,
      to: form.To!,
      from,
      text: form.Body ?? '',
      id,
      ...(form.StatusCallback ? { statusCallback: form.StatusCallback } : {}),
    });
    return json({ sid: id, status: 'queued', to: form.To, from }, 201);
  }
}
