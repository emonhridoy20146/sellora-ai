import type {
  ApplyField,
  ContentKind,
  ContentTone,
  KeywordCompetition,
  KeywordIntent,
  KeywordMix,
  KeywordScript,
  Product,
  SearchTotals,
  SeoSuggestion,
  SeoCheckKey,
  StoreSeoCheckKey,
  TranslateTo,
  VolumeState,
  WriterLanguage,
} from './api/types';
import { formatNumber } from './format';
import { META_MAX, TITLE_MAX, visibleLength } from './seo-score';

/** The SEO studio and content studio (ADR 0032): words for the dashboard and small helpers. */

/** Each product check, as a short name and what to do about it. */
export const CHECK_LABEL: Record<SeoCheckKey, { name: string; fix: string }> = {
  focus_keyword: {
    name: 'Focus keyword',
    fix: 'Choose the one phrase shoppers type for this product.',
  },
  title_length: { name: 'Search title length', fix: 'Keep the search title 30 to 60 characters.' },
  keyword_in_title: {
    name: 'Keyword in title',
    fix: 'Put the focus keyword in the search title, near the start.',
  },
  meta_description: {
    name: 'Meta description',
    fix: 'Write 70 to 160 characters that make people click.',
  },
  keyword_in_meta: {
    name: 'Keyword in description',
    fix: 'Use the focus keyword in the meta description or the first lines.',
  },
  description_length: {
    name: 'Product description',
    fix: 'Write at least 50 words: fabric, size, care, delivery.',
  },
  image_alt: { name: 'Photo alt text', fix: 'Describe each photo in a few words.' },
  keyword_in_slug: {
    name: 'Keyword in address',
    fix: 'Use the keyword in the product address (in Banglish for Bangla keywords).',
  },
  unique_title: {
    name: 'Unique title',
    fix: 'Other products use the same search title. Make each one different.',
  },
  unique_meta: {
    name: 'Unique description',
    fix: 'Other products use the same meta description. Make each one different.',
  },
  faq: { name: 'Questions and answers', fix: 'Add at least 2 questions shoppers ask.' },
};

export const STORE_CHECK_LABEL: Record<StoreSeoCheckKey, string> = {
  store_title: 'Home page title (30 to 60 characters)',
  store_description: 'Home page description (70 to 160 characters)',
  indexable: 'Open to search engines',
  search_console: 'Google Search Console',
};

/** Why there are monthly searches, or why not, in words for the business. */
export const VOLUME_TEXT: Record<VolumeState, string> = {
  yes: 'Monthly searches in Bangladesh from Google Ads data.',
  not_set_up: 'Search volumes are not set up on this server yet, so ideas have no numbers.',
  not_priced: 'Search volumes have no credit price yet. Contact support.',
  no_credit: 'Not enough credit for a volume lookup. Top up and refresh the volumes.',
  failed: 'The volume provider did not answer. Nothing was charged for volumes; try again later.',
  off: 'Volumes were not looked up for this research.',
};

export const INTENT_LABEL: Record<KeywordIntent, string> = {
  buy: 'Buying',
  compare: 'Comparing',
  learn: 'Learning',
  local: 'Local',
  brand: 'Brand',
};

export const SCRIPT_LABEL: Record<KeywordScript, string> = {
  bangla: 'Bangla',
  english: 'English',
  banglish: 'Banglish',
};

export const MIX_OPTIONS: { value: KeywordMix; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'bangla', label: 'Bangla' },
  { value: 'english', label: 'English' },
  { value: 'banglish', label: 'Banglish' },
];

export const COMPETITION_LABEL: Record<KeywordCompetition, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const LANGUAGE_OPTIONS: { value: WriterLanguage; label: string }[] = [
  { value: 'bn', label: 'Bangla' },
  { value: 'en', label: 'English' },
];

