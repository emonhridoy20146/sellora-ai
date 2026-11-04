import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALPHA_BASE,
  BULKSMSBD_BASE,
  FakeSmsProviders,
  SSL_WIRELESS_BASE,
  TWILIO_BASE,
} from '../../../test/helpers/fake-sms.js';
import type { AppConfig } from '../../config/app-config.js';
import { AlphaSmsProvider } from './providers/alpha-sms.provider.js';
import { BulkSmsBdProvider } from './providers/bulksmsbd.provider.js';
import { SmsHttp } from './providers/sms-http.js';
import { SslWirelessProvider } from './providers/ssl-wireless.provider.js';
import { TwilioProvider, twilioSignature } from './providers/twilio.provider.js';
import { MAX_SMS_PARTS, plainSmsText, smsLength } from './segments.js';
import { maskPhone } from './sms.service.js';
import { SmsError, bdMsisdn, canReach } from './sms.types.js';
import {
  DEFAULT_ORDER_TEMPLATES,
  ORDER_SMS_EVENTS,
  placeholdersFor,
  renderSms,
  smsMoney,
  unknownPlaceholders,
} from './templates.js';

const CONFIG: Record<string, unknown> = {
  SMS_BULKSMSBD_BASE_URL: BULKSMSBD_BASE,
  SMS_ALPHA_BASE_URL: ALPHA_BASE,
  SMS_SSL_WIRELESS_BASE_URL: SSL_WIRELESS_BASE,
  SMS_TWILIO_BASE_URL: TWILIO_BASE,
  SMS_HTTP_TIMEOUT_MS: 1000,
};
const config = { get: (key: string) => CONFIG[key] } as unknown as AppConfig;

const TO = '+8801712345678';
const send = (text: string, reference = 'ref-1') => ({
  to: TO,
  text,
  reference,
  unicode: smsLength(text).encoding === 'unicode',
});

/** Rejects with the SmsError a call throws, so tests can look at its kind. */
async function smsError(p: Promise<unknown>): Promise<SmsError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SmsError) return err;
    throw err;
  }
  throw new Error('expected an SmsError');
}

describe('message parts', () => {
  it('counts GSM text in 160 characters, then 153 per part', () => {
    expect(smsLength('')).toMatchObject({ encoding: 'gsm', parts: 0 });
    expect(smsLength('a'.repeat(160))).toMatchObject({
      encoding: 'gsm',
      units: 160,
      parts: 1,
      remaining: 0,
    });
    expect(smsLength('a'.repeat(161))).toMatchObject({ parts: 2, remaining: 306 - 161 });
    expect(smsLength('a'.repeat(306)).parts).toBe(2);
    expect(smsLength('a'.repeat(307)).parts).toBe(3);
  });

  it('counts the GSM extension characters twice', () => {
    expect(smsLength('{}[]~|^€\\')).toMatchObject({ encoding: 'gsm', units: 18 });
    expect(smsLength(`${'a'.repeat(159)}€`).parts).toBe(2);
  });

  it('switches to Unicode for Bangla and emoji: 70 per message, then 67 per part', () => {
    expect(smsLength('আপনার অর্ডার').encoding).toBe('unicode');
    expect(smsLength('ধ'.repeat(70)).parts).toBe(1);
    expect(smsLength('ধ'.repeat(71)).parts).toBe(2);
    expect(smsLength('ধ'.repeat(134)).parts).toBe(2);
    expect(smsLength('ধ'.repeat(135)).parts).toBe(3);
    // An emoji is two UTF-16 units.
    expect(smsLength('Thanks 😊')).toMatchObject({ encoding: 'unicode', units: 9 });
  });

  it('replaces look-alike characters that would force Unicode', () => {
    const text = plainSmsText('It’s “ready” – pick it up… now please​');
    expect(text).toBe('It\'s "ready" - pick it up... now please');
    expect(smsLength(text).encoding).toBe('gsm');
    // Bangla is left as it is.
    expect(plainSmsText('ধন্যবাদ')).toBe('ধন্যবাদ');
  });

  it('allows at most six parts', () => {
    expect(MAX_SMS_PARTS).toBe(6);
  });
});

