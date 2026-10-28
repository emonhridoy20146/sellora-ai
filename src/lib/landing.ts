import type {
  LandingContent,
  LandingLanguage,
  LandingPackage,
  LandingSection,
  LandingSectionType,
  LandingStatus,
  Product,
} from './api/types';
import { formatDateTime, humanize } from './format';
import { newSectionId } from './stores';

/**
 * Landing page rules the editor needs before it talks to the API (ADR 0016). The API checks
 * all of them again; these only let the editor say what is wrong next to the field.
 */

export const MAX_LANDING_SECTIONS = 30;
export const MAX_PACKAGES = 6;

export const LANDING_STATUS: Record<
  LandingStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; text: string }
> = {
  draft: {
    label: 'Draft',
    tone: 'neutral',
    text: 'Only you can see it. Publish it when it is ready.',
  },
  in_review: {
    label: 'In review',
    tone: 'warning',
    text: 'Sellora is checking this version. You get an email when it goes live.',
  },
  changes_requested: {
    label: 'Changes needed',
    tone: 'danger',
    text: 'The review asked for changes. Fix them and publish again.',
  },
  live: { label: 'Live', tone: 'success', text: 'Shoppers can see the page and order.' },
  paused: {
    label: 'Paused',
    tone: 'neutral',
    text: 'Shoppers see that the offer is not available right now.',
  },
  taken_down: {
    label: 'Taken down',
    tone: 'danger',
    text: 'Sellora took this page down. Fix it and publish again for review.',
  },
};

// ---------------------------------------------------------------- addresses

/** Paths of the storefront itself; kept in step with the API's RESERVED_SLUGS. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'cart',
  'checkout',
  'order',
  'orders',
  'track',
  'products',
  'product',
  'pages',
  'page',
  'preview',
  'search',
  'category',
  'categories',
  'collections',
  'blog',
  'account',
  'login',
  'signup',
  'admin',
  'sitemap',
  'robots',
  'static',
  'assets',
  'images',
  'thank-you',
  'favicon',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

/** Why a page address cannot be used, in words, or null. */
export function slugProblem(slug: string): string | null {
  if (!SLUG_RE.test(slug) || slug.includes('--'))
    return 'Use 3 to 60 lower-case letters, numbers and single hyphens';
  if (RESERVED_SLUGS.has(slug)) return 'This address is used by the store itself; choose another';
  return null;
}

/** A page address from a name: Latin letters and digits joined by hyphens. */
export function toSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

// ---------------------------------------------------------------- sections

export const LANDING_SECTION_LABEL: Record<LandingSectionType, string> = {
  hero: 'Top offer',
  image: 'Picture',
  gallery: 'Pictures',
  video: 'Video',
  benefits: 'Benefits',
  problem_solution: 'Problem and solution',
  specs: 'Details table',
  steps: 'How to use',
  before_after: 'Before and after',
  reviews: 'Reviews',
  countdown: 'Countdown',
  stock_left: 'Stock left',
  price: 'Price box',
  faq: 'Questions',
  guarantee: 'Guarantees',
  delivery: 'Delivery',
  contact: 'Call and WhatsApp',
  text: 'Text',
  order_form: 'Order form',
};

export const LANDING_SECTION_HINT: Record<LandingSectionType, string> = {
  hero: 'The big headline, offer badge and order button.',
  image: 'One picture with a caption.',
  gallery: 'The product’s pictures, or your own.',
  video: 'A YouTube or Facebook video.',
  benefits: 'Short reasons to buy.',
  problem_solution: 'The buyer’s problem and how the product solves it.',
  specs: 'Size, weight, materials and other facts.',
  steps: 'Numbered steps.',
  before_after: 'Two pictures side by side.',
  reviews: 'What buyers said, with screenshots.',
  countdown: 'A timer until the offer ends.',
  stock_left: 'Shows the real stock when it runs low.',
  price: 'The price with the saving.',
  faq: 'Questions and answers.',
  guarantee: 'Cash on delivery, returns and other promises.',
  delivery: 'Your delivery areas and charges.',
  contact: 'Buttons to call or message you.',
  text: 'A heading and paragraphs.',
  order_form: 'Where shoppers order. A page has exactly one.',
};

