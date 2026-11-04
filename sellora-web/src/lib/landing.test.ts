import { describe, expect, it } from 'vitest';
import type { LandingContent, LandingSectionType } from './api/types';
import {
  LANDING_SECTION_TYPES,
  conversionText,
  isVideoLink,
  landingSectionProblem,
  landingSectionSummary,
  newLandingSection,
  newPackage,
  packagePrice,
  packageProblems,
  publishBlockers,
  sectionWords,
  slugProblem,
  toSlug,
} from './landing';

describe('page addresses', () => {
  it('match the API rules', () => {
    expect(slugProblem('aloe-offer')).toBeNull();
    expect(slugProblem('ab')).toMatch(/3 to 60/);
    expect(slugProblem('aloe--offer')).toMatch(/3 to 60/);
    expect(slugProblem('Aloe')).toMatch(/3 to 60/);
    expect(slugProblem('checkout')).toMatch(/used by the store/);
    expect(slugProblem('thank-you')).toMatch(/used by the store/);
  });

  it('are made from a name', () => {
    expect(toSlug('Aloe Vera Eid Offer!')).toBe('aloe-vera-eid-offer');
    expect(toSlug('Café  Rùpa -- 2026')).toBe('cafe-rupa-2026');
    expect(toSlug('অ্যালোভেরা')).toBe('');
    expect(toSlug(`${'a'.repeat(59)} b`)).toHaveLength(59);
  });
});

