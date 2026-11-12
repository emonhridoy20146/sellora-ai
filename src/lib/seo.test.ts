import { describe, expect, it } from 'vitest';
import type { Product, SeoSuggestion } from './api/types';
import {
  applySuggestion,
  changeText,
  cut,
  draftKeywords,
  googlePreview,
  pageText,
  productSlug,
  scoreBand,
  seoDraftFrom,
  seoPayload,
  splitKeywords,
  totalsTiles,
} from './seo';

const product = {
  id: 'p1',
  name: 'Jamdani Saree',
  slug: 'jamdani-saree',
  previousSlugs: [],
  seo: {
    title: 'Jamdani saree, handwoven',
    description: 'Dhakai jamdani with cash on delivery.',
    keywords: ['jamdani saree', 'dhakai jamdani'],
    faq: [{ question: 'Is it handwoven?', answer: 'Yes.' }],
  },
} as unknown as Product;

const suggestion: SeoSuggestion = {
  focusKeyword: 'জামদানি শাড়ি',
  keywords: ['জামদানি শাড়ি', 'jamdani saree price'],
  seoTitle: 'জামদানি শাড়ি: হাতে বোনা ঢাকাই জামদানি',
  slug: 'jamdani-shari',
  metaDescription: 'হাতে বোনা ঢাকাই জামদানি শাড়ি, সারা দেশে ক্যাশ অন ডেলিভারি।',
  description: 'Long text',
  tags: ['jamdani'],
  imageAlts: ['Red jamdani saree'],
  faq: [{ question: 'কত দিনে ডেলিভারি?', answer: 'ঢাকায় ২ দিনে।' }],
};

describe('SEO helpers (ADR 0032)', () => {
  it('makes addresses the way the API does, keeping Bangla letters', () => {
    expect(productSlug('  Jamdani Saree (Red) ')).toBe('jamdani-saree-red');
    expect(productSlug('জামদানি শাড়ি')).toBe('জামদানি-শাড়ি');
    expect(productSlug('---')).toBe('');
  });

  it('splits keywords without repeats and caps them', () => {
    expect(splitKeywords(' saree, Saree ,  jamdani   saree,,')).toEqual(['saree', 'jamdani saree']);
    expect(splitKeywords(Array.from({ length: 15 }, (_, i) => `k${i}`).join(','))).toHaveLength(10);
  });

  it('cuts long text by visible characters with an ellipsis', () => {
    expect(cut('short', 10)).toBe('short');
    expect(cut('abcdefghijkl', 6)).toBe('abcde…');
    // শাড়ি is 2 visible characters (শা and ড়ি), so it fits in 2.
    expect(cut('শাড়ি', 2)).toBe('শাড়ি');
  });

  it('previews the Google result with the store name and address', () => {
    const p = googlePreview({
      storeName: 'Nakshi Ghor',
      storeUrl: 'https://nakshi.sellora.shop/',
      slug: 'jamdani-saree',
      title: '',
      name: 'Jamdani Saree',
      meta: '',
      description: 'Handwoven.',
    });
    expect(p).toEqual({
      title: 'Jamdani Saree | Nakshi Ghor',
      url: 'nakshi.sellora.shop › products › jamdani-saree',
      text: 'Handwoven.',
    });
  });

  it('round-trips the product fields and sends the address only when changed', () => {
    const d = seoDraftFrom(product);
    expect(d).toMatchObject({ focus: 'jamdani saree', more: 'dhakai jamdani' });
    expect(seoPayload(d, product)).toEqual({
      seo: {
        title: 'Jamdani saree, handwoven',
        description: 'Dhakai jamdani with cash on delivery.',
        keywords: ['jamdani saree', 'dhakai jamdani'],
        faq: [{ question: 'Is it handwoven?', answer: 'Yes.' }],
      },
    });
    const moved = seoPayload({ ...d, slug: 'Dhakai Jamdani' }, product);
    expect(moved.slug).toBe('dhakai-jamdani');
    // Half-written questions are not saved.
    expect(seoPayload({ ...d, faq: [{ question: 'Size?', answer: ' ' }] }).seo.faq).toEqual([]);
    // A new product without an address lets the API make one from the name.
    expect(seoPayload(seoDraftFrom())).not.toHaveProperty('slug');
  });

  it('applies only the suggestion fields asked for', () => {
    const d = seoDraftFrom(product);
    const next = applySuggestion(d, suggestion, ['title', 'keywords']);
    expect(next.title).toBe(suggestion.seoTitle);
    expect(draftKeywords(next)).toEqual(['জামদানি শাড়ি', 'jamdani saree price']);
    expect(next.meta).toBe(d.meta);
    expect(next.slug).toBe('jamdani-saree');
    expect(applySuggestion(d, suggestion, ['slug', 'faq'])).toMatchObject({
      slug: 'jamdani-shari',
      faq: suggestion.faq,
    });
  });

  it('bands scores and compares periods', () => {
    expect([scoreBand(80), scoreBand(79), scoreBand(49)]).toEqual(['good', 'fair', 'poor']);
    expect(changeText(120, 100)).toBe('+20%');
    expect(changeText(80, 100)).toBe('-20%');
    expect(changeText(5, 0)).toBeNull();
    const [, , , position] = totalsTiles(
      { clicks: 1, impressions: 10, ctr: 0.1, position: 8.2 },
      { clicks: 1, impressions: 10, ctr: 0.1, position: 9.5 },
    );
    // A lower position is an improvement.
    expect(position).toMatchObject({ value: '8.2', better: true });
  });

  it('reads the words of a page, not its links, ids or colours', () => {
    const text = pageText({
      sections: [
        {
          id: '5f1d7c2e9b1e8a3d4c5b6a71',
          kind: 'hero',
          headline: 'Eid offer on jamdani',
          image: { url: 'https://files.test/a.jpg', alt: 'Red saree' },
          color: '#ff0000',
        },
      ],
      offer: { packages: [{ label: 'Two sarees' }] },
    });
    expect(text.split('\n')).toEqual(['Eid offer on jamdani', 'Red saree', 'Two sarees']);
  });
});