export const CONTENT_KIND_LABEL: Record<ContentKind, { name: string; use: string }> = {
  facebook_ad: { name: 'Facebook ad', use: 'Headline and primary text for an ad' },
  caption: { name: 'Post caption', use: 'A Facebook or Instagram caption with hashtags' },
  product_description: { name: 'Product description', use: 'A description for the product page' },
  translate: { name: 'Translate', use: 'Bangla, English or Banglish' },
};

export const TONE_LABEL: Record<ContentTone, string> = {
  friendly: 'Friendly',
  premium: 'Premium',
  urgent: 'Urgent offer',
  informative: 'Informative',
};

export const TRANSLATE_LABEL: Record<TranslateTo, string> = {
  bn: 'Bangla',
  en: 'English',
  banglish: 'Banglish',
};

export const APPLY_LABEL: Record<ApplyField, string> = {
  title: 'Search title',
  meta: 'Meta description',
  keywords: 'Keywords',
  faq: 'Questions',
  description: 'Description',
  tags: 'Tags',
  alts: 'Photo alt text',
  slug: 'Address',
};

/** Fields a bulk suggestion fills unless the business picks others (the safe ones). */
export const APPLY_DEFAULT: ApplyField[] = ['title', 'meta', 'keywords', 'faq', 'alts'];

export type ScoreBand = 'good' | 'fair' | 'poor';