/** The order the "Add section" menu lists them in. */
export const LANDING_SECTION_TYPES = Object.keys(LANDING_SECTION_LABEL) as LandingSectionType[];

export const HIDE_ON_LABEL = {
  none: 'Phones and computers',
  mobile: 'Computers only',
  desktop: 'Phones only',
} as const;

const NEW_TEXT: Record<
  LandingLanguage,
  {
    order: string;
    benefits: string;
    specs: string;
    steps: string;
    reviews: string;
    countdown: string;
    ended: string;
    stock: string;
    price: string;
    priceNote: string;
    faq: string;
    guarantee: string;
    delivery: string;
    deliveryText: string;
    contact: string;
    contactText: string;
    formHeading: string;
    formSub: string;
    confirm: string;
    problem: string;
    solution: string;
    beforeAfter: string;
    gallery: string;
  }
> = {
  en: {
    order: 'Order now',
    benefits: 'Why people choose it',
    specs: 'Details',
    steps: 'How to use',
    reviews: 'What buyers say',
    countdown: 'Offer ends in',
    ended: 'This offer has ended.',
    stock: 'Only {count} left in stock',
    price: 'Offer price',
    priceNote: 'Delivery charge is added at checkout.',
    faq: 'Questions',
    guarantee: 'Order without worry',
    delivery: 'Delivery',
    deliveryText: 'We deliver across Bangladesh. Pay cash when the parcel reaches you.',
    contact: 'Questions? Talk to us',
    contactText: 'Call or message us and we will help you choose.',
    formHeading: 'Order now',
    formSub: 'Write your name, phone number and address. We call to confirm before sending.',
    confirm: 'Confirm order',
    problem: 'Tired of this problem?',
    solution: 'Here is the solution',
    beforeAfter: 'Before and after',
    gallery: 'Pictures',
  },
  bn: {
    order: 'এখনই অর্ডার করুন',
    benefits: 'কেন সবাই এটি বেছে নেয়',
    specs: 'বিস্তারিত',
    steps: 'ব্যবহারের নিয়ম',
    reviews: 'ক্রেতারা যা বলছেন',
    countdown: 'অফার শেষ হতে বাকি',
    ended: 'এই অফারটি শেষ হয়েছে।',
    stock: 'স্টকে আর মাত্র {count}টি আছে',
    price: 'অফার মূল্য',
    priceNote: 'ডেলিভারি চার্জ অর্ডারের সময় যোগ হবে।',
    faq: 'প্রশ্ন ও উত্তর',
    guarantee: 'নিশ্চিন্তে অর্ডার করুন',
    delivery: 'ডেলিভারি',
    deliveryText: 'সারা বাংলাদেশে ডেলিভারি। পণ্য হাতে পেয়ে টাকা দিন।',
    contact: 'প্রশ্ন আছে? কথা বলুন',
    contactText: 'কল বা মেসেজ করুন, আমরা সাহায্য করব।',
    formHeading: 'এখনই অর্ডার করুন',
    formSub: 'আপনার নাম, ফোন নম্বর ও ঠিকানা লিখুন। পাঠানোর আগে আমরা কল করে নিশ্চিত করব।',
    confirm: 'অর্ডার নিশ্চিত করুন',
    problem: 'এই সমস্যায় ভুগছেন?',
    solution: 'এর সমাধান',
    beforeAfter: 'আগে ও পরে',
    gallery: 'ছবি',
  },
};