describe('templates', () => {
  const values = {
    name: 'Rahim',
    order: 'SL-1024',
    total: 'Tk 1,250',
    shop: 'Nakshi Ghor',
    phone: '01712345678',
    courier: 'Steadfast',
    tracking: 'https://steadfast.com.bd/t/SF12AB34',
  };

  it('fills placeholders and tidies the gaps a missing value leaves', () => {
    expect(renderSms('Hi {name}, order {order} ({total}). {shop}', values)).toBe(
      'Hi Rahim, order SL-1024 (Tk 1,250). Nakshi Ghor',
    );
    expect(renderSms('Track it: {tracking} {shop}', { ...values, tracking: '' })).toBe(
      'Track it: Nakshi Ghor',
    );
    expect(renderSms('Order {order} ({total}) {shop}', { ...values, total: undefined })).toBe(
      'Order SL-1024 Nakshi Ghor',
    );
    expect(renderSms('Hi {name} , thanks !', values)).toBe('Hi Rahim, thanks!');
  });

  it('leaves placeholders it was not given, so a typo is visible', () => {
    expect(renderSms('Hi {nmae}', values)).toBe('Hi {nmae}');
  });

  it('knows which placeholders each message may use', () => {
    expect(placeholdersFor('order_placed')).not.toContain('tracking');
    expect(placeholdersFor('order_shipped')).toEqual(
      expect.arrayContaining(['courier', 'tracking']),
    );
    expect(
      unknownPlaceholders('Hi {name}, {tracking} {coupon}', placeholdersFor('order_placed')),
    ).toEqual(['tracking', 'coupon']);
  });

  it('writes money in a way that keeps English in GSM', () => {
    expect(smsMoney(125_000, 'BDT', 'en')).toBe('Tk 1,250');
    expect(smsMoney(125_050, 'BDT', 'en')).toBe('Tk 1,250.50');
    expect(smsMoney(4_999, 'USD', 'en')).toBe('USD 49.99');
    expect(smsMoney(125_000, 'BDT', 'bn')).toBe('১,২৫০৳');
    expect(smsLength(smsMoney(125_000, 'BDT', 'en')).encoding).toBe('gsm');
  });

  it('starts every English order message in one GSM part and every Bangla one in two', () => {
    for (const event of ORDER_SMS_EVENTS) {
      const en = smsLength(renderSms(DEFAULT_ORDER_TEMPLATES.en[event], values));
      expect(en, event).toMatchObject({ encoding: 'gsm' });
      expect(en.parts, event).toBeLessThanOrEqual(event === 'order_shipped' ? 2 : 1);
      const bn = smsLength(
        renderSms(DEFAULT_ORDER_TEMPLATES.bn[event], {
          ...values,
          total: smsMoney(125_000, 'BDT', 'bn'),
        }),
      );
      expect(bn.parts, event).toBeLessThanOrEqual(event === 'order_shipped' ? 3 : 2);
      expect(
        unknownPlaceholders(DEFAULT_ORDER_TEMPLATES.en[event], placeholdersFor(event)),
      ).toEqual([]);
      expect(
        unknownPlaceholders(DEFAULT_ORDER_TEMPLATES.bn[event], placeholdersFor(event)),
      ).toEqual([]);
    }
  });
});

describe('numbers', () => {
  it('reaches Bangladeshi mobiles only on local providers', () => {
    expect(canReach('bd_mobile', '+8801712345678')).toBe(true);
    expect(canReach('bd_mobile', '+8801212345678')).toBe(false);
    expect(canReach('bd_mobile', '+88029123456')).toBe(false);
    expect(canReach('bd_mobile', '+447700900123')).toBe(false);
    expect(canReach('any', '+447700900123')).toBe(true);
    expect(bdMsisdn('+8801712345678')).toBe('8801712345678');
  });

  it('masks numbers for lists and wallet history', () => {
    expect(maskPhone('+8801712345678')).toBe('017•••••678');
  });
});

