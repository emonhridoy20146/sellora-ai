import { describe, expect, it } from 'vitest';
import {
  containsKeyword,
  normalizeForMatch,
  scoreProductSeo,
  visibleLength,
  wordCount,
  type SeoInput,
} from './seo-score.js';

const base: SeoInput = {
  name: 'Jamdani Saree',
  slug: 'jamdani-saree',
  seoTitle: 'Jamdani Saree: handwoven Dhakai jamdani for Eid',
  metaDescription:
    'Handwoven Dhakai jamdani saree in soft cotton with bright motifs. Cash on delivery anywhere in Bangladesh, order today.',
  description: Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '),
  keywords: ['jamdani saree', 'dhakai jamdani'],
  images: [{ alt: 'Red jamdani saree' }],
  faqCount: 2,
};

describe('SEO score (ADR 0032)', () => {
  it('counts Bangla letters with their vowel signs once', () => {
    // শা + ড়ি: each letter with its vowel sign is one character on screen.
    expect(visibleLength('শাড়ি')).toBe(2);
    expect('শাড়ি'.length).toBe(5);
    expect(visibleLength('  abc  ')).toBe(3);
  });

  it('counts words in Bangla, English and Banglish, dropping punctuation and dari', () => {
    expect(wordCount('জামদানি শাড়ি। হাতে বোনা, নরম!')).toBe(5);
    expect(wordCount('Eid er notun collection - order korun')).toBe(6);
  });

  it('matches keywords on whole words, case and punctuation aside', () => {
    expect(normalizeForMatch('Jamdani, SAREE!')).toBe('jamdani saree');
    expect(containsKeyword('Best Jamdani Saree in Dhaka', 'jamdani saree')).toBe(true);
    expect(containsKeyword('Jamdani sarees', 'jamdani saree')).toBe(false);
    expect(containsKeyword('হাতে বোনা জামদানি শাড়ি', 'জামদানি শাড়ি')).toBe(true);
    expect(containsKeyword('anything', '  ')).toBe(false);
  });

  it('scores a complete product 100', () => {
    const s = scoreProductSeo(base);
    expect(s.score).toBe(100);
    expect(s.checks.every((c) => c.ok)).toBe(true);
  });

  it('marks each missing piece, weighted', () => {
    const s = scoreProductSeo({
      ...base,
      seoTitle: '',
      metaDescription: '',
      keywords: [],
      images: [{ alt: '' }, { alt: 'ok' }],
      faqCount: 0,
      description: 'short',
      sameTitle: 2,
    });
    const failed = s.checks.filter((c) => !c.ok).map((c) => c.key);
    expect(failed).toEqual([
      'focus_keyword',
      'title_length',
      'keyword_in_title',
      'meta_description',
      'keyword_in_meta',
      'description_length',
      'image_alt',
      'keyword_in_slug',
      'unique_title',
      'faq',
    ]);
    // Only "unique meta" passes (no meta to repeat): 5 of 110.
    expect(s.score).toBe(5);
    expect(s.checks.find((c) => c.key === 'image_alt')!.detail).toBe(
      '1 of 2 photos without alt text',
    );
  });

  it('uses the product name when there is no SEO title', () => {
    const s = scoreProductSeo({ ...base, seoTitle: undefined });
    expect(s.checks.find((c) => c.key === 'title_length')).toMatchObject({
      ok: false,
      detail: '13 characters',
    });
  });

  it('accepts a Banglish keyword in the address for a Bangla focus keyword', () => {
    const s = scoreProductSeo({
      ...base,
      keywords: ['জামদানি শাড়ি', 'jamdani saree'],
      slug: 'jamdani-saree-dhakai',
    });
    expect(s.checks.find((c) => c.key === 'keyword_in_slug')!.ok).toBe(true);
  });

  it('counts the focus keyword in the first lines when the meta lacks it', () => {
    const s = scoreProductSeo({
      ...base,
      metaDescription: 'x'.repeat(100),
      description: `Our jamdani saree ${base.description}`,
    });
    expect(s.checks.find((c) => c.key === 'keyword_in_meta')!.ok).toBe(true);
  });
});