/** Three days from now at the next full hour, as a starting end time for a countdown. */
function inThreeDays(now = Date.now()): string {
  const d = new Date(now + 3 * 86_400_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/** A new section with starting text in the page's language. */
export function newLandingSection(
  type: LandingSectionType,
  language: LandingLanguage,
  id = newSectionId(),
  now = Date.now(),
): LandingSection {
  const t = NEW_TEXT[language];
  const base = { id, enabled: true, hideOn: 'none' as const };
  switch (type) {
    case 'hero':
      return {
        ...base,
        type,
        heading: '',
        subheading: '',
        badge: '',
        buttonLabel: t.order,
        image: null,
        showPrice: true,
      };
    case 'image':
      return { ...base, type, image: null, caption: '' };
    case 'gallery':
      return { ...base, type, title: t.gallery, source: 'product', images: [] };
    case 'video':
      return { ...base, type, title: '', url: '' };
    case 'benefits':
      return { ...base, type, title: t.benefits, items: [{ title: '', text: '' }] };
    case 'problem_solution':
      return {
        ...base,
        type,
        problemTitle: t.problem,
        problem: '',
        solutionTitle: t.solution,
        solution: '',
        image: null,
      };
    case 'specs':
      return { ...base, type, title: t.specs, rows: [{ label: '', value: '' }] };
    case 'steps':
      return { ...base, type, title: t.steps, steps: [{ text: '' }] };
    case 'before_after':
      return { ...base, type, title: t.beforeAfter, before: null, after: null, caption: '' };
    case 'reviews':
      return { ...base, type, title: t.reviews, items: [] };
    case 'countdown':
      return { ...base, type, heading: t.countdown, endsAt: inThreeDays(now), endedText: t.ended };
    case 'stock_left':
      return { ...base, type, text: t.stock, threshold: 10 };
    case 'price':
      return { ...base, type, heading: t.price, note: t.priceNote };
    case 'faq':
      return { ...base, type, title: t.faq, items: [{ question: '', answer: '' }] };
    case 'guarantee':
      return { ...base, type, title: t.guarantee, items: [] };
    case 'delivery':
      return { ...base, type, heading: t.delivery, text: t.deliveryText, showAreas: true };
    case 'contact':
      return {
        ...base,
        type,
        heading: t.contact,
        text: t.contactText,
        call: true,
        whatsapp: true,
      };
    case 'text':
      return { ...base, type, heading: '', body: '' };
    case 'order_form':
      return {
        ...base,
        type,
        heading: t.formHeading,
        subheading: t.formSub,
        buttonLabel: t.confirm,
      };
  }
}

/** The line shown for a section in the list: its own heading or title when it has one. */
export function landingSectionSummary(s: LandingSection): string {
  const label = LANDING_SECTION_LABEL[s.type];
  switch (s.type) {
    case 'hero':
    case 'countdown':
    case 'price':
    case 'delivery':
    case 'contact':
    case 'text':
    case 'order_form':
      return s.heading || label;
    case 'gallery':
    case 'video':
    case 'benefits':
    case 'specs':
    case 'steps':
    case 'before_after':
    case 'reviews':
    case 'faq':
    case 'guarantee':
      return s.title || label;
    case 'image':
      return s.caption || label;
    case 'problem_solution':
      return s.problemTitle || label;
    case 'stock_left':
      return s.text || label;
  }
}

/** A YouTube or Facebook video link (the only players a page embeds). */
export function isVideoLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const yt = /^[A-Za-z0-9_-]{11}$/;
  if (host === 'youtu.be') return yt.test(url.pathname.slice(1).split('/')[0] ?? '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const id =
      url.searchParams.get('v') ??
      (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '') ? (parts[1] ?? '') : '');
    return yt.test(id);
  }
  if (host === 'fb.watch') return true;
  if (host === 'facebook.com') {
    const path = url.pathname.replace(/\/+$/, '');
    return (
      /\/videos\/\d+/.test(path) ||
      /^\/reel\/\d+/.test(path) ||
      (path === '/watch' && /^\d+$/.test(url.searchParams.get('v') ?? ''))
    );
  }
  return false;
}

/**
 * What a shown section still needs before the page can be published; null when it is fine.
 * Hidden sections never block publishing.
 */
export function landingSectionProblem(s: LandingSection): string | null {
  if (!s.enabled) return null;
  switch (s.type) {
    case 'video':
      if (!s.url.trim()) return 'Add the video link.';
      return isVideoLink(s.url) ? null : 'Use a YouTube or Facebook video link.';
    case 'countdown':
      return s.endsAt ? null : 'Set when the offer ends.';
    case 'image':
      return s.image ? null : 'Add the picture.';
    case 'gallery':
      return s.source === 'custom' && s.images.length === 0 ? 'Add at least one picture.' : null;
    case 'before_after':
      return s.before && s.after ? null : 'Add both the before and the after picture.';
    case 'reviews':
      return s.items.some((r) => !r.text.trim() && !r.image)
        ? 'Every review needs words or a screenshot.'
        : null;
    default:
      return null;
  }
}

