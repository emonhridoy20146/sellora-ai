import type { SeoCheckKey } from './api/types';

/**
 * The SEO checklist for a product page (ADR 0032): the same rules as the API's audit
 * (sellora-api `modules/seo/seo-score.ts`), so the live score while editing a product and
 * the score on the SEO page agree. Keep the two files in step.
 * Lengths are counted in characters as a person sees them (graphemes), so a Bangla letter
 * with its vowel sign counts once.
 */

/** Google shows about this many characters of a title and a description. */
export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const META_MIN = 70;
export const META_MAX = 160;
/** A product description shorter than this many words is "thin". */
export const DESCRIPTION_MIN_WORDS = 50;
export const FAQ_MIN = 2;

export interface SeoInput {
  name: string;
  slug: string;
  /** SEO title; empty means the product name is used. */
  seoTitle?: string | undefined;
  metaDescription?: string | undefined;
  description: string;
  /** Target keywords, the first one is the focus keyword. */
  keywords: string[];
  images: { alt?: string | undefined }[];
  faqCount: number;
  /** Other products (active, same business) using the same title or meta description. */
  sameTitle?: number;
  sameMeta?: number;
}

export type { SeoCheckKey };

export interface SeoCheck {
  key: SeoCheckKey;
  ok: boolean;
  /** How much the check counts towards the score. */
  weight: number;
  /** What was found, in words for the business ("52 characters"). */
  detail: string;
}

export interface SeoScore {
  /** 0–100. */
  score: number;
  checks: SeoCheck[];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as a person counts them. */
export function visibleLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text.trim())) n += 1;
  return n;
}

/** Words, split on spaces and punctuation (works for Bangla, English and Banglish). */
export function wordCount(text: string): number {
  return text.split(/[\s\p{P}।॥]+/u).filter(Boolean).length;
}

/** Text as compared for keywords: NFKC, lower case, single spaces, no punctuation. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/** True when every word of `keyword` appears in `text` in that order, next to each other. */
export function containsKeyword(text: string, keyword: string): boolean {
  const k = normalizeForMatch(keyword);
  if (!k) return false;
  return ` ${normalizeForMatch(text)} `.includes(` ${k} `);
}

function slugWords(text: string): string {
  return normalizeForMatch(text).replace(/ /g, '-');
}

/** The checklist and the score. */
export function scoreProductSeo(input: SeoInput): SeoScore {
  const focus = input.keywords.map((k) => k.trim()).find(Boolean) ?? '';
  const title = input.seoTitle?.trim() || input.name.trim();
  const meta = input.metaDescription?.trim() ?? '';
  const titleLen = visibleLength(title);
  const metaLen = visibleLength(meta);
  const words = wordCount(input.description);
  const missingAlt = input.images.filter((i) => !i.alt?.trim()).length;
  const firstWords = input.description.split(/\s+/).slice(0, 120).join(' ');

  const checks: SeoCheck[] = [
    {
      key: 'focus_keyword',
      ok: Boolean(focus),
      weight: 10,
      detail: focus ? `“${focus}”` : 'none chosen',
    },
    {
      key: 'title_length',
      ok: titleLen >= TITLE_MIN && titleLen <= TITLE_MAX,
      weight: 10,
      detail: `${titleLen} characters`,
    },
    {
      key: 'keyword_in_title',
      ok: Boolean(focus) && containsKeyword(title, focus),
      weight: 15,
      detail: focus ? (containsKeyword(title, focus) ? 'yes' : 'no') : 'no focus keyword',
    },
    {
      key: 'meta_description',
      ok: metaLen >= META_MIN && metaLen <= META_MAX,
      weight: 15,
      detail: meta ? `${metaLen} characters` : 'missing',
    },
    {
      key: 'keyword_in_meta',
      ok: Boolean(focus) && (containsKeyword(meta, focus) || containsKeyword(firstWords, focus)),
      weight: 10,
      detail: focus ? 'in the description or the first lines' : 'no focus keyword',
    },
    {
      key: 'description_length',
      ok: words >= DESCRIPTION_MIN_WORDS,
      weight: 10,
      detail: `${words} words`,
    },
    {
      key: 'image_alt',
      ok: input.images.length > 0 && missingAlt === 0,
      weight: 10,
      detail: input.images.length
        ? missingAlt
          ? `${missingAlt} of ${input.images.length} photos without alt text`
          : 'every photo has alt text'
        : 'no photos',
    },
    {
      // Any target keyword counts: a Bangla focus keyword is often in the address in Banglish.
      key: 'keyword_in_slug',
      ok: input.keywords.some((k) => {
        const words = slugWords(k);
        return Boolean(words) && input.slug.includes(words);
      }),
      weight: 5,
      detail: `/${input.slug}`,
    },
    {
      key: 'unique_title',
      ok: (input.sameTitle ?? 0) === 0,
      weight: 5,
      detail: input.sameTitle ? `${input.sameTitle} other products use it` : 'unique',
    },
    {
      key: 'unique_meta',
      ok: !meta || (input.sameMeta ?? 0) === 0,
      weight: 5,
      detail: input.sameMeta ? `${input.sameMeta} other products use it` : 'unique',
    },
    {
      key: 'faq',
      ok: input.faqCount >= FAQ_MIN,
      weight: 5,
      detail: `${input.faqCount} questions`,
    },
  ];
  const total = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0);
  return { score: Math.round((got / total) * 100), checks };
}
