import { describe, expect, it } from 'vitest';
import type { Store, StoreDomain, StoreStatus } from './api/types';
import {
  canonicalJson,
  contrastRatio,
  domainNextStep,
  handleFormatOk,
  moveItem,
  newSection,
  newSectionId,
  primaryColourWarning,
  readinessSteps,
  sectionProblem,
  sectionSummary,
  storeActions,
  toHandle,
} from './stores';

describe('toHandle', () => {
  it('turns a store name into an address', () => {
    expect(toHandle('Nakshi Ghor')).toBe('nakshi-ghor');
    expect(toHandle('  Dhaka   Fashion & House!! ')).toBe('dhaka-fashion-house');
    expect(toHandle('Café Rùpa')).toBe('cafe-rupa');
  });

  it('drops what cannot be in an address and keeps it short', () => {
    expect(toHandle('নকশী ঘর')).toBe('');
    expect(toHandle('a'.repeat(40))).toHaveLength(32);
    expect(toHandle('-shop-')).toBe('shop');
  });
});

describe('handleFormatOk', () => {
  it('matches the API rules', () => {
    expect(handleFormatOk('nakshi-ghor')).toBe(true);
    expect(handleFormatOk('abc')).toBe(true);
    expect(handleFormatOk('ab')).toBe(false);
    expect(handleFormatOk('my--shop')).toBe(false);
    expect(handleFormatOk('-shop')).toBe(false);
    expect(handleFormatOk('Shop')).toBe(false);
    expect(handleFormatOk('a'.repeat(33))).toBe(false);
  });
});

describe('storeActions', () => {
  it('offers only the changes the status allows', () => {
    const cases: [StoreStatus, string[]][] = [
      ['draft', ['submit', 'delete']],
      ['rejected', ['submit', 'delete']],
      ['pending', ['withdraw', 'delete']],
      ['live', ['pause', 'delete']],
      ['paused', ['resume', 'delete']],
      ['suspended', []],
    ];
    for (const [status, actions] of cases) expect(storeActions(status)).toEqual(actions);
  });
});

describe('readinessSteps', () => {
  it('lists what is missing before review', () => {
    const store = {
      readiness: { activeProducts: 0, hasContact: false, ready: false },
    } as unknown as Store;
    expect(readinessSteps(store).map((s) => s.done)).toEqual([false, false]);
    const ready = {
      readiness: { activeProducts: 1, hasContact: true, ready: true },
    } as unknown as Store;
    const steps = readinessSteps(ready);
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps[0]!.label).toBe('1 active product to sell');
  });
});

describe('sections', () => {
  it('makes ids the API accepts', () => {
    for (let i = 0; i < 50; i++) expect(newSectionId()).toMatch(/^[a-z0-9]{8}$/);
  });

  it('starts new sections in the store language', () => {
    const hero = newSection('hero', 'bn', 'Nakshi Ghor', 'abcdef12');
    expect(hero).toMatchObject({ type: 'hero', heading: 'Nakshi Ghor', buttonLabel: 'এখনই কিনুন' });
    const products = newSection('products', 'en', 'x', 'abcdef13');
    expect(products).toMatchObject({ source: 'newest', limit: 8, categoryId: null });
  });

  it('summarises a section by its own words', () => {
    expect(sectionSummary(newSection('categories', 'en', 'x'))).toBe('Shop by category');
    const features = newSection('features', 'en', 'x');
    expect(sectionSummary(features)).toBe('Cash on delivery');
    const text = { ...newSection('text', 'en', 'x'), heading: '' } as ReturnType<typeof newSection>;
    expect(sectionSummary(text)).toBe('Text');
  });

  it('flags a category row without a category', () => {
    const row = newSection('products', 'en', 'x');
    expect(sectionProblem(row)).toBeNull();
    expect(sectionProblem({ ...row, source: 'category' } as typeof row)).toMatch(/category/);
  });

  it('moves sections and ignores moves past either end', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('colours', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(contrastRatio('red', '#ffffff')).toBeNull();
  });

  it('warns when the main colour is too light for buttons', () => {
    expect(primaryColourWarning('#7a1f2b')).toBeNull();
    expect(primaryColourWarning('#ffe066')).toMatch(/light/);
    expect(primaryColourWarning('#12')).toMatch(/#/);
  });
});

describe('canonicalJson', () => {
  it('ignores key order but not array order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      canonicalJson({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('custom domains', () => {
  const base: StoreDomain = {
    id: 'd1',
    storeId: 's1',
    domain: 'www.shop.com',
    displayDomain: 'www.shop.com',
    apex: false,
    status: 'pending',
    primary: false,
    url: 'https://www.shop.com',
    records: [],
    dns: null,
    nextCheckAt: null,
    verifiedAt: null,
    activatedAt: null,
    review: { decidedAt: null, reason: null },
    createdAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:00:00Z',
  };
  const dns = (ownership: boolean, routing: boolean) => ({
    checkedAt: '2026-10-28T00:00:00Z',
    ownership,
    routing,
    problems: [],
    found: { txt: [], cname: [], addresses: [] },
  });

  it('says which record a pending domain still waits for', () => {
    expect(domainNextStep(base)).toBe('Not checked yet.');
    expect(domainNextStep({ ...base, dns: dns(false, false) })).toBe(
      'Waiting for the TXT and CNAME record.',
    );
    expect(domainNextStep({ ...base, apex: true, dns: dns(true, false) })).toBe(
      'Waiting for the A record.',
    );
  });

  it('warns when a connected domain stops pointing at the store', () => {
    expect(domainNextStep({ ...base, status: 'active', primary: true, dns: dns(true, true) })).toBe(
      'Main address: shoppers on other addresses are sent here.',
    );
    expect(domainNextStep({ ...base, status: 'active', dns: dns(true, false) })).toMatch(
      /DNS changed/,
    );
  });
});
