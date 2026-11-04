import { describe, expect, it } from 'vitest';
import {
  FAILURE_HELP,
  PURPOSE_LABEL,
  STATUS_LABEL,
  lengthSummary,
  messageCost,
  renderSms,
  senderNameProblem,
  smsLength,
  unknownPlaceholders,
} from './sms';

describe('SMS length (same counting as the API)', () => {
  it('counts English in 160, then 153 per part', () => {
    expect(smsLength('a'.repeat(160))).toMatchObject({ parts: 1, remaining: 0, perPart: 160 });
    expect(smsLength('a'.repeat(161))).toMatchObject({ parts: 2, perPart: 153 });
    expect(smsLength('Price: €5')).toMatchObject({ encoding: 'gsm', units: 10 });
  });

  it('counts Bangla and emoji in 70, then 67 per part', () => {
    expect(smsLength('ধ'.repeat(70))).toMatchObject({ encoding: 'unicode', parts: 1 });
    expect(smsLength('ধ'.repeat(71))).toMatchObject({ parts: 2, perPart: 67 });
    expect(smsLength('Hi 😊').units).toBe(5);
  });

  it('summarises the length in words', () => {
    expect(lengthSummary(smsLength(''))).toBe('Empty');
    expect(lengthSummary(smsLength('Hello'))).toBe(
      '1 SMS part (English) · 155 characters left in this part',
    );
    expect(lengthSummary(smsLength('ধ'.repeat(71)))).toBe(
      '2 SMS parts (Bangla/Unicode) · 63 characters left in this part',
    );
  });
});

describe('templates', () => {
  it('fill like the API, leaving no gaps for missing values', () => {
    expect(
      renderSms('Your order {order} is on its way. Track it: {tracking} {shop}', {
        order: 'SL-1',
        tracking: '',
        shop: 'Nakshi',
      }),
    ).toBe('Your order SL-1 is on its way. Track it: Nakshi');
    expect(
      renderSms('Order {order} ({total}) {shop}', { order: 'SL-1', total: '', shop: 'Nakshi' }),
    ).toBe('Order SL-1 Nakshi');
    expect(renderSms('It’s “done”', {})).toBe('It\'s "done"');
  });

  it('find placeholders a message cannot fill', () => {
    expect(unknownPlaceholders('{name} {coupon} {coupon}', ['name'])).toEqual(['coupon']);
  });

  it('cost only when Sellora SMS charges for it', () => {
    expect(messageCost(2, 50)).toBe(100);
    expect(messageCost(2, 0)).toBeNull();
    expect(messageCost(1, null)).toBeNull();
  });
});

describe('labels and checks', () => {
  it('has words for every status, purpose and failure', () => {
    expect(Object.keys(STATUS_LABEL)).toHaveLength(6);
    expect(Object.keys(PURPOSE_LABEL)).toHaveLength(8);
    expect(Object.keys(FAILURE_HELP)).toHaveLength(10);
  });

  it('checks sender names the way operators require', () => {
    expect(senderNameProblem('NakshiGhor')).toBeNull();
    expect(senderNameProblem('Nakshi Ghor')).toBe('English letters and digits only, no spaces');
    expect(senderNameProblem('ab')).toBe('3 to 11 characters');
    expect(senderNameProblem('NakshiGhorBD1')).toBe('3 to 11 characters');
    expect(senderNameProblem('12345')).toBe('At least one letter');
    expect(senderNameProblem('নকশি')).toBe('English letters and digits only, no spaces');
  });
});

describe('phones', () => {
  it('shows Bangladeshi numbers the local way', async () => {
    const { localPhone } = await import('./sms');
    expect(localPhone('+8801712345678')).toBe('01712345678');
    expect(localPhone('+447911123456')).toBe('+447911123456');
  });
});