/** Everything that stops the draft from being published, as sentences. */
export function publishBlockers(content: LandingContent): string[] {
  const out: string[] = [];
  const forms = content.sections.filter((s) => s.type === 'order_form' && s.enabled).length;
  if (forms !== 1) out.push('Show one order form on the page.');
  if (!content.offer.productId) out.push('Choose the product this page sells.');
  if (content.offer.addOn && content.offer.addOn.productId === content.offer.productId)
    out.push('Choose a different product for the add-on.');
  for (const s of content.sections) {
    const p = landingSectionProblem(s);
    if (p) out.push(`${LANDING_SECTION_LABEL[s.type]}: ${p}`);
  }
  return out;
}

// ---------------------------------------------------------------- packages and prices

/** The lowest price among the product's options. */
export function lowestPrice(product: Pick<Product, 'variants'>): number {
  return Math.min(...product.variants.map((v) => v.priceMinor));
}

/** What a package costs and what it saves against the regular price of `unitMinor`. */
export function packagePrice(
  pkg: Pick<LandingPackage, 'quantity' | 'priceMinor'>,
  unitMinor: number,
): { totalMinor: number; regularMinor: number; savingMinor: number } {
  const regularMinor = unitMinor * pkg.quantity;
  const totalMinor = pkg.priceMinor ?? regularMinor;
  return { totalMinor, regularMinor, savingMinor: Math.max(0, regularMinor - totalMinor) };
}

/** A new package: one more than the last, at the regular price. */
export function newPackage(existing: LandingPackage[], language: LandingLanguage): LandingPackage {
  const quantity = Math.min(20, (existing.at(-1)?.quantity ?? 0) + 1);
  return {
    id: newSectionId(),
    label:
      language === 'bn' ? `${quantity}টি` : `${quantity} ${quantity === 1 ? 'piece' : 'pieces'}`,
    quantity,
    priceMinor: null,
    badge: '',
  };
}

/** Problems with the packages, by package id. */
export function packageProblems(
  packages: LandingPackage[],
  unitMinor: number | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of packages) {
    if (!p.label.trim()) out[p.id] = 'Name the package.';
    else if (p.priceMinor !== null && p.priceMinor < 1)
      out[p.id] = 'Set a price, or leave it empty.';
    else if (p.priceMinor !== null && unitMinor !== null && p.priceMinor > unitMinor * p.quantity)
      out[p.id] = 'This costs more than buying the pieces one by one.';
  }
  return out;
}

/** Conversion as people read it: "3.2%". */
export function conversionText(rate: number | null): string {
  if (rate === null) return '–';
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** Keys that hold settings or ids rather than words a shopper reads. */
const NOT_WORDS = new Set(['id', 'type', 'enabled', 'hideOn', 'fileId', 'source', 'icon']);

/**
 * Every word a section shows, as label/value lines: what a reviewer has to read for
 * misleading claims. Pictures show as their descriptions; video links are included.
 */
export function sectionWords(section: LandingSection): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const walk = (value: unknown, path: string, key: string) => {
    if (typeof value === 'string') {
      if (value.trim())
        out.push({ key: path, text: key === 'endsAt' ? formatDateTime(value) : value });
    } else if (typeof value === 'number' && key === 'rating') {
      out.push({ key: path, text: `${value} of 5` });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path} ${i + 1}`, key));
    } else if (value && typeof value === 'object' && 'fileId' in value) {
      // A picture: the preview shows it; the words are its description.
      const alt = (value as { alt?: string }).alt?.trim();
      out.push({ key: path, text: alt ? `Picture: ${alt}` : 'Picture (no description)' });
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (NOT_WORDS.has(k)) continue;
        walk(v, path ? `${path} · ${humanize(k)}` : humanize(k), k);
      }
    }
  };
  walk(section, '', '');
  return out;
}
