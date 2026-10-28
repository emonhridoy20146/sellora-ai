import { describe, expect, it } from 'vitest';
import { handleProblem, parseStoreHost, storeUrl } from './store-hosts.js';
import { precheckStore } from './store-precheck.js';
import { THEMES, starterSettings, suggestedThemes, themeSettingsSchema } from './themes.js';

describe('store addresses', () => {
  it('accepts DNS-safe handles and refuses the rest', () => {
    expect(handleProblem('nakshi-ghor')).toBeNull();
    expect(handleProblem('abc')).toBeNull();
    expect(handleProblem('ab')).toBe('format');
    expect(handleProblem('a'.repeat(33))).toBe('format');
    expect(handleProblem('-abc')).toBe('format');
    expect(handleProblem('abc-')).toBe('format');
    expect(handleProblem('ab--cd')).toBe('format');
    expect(handleProblem('Upper')).toBe('format');
    expect(handleProblem('বাংলা')).toBe('format');
    expect(handleProblem('admin')).toBe('reserved');
    expect(handleProblem('checkout')).toBe('reserved');
  });

  it('reads a Host header as a store subdomain or a domain of its own', () => {
    expect(parseStoreHost('Nakshi.Sellora.Shop', 'sellora.shop')).toEqual({
      kind: 'handle',
      handle: 'nakshi',
    });
    expect(parseStoreHost('nakshi.sellora.localhost:3100', 'sellora.localhost:3100')).toEqual({
      kind: 'handle',
      handle: 'nakshi',
    });
    expect(parseStoreHost('nakshi.sellora.shop.', 'sellora.shop')).toMatchObject({
      handle: 'nakshi',
    });
    expect(parseStoreHost('sellora.shop', 'sellora.shop')).toBeNull();
    expect(parseStoreHost('a.b.sellora.shop', 'sellora.shop')).toBeNull();
    expect(parseStoreHost('x.sellora.shop', 'sellora.shop')).toBeNull();
    expect(parseStoreHost('bad host', 'sellora.shop')).toBeNull();
    expect(parseStoreHost('shop.example.com', 'sellora.shop')).toEqual({
      kind: 'custom',
      host: 'shop.example.com',
    });
    expect(storeUrl('nakshi', 'Sellora.Shop', 'https')).toBe('https://nakshi.sellora.shop');
  });
});

describe('automatic store check', () => {
  it('flags risky words as whole words in English and as text in Bangla', () => {
    const flags = precheckStore([
      { where: 'name', label: 'Store name', text: 'Gadget Point' },
      { where: 'product:1', label: 'Product: Watch', text: 'Rolex MASTER COPY watch' },
      { where: 'product:2', label: 'Product: Tea', text: 'Organic green tea, no sugar' },
      { where: 'page:about', label: 'Page: about', text: 'আমরা ইয়াবা বিক্রি করি না' },
      { where: 'product:3', label: 'Product: Shotgun', text: 'Begun (brinjal) fresh' },
    ]);
    expect(flags.map((f) => [f.where, f.term])).toEqual([
      ['product:1', 'master copy'],
      ['page:about', 'ইয়াবা'],
    ]);
    expect(flags[0]!.reason).toMatch(/^Copies of brands:/);
  });

  it('stops at 50 flags', () => {
    const texts = Array.from({ length: 80 }, (_, i) => ({
      where: `product:${i}`,
      label: 'x',
      text: 'replica',
    }));
    expect(precheckStore(texts)).toHaveLength(50);
  });
});

describe('themes', () => {
  it('gives every theme valid starter settings in both languages', () => {
    for (const theme of THEMES)
      for (const lang of ['en', 'bn'] as const) {
        const settings = starterSettings(theme, 'A very long shop name '.repeat(5), lang);
        expect(themeSettingsSchema.safeParse(settings).success).toBe(true);
      }
  });

  it('suggests three themes, the best fit for the category first', () => {
    expect(suggestedThemes('fashion')).toEqual(['nakshi', 'bazaar', 'volt']);
    expect(new Set(suggestedThemes('grocery')).size).toBe(3);
  });
});
