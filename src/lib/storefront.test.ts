import { describe, expect, it } from 'vitest';
import { MAX_LINES, MAX_QUANTITY, addLine, parseCart, setLineQuantity } from './cart-lines';
import { contrast, readableOn } from './color';
import { currencyExponent, formatMoney } from './money';
import { asciiDigits, isBdMobile } from './phone';
import { clientIp, sameOrigin } from './request';

const item = (variantId: string, quantity = 1) => ({
  productId: 'p'.repeat(24),
  variantId,
  quantity,
  slug: 'saree',
  name: 'Saree',
  variantTitle: '',
  image: null,
  priceMinor: 100_00,
});

describe('cart lines', () => {
  it('reads only well-formed saved lines and keeps quantities in range', () => {
    expect(parseCart(null)).toEqual([]);
    expect(parseCart('not json')).toEqual([]);
    expect(parseCart('{"a":1}')).toEqual([]);
    const saved = JSON.stringify([item('a', 0), item('b', 999), { variantId: 'c' }, null]);
    expect(parseCart(saved).map((i) => [i.variantId, i.quantity])).toEqual([
      ['a', 1],
      ['b', MAX_QUANTITY],
    ]);
  });

  it('adds to an existing line and caps the quantity', () => {
    let cart = addLine([], item('a', 2));
    cart = addLine(cart, item('a', 3));
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(5);
    cart = addLine(cart, item('a', 100));
    expect(cart[0]!.quantity).toBe(MAX_QUANTITY);
  });

  it('drops the oldest line when the cart is full', () => {
    let cart: ReturnType<typeof parseCart> = [];
    for (let i = 0; i <= MAX_LINES; i++) cart = addLine(cart, item(`v${i}`));
    expect(cart).toHaveLength(MAX_LINES);
    expect(cart[0]!.variantId).toBe('v1');
  });

  it('sets a quantity between 1 and the cap', () => {
    const cart = [item('a', 2)];
    expect(setLineQuantity(cart, 'a', 0)[0]!.quantity).toBe(1);
    expect(setLineQuantity(cart, 'a', 7.8)[0]!.quantity).toBe(7);
    expect(setLineQuantity(cart, 'a', 1000)[0]!.quantity).toBe(MAX_QUANTITY);
  });
});

describe('money', () => {
  it('knows how many minor units a currency has', () => {
    expect(currencyExponent('BDT')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
  });

  it('shows whole taka without decimals and poisha when there are some', () => {
    expect(formatMoney(125_000, 'BDT', 'en')).toBe('৳1,250');
    expect(formatMoney(125_050, 'BDT', 'en')).toBe('৳1,250.50');
    expect(formatMoney(125_000, 'BDT', 'bn')).toMatch(/১,২৫০/);
    expect(formatMoney(1250, 'JPY', 'en')).toMatch(/1,250/);
  });
});

describe('phone numbers', () => {
  it('reads Bangla digits', () => {
    expect(asciiDigits('০১৭১১০০০১১১')).toBe('01711000111');
  });

  it('accepts Bangladeshi mobiles in common forms only', () => {
    for (const ok of [
      '01711000111',
      '+8801711000111',
      '8801711000111',
      '017-1100 0111',
      '০১৮১২৩৪৫৬৭৮',
    ])
      expect(isBdMobile(ok)).toBe(true);
    for (const bad of ['0171100011', '01211000111', '+911711000111', 'call me'])
      expect(isBdMobile(bad)).toBe(false);
  });
});

describe('colours', () => {
  it('picks the text colour that reads better on a background', () => {
    expect(readableOn('#7a1f2b')).toBe('#ffffff');
    expect(readableOn('#b8860b')).toBe('#111111');
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
});

describe('requests', () => {
  it('trusts only as many forwarded addresses as there are proxies', () => {
    expect(clientIp('6.6.6.6, 203.0.113.9', null, 1)).toBe('203.0.113.9');
    expect(clientIp('6.6.6.6, 203.0.113.9, 10.0.0.2', null, 2)).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9', null, 3)).toBe('203.0.113.9');
    expect(clientIp('6.6.6.6', '198.51.100.1', 0)).toBe('198.51.100.1');
    expect(clientIp(null, null, 1)).toBeUndefined();
  });

  it('accepts browser posts only from the shop itself', () => {
    expect(sameOrigin(null, 'nakshi.sellora.shop')).toBe(true);
    expect(sameOrigin('https://nakshi.sellora.shop', 'nakshi.sellora.shop')).toBe(true);
    expect(sameOrigin('https://evil.example', 'nakshi.sellora.shop')).toBe(false);
    expect(sameOrigin('null', 'nakshi.sellora.shop')).toBe(false);
  });
});
