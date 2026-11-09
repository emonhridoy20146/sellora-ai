import { describe, expect, it } from 'vitest';
import {
  changedAreas,
  changedTexts,
  stableJson,
  storeTexts,
  textChanges,
} from './store-changes.js';
import type { Store } from './schemas.js';

type Words = Pick<Store, 'name' | 'seo' | 'pages' | 'theme' | 'social' | 'checkout' | 'themeKey'>;

const base = (): Words => ({
  name: 'Kumartuli Crafts',
  themeKey: 'nakshi',
  seo: { title: 'Clay pots' },
  pages: { about: 'Handmade in Dhaka.' },
  social: { facebook: 'https://facebook.com/kumartuli' },
  checkout: { minOrderMinor: 0 },
  theme: {
    announcement: '',
    palette: { primary: '#7a2e1d', accent: '#e0a43a' },
    sections: [
      { id: 'h1', type: 'hero', enabled: true, heading: 'Clay from Kumartuli', subheading: '' },
    ],
  } as unknown as Store['theme'],
});

describe('store changes after approval', () => {
  it('lists the words shoppers read, leaving out empty ones', () => {
    expect(storeTexts(base()).map((t) => t.where)).toEqual([
      'name',
      'seo',
      'social',
      'page:about',
      'section:h1',
    ]);
    const withNote = { ...base(), checkout: { minOrderMinor: 0, note: 'Cash on delivery' } };
    expect(storeTexts(withNote).find((t) => t.where === 'checkout')?.text).toBe('Cash on delivery');
  });

  it('finds the areas an edit changed, whatever order the settings came in', () => {
    const a = base();
    const b = base();
    // The same settings with their keys in the opposite order.
    b.theme = Object.fromEntries(Object.entries(a.theme).reverse()) as Words['theme'];
    expect(stableJson(a.theme)).toBe(stableJson(b.theme));
    expect(changedAreas(a, b)).toEqual([]);
    b.name = 'Kumartuli Crafts BD';
    b.pages = { about: 'Handmade in Dhaka since 1980.' };
    b.checkout = { minOrderMinor: 50_000 };
    expect(changedAreas(a, b)).toEqual(['name', 'pages']);
    b.theme = { ...a.theme, palette: { primary: '#000000', accent: '#e0a43a' } };
    b.social = {};
    b.checkout = { minOrderMinor: 0, note: 'Call first' };
    expect(changedAreas(a, b)).toEqual(['name', 'design', 'pages', 'social', 'checkout']);
  });

  it('compares words with the approved copy; without a copy every word counts', () => {
    const before = storeTexts(base());
    const edited = { ...base(), pages: { about: 'Now with master copy bags.' } };
    expect(changedTexts(before, storeTexts(edited)).map((t) => t.where)).toEqual(['page:about']);
    expect(changedTexts(undefined, storeTexts(edited))).toHaveLength(5);
  });

  it('shows each change with the words before and now, new and removed', () => {
    const before = storeTexts(base());
    const now = storeTexts({
      ...base(),
      seo: {},
      checkout: { minOrderMinor: 0, note: 'Call first' },
      pages: { about: 'Handmade in Dhaka.' },
    });
    expect(textChanges(before, now)).toEqual([
      { where: 'checkout', label: 'Checkout note', before: null, now: 'Call first' },
      { where: 'seo', label: 'Search title and description', before: 'Clay pots', now: null },
    ]);
  });
});