export function scoreBand(score: number): ScoreBand {
  return score >= 80 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

export const BAND_LABEL: Record<ScoreBand, string> = {
  good: 'Good',
  fair: 'Needs work',
  poor: 'Poor',
};

/**
 * A product address as the API makes it: lower case, letters and digits (Bangla too) joined
 * by hyphens, at most 80 characters (sellora-api `commerce/text.ts`).
 */
export function productSlug(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Comma separated keywords: trimmed, without repeats (any case), at most `max`. */
export function splitKeywords(input: string, max = 10): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of input.split(/[,\n،]+/)) {
    const t = k.trim().replace(/\s+/g, ' ');
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, max);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Text cut to `max` visible characters with an ellipsis, as Google cuts long titles. */
export function cut(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (visibleLength(t) <= max) return t;
  const parts = [...segmenter.segment(t)].slice(0, max - 1).map((s) => s.segment);
  return `${parts.join('').trimEnd()}…`;
}

/** What a Google result for the product would roughly look like. */
export function googlePreview(input: {
  storeName: string;
  storeUrl: string | null;
  slug: string;
  title: string;
  name: string;
  meta: string;
  description: string;
}): { title: string; url: string; text: string } {
  const title = input.title.trim() || input.name.trim();
  const text = input.meta.trim() || input.description.trim();
  const host = input.storeUrl ? input.storeUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
  return {
    title: cut(`${title} | ${input.storeName}`, TITLE_MAX + 5),
    url: host ? `${host} › products › ${input.slug}` : `products › ${input.slug}`,
    text: cut(text, META_MAX),
  };
}

/** Monthly searches, or a dash with the reason elsewhere. */
export function volumeText(v: number | null): string {
  return v === null ? 'No data' : formatNumber(v);
}

/** Change against the period before, as "+12%" (null when there was nothing before). */
export function changeText(current: number, previous: number): string | null {
  if (!previous) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

export function ctrText(ctr: number): string {
  return `${(ctr * 100).toFixed(ctr >= 0.1 ? 0 : 1)}%`;
}

export function positionText(p: number | null): string {
  return p === null ? '–' : p.toFixed(1);
}

/** The tiles above the Search Console chart. */
export function totalsTiles(cur: SearchTotals, prev: SearchTotals) {
  return [
    {
      key: 'clicks',
      label: 'Clicks',
      value: formatNumber(cur.clicks),
      change: changeText(cur.clicks, prev.clicks),
      better: cur.clicks >= prev.clicks,
    },
    {
      key: 'impressions',
      label: 'Times shown',
      value: formatNumber(cur.impressions),
      change: changeText(cur.impressions, prev.impressions),
      better: cur.impressions >= prev.impressions,
    },
    { key: 'ctr', label: 'Click rate', value: ctrText(cur.ctr), change: null, better: true },
    {
      key: 'position',
      label: 'Average position',
      value: positionText(cur.position),
      change: null,
      // A lower position is better.
      better: cur.position === null || prev.position === null || cur.position <= prev.position,
    },
  ];
}

/** Where to edit a product in the dashboard. */
export function productHref(orgId: string, productId: string): string {
  return `/app/${orgId}/products/${productId}`;
}

// ---------------------------------------------------------------- the product form's SEO fields

export const FAQ_MAX = 10;

/** The "Search engines" card while editing; saved as the product's `seo` and `slug`. */
export interface SeoDraft {
  focus: string;
  /** Other target keywords, comma separated. */
  more: string;
  title: string;
  meta: string;
  /** The address; empty on a new product means "from the name". */
  slug: string;
  faq: { question: string; answer: string }[];
}

export function seoDraftFrom(p?: Product): SeoDraft {
  const [focus = '', ...more] = p?.seo.keywords ?? [];
  return {
    focus,
    more: more.join(', '),
    title: p?.seo.title ?? '',
    meta: p?.seo.description ?? '',
    slug: p?.slug ?? '',
    faq: p?.seo.faq.map((f) => ({ ...f })) ?? [],
  };
}

/** Focus keyword first, then the others, without repeats. */
export function draftKeywords(d: Pick<SeoDraft, 'focus' | 'more'>): string[] {
  return splitKeywords([d.focus, d.more].join(','), 10);
}

/** Questions with both a question and an answer. */
export function completeFaq(faq: SeoDraft['faq']) {
  return faq
    .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
    .filter((f) => f.question && f.answer)
    .slice(0, FAQ_MAX);
}

/** The part of a product save the card owns. */
export function seoPayload(d: SeoDraft, product?: Pick<Product, 'slug'>) {
  const slug = productSlug(d.slug);
  return {
    seo: {
      title: d.title.trim(),
      description: d.meta.trim(),
      keywords: draftKeywords(d),
      faq: completeFaq(d.faq),
    },
    // Only an address the business changed is sent; otherwise the API keeps or makes one.
    ...(slug && slug !== product?.slug ? { slug } : {}),
  };
}

/** The draft with an AI suggestion's fields applied (the ones asked for). */
export function applySuggestion(
  d: SeoDraft,
  s: SeoSuggestion,
  fields: ('keywords' | 'title' | 'meta' | 'slug' | 'faq')[],
): SeoDraft {
  const want = new Set(fields);
  const [focus = s.focusKeyword, ...more] = s.keywords.length ? s.keywords : [s.focusKeyword];
  return {
    ...d,
    ...(want.has('keywords') ? { focus, more: more.join(', ') } : {}),
    ...(want.has('title') ? { title: s.seoTitle } : {}),
    ...(want.has('meta') ? { meta: s.metaDescription } : {}),
    ...(want.has('slug') && s.slug ? { slug: s.slug } : {}),
    ...(want.has('faq') ? { faq: s.faq.slice(0, FAQ_MAX).map((f) => ({ ...f })) } : {}),
  };
}

/**
 * The words on a page (sections, offer) for the AI writer to read: every text value, without
 * addresses, ids, colours or keys, at most `max` characters.
 */
export function pageText(value: unknown, max = 4000): string {
  const out: string[] = [];
  let size = 0;
  const walk = (v: unknown, key: string) => {
    if (size >= max) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (
        t.length < 2 ||
        /^(id|key|url|fileId|productId|variantId|kind|type|style|color|layout|icon)$/i.test(key) ||
        /^https?:\/\/|^#[0-9a-f]{3,8}$|^[0-9a-f]{24}$/i.test(t)
      )
        return;
      out.push(t);
      size += t.length + 1;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  walk(value, '');
  return out.join('\n').slice(0, max);
}