describe('providers (against the fake)', () => {
  const fake = new FakeSmsProviders();
  const bulk = new BulkSmsBdProvider(fake.fetch, config);
  const alpha = new AlphaSmsProvider(fake.fetch, config);
  const ssl = new SslWirelessProvider(fake.fetch, config);
  const twilio = new TwilioProvider(fake.fetch, config);
  const BULK_KEY = 'bulk-api-key-0001';
  const ALPHA_KEY = 'alpha-api-key-0001';
  const SSL_TOKEN = 'ssl-api-token-0001';
  const TWILIO_SID = `AC${'a'.repeat(32)}`;
  const TWILIO_TOKEN = 'twilio-auth-token-0001';

  beforeEach(() => {
    fake.reset();
    fake.bulkKeys.set(BULK_KEY, { balance: 3, senders: ['8809617000000', 'NakshiGhor'] });
    fake.alphaKeys.set(ALPHA_KEY, { balance: 3 });
    fake.sslTokens.set(SSL_TOKEN, { sids: ['NAKSHI'] });
    fake.twilioAccounts.set(TWILIO_SID, { authToken: TWILIO_TOKEN, from: ['+15005550006'] });
  });

  it('BulkSMSBD: checks the key by balance, sends to 880…, and sorts its codes', async () => {
    const ctx = { credentials: { apiKey: BULK_KEY }, senderId: '8809617000000' };
    expect((await bulk.verify(ctx)).summary).toBe('Connected. Balance ৳3.00.');
    const sent = await bulk.send(ctx, send('Hello'));
    expect(sent.providerMessageId).toMatch(/^B/);
    expect(fake.sent[0]).toMatchObject({
      to: '8801712345678',
      from: '8809617000000',
      text: 'Hello',
    });

    const wrongKey = await smsError(bulk.verify({ credentials: { apiKey: 'not-the-key-123' } }));
    expect(wrongKey).toMatchObject({ kind: 'auth', providerCode: '1011' });
    const wrongSender = await smsError(bulk.send({ ...ctx, senderId: 'Other' }, send('Hi')));
    expect(wrongSender).toMatchObject({ kind: 'rejected', providerCode: '1005' });
    fake.bulkKeys.get(BULK_KEY)!.balance = 0;
    expect(await smsError(bulk.send(ctx, send('Hi')))).toMatchObject({ kind: 'balance' });
    expect(await smsError(bulk.send({ credentials: ctx.credentials }, send('Hi')))).toMatchObject({
      kind: 'rejected',
    });
  });

  it('Alpha SMS: posts a form; error 0 is success; codes sorted', async () => {
    const ctx = { credentials: { apiKey: ALPHA_KEY } };
    expect((await alpha.verify(ctx)).summary).toBe('Connected. Balance ৳3.00.');
    const sent = await alpha.send(ctx, send('আপনার অর্ডার'));
    expect(sent.providerMessageId).toMatch(/^\d+$/);
    expect(fake.sent[0]).toMatchObject({
      provider: 'alpha_sms',
      to: '8801712345678',
      text: 'আপনার অর্ডার',
    });
    expect(
      await smsError(alpha.send({ credentials: { apiKey: 'wrong-key-0000' } }, send('Hi'))),
    ).toMatchObject({
      kind: 'auth',
      providerCode: '405',
    });
    fake.alphaKeys.get(ALPHA_KEY)!.balance = 0;
    expect(await smsError(alpha.send(ctx, send('Hi')))).toMatchObject({
      kind: 'balance',
      providerCode: '417',
    });
  });

  it('SSL Wireless: JSON with our reference as csms_id; 4001 is a credentials problem', async () => {
    const ctx = { credentials: { apiToken: SSL_TOKEN }, senderId: 'NAKSHI' };
    expect('verify' in ssl).toBe(false);
    const sent = await ssl.send(ctx, send('Hello', 'msg-123'));
    expect(sent).toMatchObject({ providerStatus: 'SUCCESS' });
    expect(fake.sent[0]).toMatchObject({
      provider: 'ssl_wireless',
      from: 'NAKSHI',
      to: '8801712345678',
    });
    expect(
      await smsError(ssl.send({ ...ctx, credentials: { apiToken: 'wrong-token-00' } }, send('Hi'))),
    ).toMatchObject({ kind: 'auth', providerCode: '4001' });
    expect(await smsError(ssl.send({ ...ctx, senderId: 'OTHER' }, send('Hi')))).toMatchObject({
      kind: 'rejected',
      providerCode: '4003',
    });
  });

  it('Twilio: Basic auth, From or a Messaging Service, and a status callback', async () => {
    const ctx = {
      credentials: { accountSid: TWILIO_SID, authToken: TWILIO_TOKEN },
      senderId: '+15005550006',
      statusCallbackUrl: 'https://api.example.com/v1/public/sms/callbacks/twilio/abc',
    };
    expect((await twilio.verify(ctx)).summary).toBe('Connected. Balance 12.50 USD.');
    const sent = await twilio.send(ctx, { ...send('Hello'), to: '+447700900123' });
    expect(sent).toMatchObject({ providerStatus: 'queued' });
    expect(fake.sent[0]).toMatchObject({
      to: '+447700900123',
      statusCallback: ctx.statusCallbackUrl,
    });
    const wrong = {
      ...ctx,
      credentials: { accountSid: TWILIO_SID, authToken: 'another-token-0000' },
    };
    expect(await smsError(twilio.verify(wrong))).toMatchObject({
      kind: 'auth',
      providerCode: '20003',
    });
    expect(
      await smsError(twilio.send({ ...ctx, senderId: '+15005550001' }, send('Hi'))),
    ).toMatchObject({
      kind: 'rejected',
      providerCode: '21606',
    });
  });

  it('Twilio: reads only delivery reports signed with the account token', () => {
    const c = { accountSid: TWILIO_SID, authToken: TWILIO_TOKEN };
    const url = 'https://api.example.com/v1/public/sms/callbacks/twilio/abc';
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const headers = { 'x-twilio-signature': twilioSignature(TWILIO_TOKEN, url, params) };
    expect(twilio.readCallback(c, { url, params, headers })).toEqual({
      providerMessageId: 'SM1',
      status: 'delivered',
    });
    // Another URL, other fields or another token: not Twilio.
    expect(twilio.readCallback(c, { url: `${url}x`, params, headers })).toBeNull();
    expect(
      twilio.readCallback(c, { url, params: { ...params, MessageStatus: 'failed' }, headers }),
    ).toBeNull();
    expect(twilio.readCallback(c, { url, params, headers: {} })).toBeNull();
    const failed = { MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' };
    expect(
      twilio.readCallback(c, {
        url,
        params: failed,
        headers: { 'x-twilio-signature': twilioSignature(TWILIO_TOKEN, url, failed) },
      }),
    ).toMatchObject({ status: 'failed', error: expect.stringContaining('30003') });
  });

  it('Twilio: the signature matches the example in Twilio’s security documentation', () => {
    expect(
      twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
        CallSid: 'CA1234567890ABCDE',
        Caller: '+12349013030',
        Digits: '1234',
        From: '+12349013030',
        To: '+18005551212',
      }),
    ).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
});

describe('failures on the way to the provider', () => {
  const fake = new FakeSmsProviders();
  const http = new SmsHttp(fake.fetch, 'BulkSMSBD', 1000);
  const call = (sends: boolean) =>
    http.send({ method: 'GET', url: `${BULKSMSBD_BASE}/api/smsapi?api_key=x`, sends });

  beforeEach(() => fake.reset());

  it('a refused connection sent nothing: try again', async () => {
    fake.faults.push('refused');
    expect(await smsError(call(true))).toMatchObject({ kind: 'unavailable' });
  });

  it('a timeout or a dropped answer on a send may have sent it: never send again', async () => {
    fake.faults.push('timeout', 'lose-reply');
    expect(await smsError(call(true))).toMatchObject({ kind: 'uncertain' });
    expect(await smsError(call(true))).toMatchObject({ kind: 'uncertain' });
  });

  it('the same failures on a call that sends nothing can simply be retried', async () => {
    const timeout = new SmsHttp(
      () =>
        Promise.reject(
          Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          }),
        ),
      'BulkSMSBD',
      1000,
    );
    expect(
      await smsError(timeout.send({ method: 'GET', url: `${BULKSMSBD_BASE}/api/getBalanceApi` })),
    ).toMatchObject({ kind: 'unavailable' });
  });

  it('429 is busy, 503 is down (nothing sent), other 5xx answers may have sent it', async () => {
    fake.faults.push(429, 503, 500, 502);
    expect(await smsError(call(true))).toMatchObject({ kind: 'busy' });
    expect(await smsError(call(true))).toMatchObject({ kind: 'unavailable' });
    expect(await smsError(call(true))).toMatchObject({ kind: 'uncertain' });
    expect(await smsError(call(true))).toMatchObject({ kind: 'uncertain' });
  });
});