describe('sections', () => {
  it('starts every kind with valid fields in both languages', () => {
    for (const type of LANDING_SECTION_TYPES)
      for (const lang of ['en', 'bn'] as const) {
        const s = newLandingSection(type, lang, 'abc12345', Date.UTC(2026, 9, 28, 10, 30));
        expect(s).toMatchObject({ id: 'abc12345', type, enabled: true, hideOn: 'none' });
        expect(landingSectionSummary(s).length).toBeGreaterThan(0);
      }
    const countdown = newLandingSection(
      'countdown',
      'en',
      'cd000001',
      Date.UTC(2026, 9, 28, 10, 30),
    );
    expect(countdown).toMatchObject({ endsAt: '2026-10-31T10:00:00.000Z' });
    expect(newLandingSection('order_form', 'bn')).toMatchObject({
      buttonLabel: 'অর্ডার নিশ্চিত করুন',
    });
  });

  it('says what a shown section still needs, and ignores hidden ones', () => {
    const need = (type: LandingSectionType, patch: Record<string, unknown> = {}) =>
      landingSectionProblem({ ...newLandingSection(type, 'en'), ...patch } as never);
    expect(need('video')).toBe('Add the video link.');
    expect(need('video', { url: 'https://vimeo.com/1' })).toMatch(/YouTube or Facebook/);
    expect(need('video', { url: 'https://youtu.be/dQw4w9WgXcQ' })).toBeNull();
    expect(need('image')).toBe('Add the picture.');
    expect(need('image', { enabled: false })).toBeNull();
    expect(need('gallery')).toBeNull();
    expect(need('gallery', { source: 'custom' })).toMatch(/at least one/);
    expect(need('before_after')).toMatch(/both/);
    expect(need('countdown', { endsAt: null })).toMatch(/ends/);
    expect(
      need('reviews', { items: [{ name: 'Mina', text: '', rating: 5, image: null }] }),
    ).toMatch(/words or a screenshot/);
  });

  it('accepts only YouTube and Facebook videos', () => {
    expect(isVideoLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isVideoLink('https://m.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
    expect(isVideoLink('https://www.facebook.com/shop/videos/123/')).toBe(true);
    expect(isVideoLink('https://fb.watch/abc')).toBe(true);
    expect(isVideoLink('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isVideoLink('javascript:alert(1)')).toBe(false);
  });
});

describe('publishing', () => {
  const content = (patch: Partial<LandingContent> = {}): LandingContent => ({
    sections: [newLandingSection('hero', 'en'), newLandingSection('order_form', 'en')],
    offer: { productId: 'p'.repeat(24), packages: [], addOn: null, noteField: true },
    seo: { title: '', description: '', image: null, index: true },
    settings: { stickyButton: true, stickyLabel: '' },
    ...patch,
  });

  it('lists what stops the draft from going live', () => {
    expect(publishBlockers(content())).toEqual([]);
    expect(publishBlockers(content({ sections: [newLandingSection('hero', 'en')] }))).toEqual([
      'Show one order form on the page.',
    ]);
    expect(
      publishBlockers(
        content({ offer: { productId: null, packages: [], addOn: null, noteField: false } }),
      ),
    ).toEqual(['Choose the product this page sells.']);
    expect(
      publishBlockers(
        content({ sections: [...content().sections, newLandingSection('image', 'en')] }),
      ),
    ).toEqual(['Picture: Add the picture.']);
  });

  it("holds back the template's sample words until they are replaced or hidden", () => {
    const starter = new Set(['Write the first step.', 'A happy buyer']);
    const steps = {
      ...newLandingSection('steps', 'en'),
      steps: [{ text: ' Write the first step. ' }],
    };
    const reviews = {
      ...newLandingSection('reviews', 'en'),
      items: [{ name: 'A happy buyer', text: 'Loved it', rating: 5, image: null }],
    };
    const page = content({ sections: [...content().sections, steps, reviews] as never });
    expect(publishBlockers(page, starter)).toEqual([
      'How to use: Replace the template’s sample words with your own, or hide this section.',
      'Reviews: Replace the sample reviews with real ones from your buyers, or hide this section.',
    ]);
    // Without the list (still loading) the editor does not guess; the API checks again.
    expect(publishBlockers(page)).toEqual([]);
    expect(landingSectionProblem({ ...steps, enabled: false } as never, starter)).toBeNull();
    expect(
      landingSectionProblem({ ...steps, steps: [{ text: 'Shake well.' }] } as never, starter),
    ).toBeNull();
  });
});

describe('packages', () => {
  it('prices a package against the regular price', () => {
    expect(packagePrice({ quantity: 2, priceMinor: 80_000 }, 45_000)).toEqual({
      totalMinor: 80_000,
      regularMinor: 90_000,
      savingMinor: 10_000,
    });
    expect(packagePrice({ quantity: 3, priceMinor: null }, 45_000)).toEqual({
      totalMinor: 135_000,
      regularMinor: 135_000,
      savingMinor: 0,
    });
  });

  it('adds packages one piece larger, and flags bad ones', () => {
    const one = newPackage([], 'en');
    expect(one).toMatchObject({ quantity: 1, label: '1 piece', priceMinor: null });
    const two = newPackage([one], 'bn');
    expect(two).toMatchObject({ quantity: 2, label: '2টি' });
    expect(
      packageProblems(
        [
          { ...one, label: ' ' },
          { ...two, priceMinor: 100_000 },
        ],
        45_000,
      ),
    ).toEqual({
      [one.id]: 'Name the package.',
      [two.id]: 'This costs more than buying the pieces one by one.',
    });
  });
});

describe('conversionText', () => {
  it('reads like a percentage', () => {
    expect(conversionText(null)).toBe('–');
    expect(conversionText(0)).toBe('0%');
    expect(conversionText(0.032)).toBe('3.2%');
    expect(conversionText(0.5)).toBe('50%');
  });
});

describe('sectionWords', () => {
  it('lists every word a shopper reads, without ids or settings', () => {
    const words = sectionWords({
      id: 's1',
      type: 'reviews',
      enabled: true,
      hideOn: 'none',
      title: 'What buyers say',
      items: [
        { name: 'Rina', text: 'Cured my hair fall in a week', rating: 5, image: null },
        { name: '', text: '  ', rating: 4, image: null },
      ],
    });
    expect(words).toEqual([
      { key: 'Title', text: 'What buyers say' },
      { key: 'Items 1 · Name', text: 'Rina' },
      { key: 'Items 1 · Text', text: 'Cured my hair fall in a week' },
      { key: 'Items 1 · Rating', text: '5 of 5' },
      { key: 'Items 2 · Rating', text: '4 of 5' },
    ]);
  });

  it('includes video links and picture descriptions', () => {
    expect(
      sectionWords({
        id: 'v',
        type: 'video',
        enabled: true,
        hideOn: 'mobile',
        title: '',
        url: 'https://youtu.be/abc',
      }),
    ).toEqual([{ key: 'Url', text: 'https://youtu.be/abc' }]);
    expect(
      sectionWords({
        id: 'i',
        type: 'image',
        enabled: true,
        hideOn: 'none',
        caption: '',
        image: { fileId: 'f', url: 'https://cdn.test/a.webp', alt: 'Bottle on a table' },
      }),
    ).toEqual([{ key: 'Image', text: 'Picture: Bottle on a table' }]);
  });
});
