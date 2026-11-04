import { describe, expect, it } from 'vitest';
import { formatMoney, formatStorage, humanize, minorToInput, parseMoney } from './format';

describe('money', () => {
  it('formats minor units with the currency decimals', () => {
    expect(formatMoney(149_900, 'BDT')).toBe('৳1,499');
    expect(formatMoney(149_950, 'BDT')).toBe('৳1,499.50');
    expect(formatMoney(5_000, 'USD')).toBe('$50');
    expect(formatMoney(-223, 'BDT', { signed: true })).toBe('-৳2.23');
    expect(formatMoney(1234, 'JPY')).toBe('¥1,234');
  });

  it('parses typed amounts exactly, without float error', () => {
    expect(parseMoney('1,499.50', 'BDT')).toBe(149_950);
    expect(parseMoney('0.1', 'BDT')).toBe(10);
    expect(parseMoney('19.99', 'USD')).toBe(1999);
    expect(parseMoney('৳ 500', 'BDT')).toBe(50_000);
    expect(parseMoney('1.234', 'BDT')).toBeNull();
    expect(parseMoney('-5', 'BDT')).toBeNull();
    expect(parseMoney('abc', 'BDT')).toBeNull();
    expect(parseMoney('100', 'JPY')).toBe(100);
  });

  it('round-trips to an input value', () => {
    expect(minorToInput(149_950, 'BDT')).toBe('1499.50');
    expect(minorToInput(50_000, 'BDT')).toBe('500');
  });
});

describe('humanize', () => {
  it('turns keys into labels', () => {
    expect(humanize('inbox_reply')).toBe('Inbox reply');
    expect(humanize('platform.auth.login')).toBe('Platform auth login');
  });

  it('formats storage the way plan limits are written', () => {
    const MB = 1024 * 1024;
    expect(formatStorage(0)).toBe('0 bytes');
    expect(formatStorage(512)).toBe('512 bytes');
    expect(formatStorage(1536)).toBe('1.5 KB');
    expect(formatStorage(200 * MB)).toBe('200 MB');
    expect(formatStorage(2_000 * MB)).toBe('2 GB');
    expect(formatStorage(100_000 * MB)).toBe('100 GB');
    expect(formatStorage(2_500 * MB)).toBe('2.5 GB');
  });
});
