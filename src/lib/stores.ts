import type {
  StoreChangeArea,
  DomainStatus,
  StoreDomain,
  FeatureIcon,
  SectionType,
  Store,
  StoreLanguage,
  StorePageKey,
  StoreSection,
  StoreStatus,
} from './api/types';

/** What each store status means to the business, and how it is shown. */
export const STORE_STATUS: Record<
  StoreStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; text: string }
> = {
  draft: {
    label: 'Draft',
    tone: 'neutral',
    text: 'Only you can see it. Send it for review when it is ready.',
  },
  pending: {
    label: 'In review',
    tone: 'warning',
    text: 'Sellora is checking the store. You get an email when it opens; this usually takes less than a day.',
  },
  live: { label: 'Open', tone: 'success', text: 'Shoppers can browse and order.' },
  rejected: {
    label: 'Changes needed',
    tone: 'danger',
    text: 'The review asked for changes. Fix them and send the store again.',
  },
  paused: {
    label: 'Paused',
    tone: 'neutral',
    text: 'Shoppers see a short note that the store is closed for now.',
  },
  suspended: {
    label: 'Suspended',
    tone: 'danger',
    text: 'Sellora closed this store. Contact support to reopen it.',
  },
};

export type StoreAction = 'submit' | 'withdraw' | 'pause' | 'resume' | 'delete';

/** The status changes a business can make from each status (the API enforces the same). */
export function storeActions(status: StoreStatus): StoreAction[] {
  switch (status) {
    case 'draft':
    case 'rejected':
      return ['submit', 'delete'];
    case 'pending':
      return ['withdraw', 'delete'];
    case 'live':
      return ['pause', 'delete'];
    case 'paused':
      return ['resume', 'delete'];
    case 'suspended':
      return [];
  }
}

/** The checklist shown before a store can be sent for review. */
export function readinessSteps(store: Store): { key: string; done: boolean; label: string }[] {
  const r = store.readiness;
  return [
    {
      key: 'products',
      done: (r?.activeProducts ?? 0) > 0,
      label:
        r && r.activeProducts > 0
          ? `${r.activeProducts} active product${r.activeProducts === 1 ? '' : 's'} to sell`
          : 'Add at least one active product',
    },
    {
      key: 'contact',
      done: Boolean(r?.hasContact),
      label: 'A phone or WhatsApp number for shoppers',
    },
  ];
}

/** Store addresses: 3 to 32 lowercase letters, digits and single hyphens. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

/** A handle suggestion from what the person typed (a store name or a rough address). */
export function toHandle(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
}

export function handleFormatOk(handle: string): boolean {
  return HANDLE_RE.test(handle) && !handle.includes('--');
}

// ---------------------------------------------------------------- sections

/** The parts of an open store whose changes Sellora looks at again (ADR 0028). */
export const CHANGE_AREA_LABEL: Record<StoreChangeArea, string> = {
  name: 'Name',
  design: 'Design',
  pages: 'Pages',
  seo: 'Search text',
  social: 'Social links',
  checkout: 'Checkout note',
  products: 'Products',
};

export const SECTION_LABEL: Record<SectionType, string> = {
  hero: 'Hero',
  categories: 'Categories',
  products: 'Product row',
  features: 'Reasons to buy',
  banner: 'Banner',
  text: 'Text',
};

export const SECTION_HINT: Record<SectionType, string> = {
  hero: 'A big welcome at the top with a button to the shop.',
  categories: 'Your product categories as tiles.',
  products: 'Newest, best-selling or one category’s products.',
  features: 'Up to four short promises, like cash on delivery.',
  banner: 'A wide picture with a message, for an offer or a new collection.',
  text: 'A heading and a few paragraphs about your business.',
};

export const FEATURE_ICONS: { value: FeatureIcon; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'truck', label: 'Delivery' },
  { value: 'return', label: 'Returns' },
  { value: 'support', label: 'Support' },
  { value: 'shield', label: 'Trust' },
  { value: 'gift', label: 'Gift' },
];

export const MAX_SECTIONS = 12;

/** A short random id for a new section, in the format the API expects. */
export function newSectionId(random: () => number = Math.random): string {
  let id = '';
  while (id.length < 8) id += Math.floor(random() * 36).toString(36);
  return id;
}

const STARTER_TEXT: Record<
  StoreLanguage,
  {
    shopNow: string;
    categories: string;
    products: string;
    feature: { title: string; text: string };
    banner: { heading: string; text: string; button: string };
    text: { heading: string; body: string };
  }
> = {
  en: {
    shopNow: 'Shop now',
    categories: 'Shop by category',
    products: 'Featured products',
    feature: { title: 'Cash on delivery', text: 'Pay when the parcel reaches you.' },
    banner: {
      heading: 'New collection',
      text: 'Fresh arrivals for the season.',
      button: 'See all',
    },
    text: { heading: 'About us', body: '' },
  },
  bn: {
    shopNow: 'এখনই কিনুন',
    categories: 'ক্যাটাগরি অনুযায়ী দেখুন',
    products: 'বাছাই করা পণ্য',
    feature: { title: 'ক্যাশ অন ডেলিভারি', text: 'পণ্য হাতে পেয়ে টাকা দিন।' },
    banner: { heading: 'নতুন কালেকশন', text: 'এই মৌসুমের নতুন পণ্য।', button: 'সব দেখুন' },
    text: { heading: 'আমাদের কথা', body: '' },
  },
};

/** A new section with sensible starting text in the store's language. */
export function newSection(
  type: SectionType,
  language: StoreLanguage,
  storeName: string,
  id = newSectionId(),
): StoreSection {
  const t = STARTER_TEXT[language];
  const base = { id, enabled: true };
  switch (type) {
    case 'hero':
      return {
        ...base,
        type,
        heading: storeName.slice(0, 80),
        subheading: '',
        buttonLabel: t.shopNow,
        image: null,
      };
    case 'categories':
      return { ...base, type, title: t.categories };
    case 'products':
      return {
        ...base,
        type,
        title: t.products,
        source: 'newest',
        categoryId: null,
        limit: 8,
      };
    case 'features':
      return { ...base, type, items: [{ icon: 'cash', ...t.feature }] };
    case 'banner':
      return {
        ...base,
        type,
        heading: t.banner.heading,
        text: t.banner.text,
        buttonLabel: t.banner.button,
        image: null,
      };
    case 'text':
      return { ...base, type, heading: t.text.heading, body: t.text.body };
  }
}

/** The line shown for a section in the list: its own heading or title when it has one. */
export function sectionSummary(s: StoreSection): string {
  switch (s.type) {
    case 'hero':
    case 'banner':
    case 'text':
      return s.heading || SECTION_LABEL[s.type];
    case 'categories':
    case 'products':
      return s.title || SECTION_LABEL[s.type];
    case 'features':
      return s.items.map((i) => i.title).join(' · ') || SECTION_LABEL[s.type];
  }
}

/** Moves one item up (-1) or down (+1); out-of-range moves leave the list as it is. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** What a section needs before the store can be saved; null when it is fine. */
export function sectionProblem(s: StoreSection): string | null {
  if (s.type === 'products' && s.source === 'category' && !s.categoryId)
    return 'Choose the category to show.';
  if (s.type === 'features' && s.items.some((i) => !i.title.trim()))
    return 'Give every reason a title.';
  return null;
}

// ---------------------------------------------------------------- colour

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of #rrggbb; null for anything else. */
export function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Buttons and links use the main colour on a light page; below 3:1 they are hard to read.
 * Returns a warning for the colour picker, or null when the colour reads well.
 */
export function primaryColourWarning(hex: string): string | null {
  const ratio = contrastRatio(hex, '#ffffff');
  if (ratio === null) return 'Use a colour like #7a1f2b.';
  if (ratio < 3) return 'This colour is light for buttons and links; shoppers may not read them.';
  return null;
}

// ---------------------------------------------------------------- pages

export const PAGE_INFO: Record<StorePageKey, { label: string; hint: string; max: number }> = {
  about: { label: 'About us', hint: 'Who you are and what you sell.', max: 5000 },
  shipping: {
    label: 'Delivery',
    hint: 'Where you deliver, how long it takes and how payment works.',
    max: 5000,
  },
  returns: { label: 'Returns and refunds', hint: 'What can come back, and how.', max: 5000 },
  privacy: { label: 'Privacy', hint: 'What you do with shoppers’ details.', max: 10000 },
  terms: { label: 'Terms', hint: 'Rules for buying from your store.', max: 10000 },
};

export const PAGE_KEYS = Object.keys(PAGE_INFO) as StorePageKey[];

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

// ---------------------------------------------------------------- custom domains

export const DOMAIN_STATUS: Record<
  DomainStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; text: string }
> = {
  pending: {
    label: 'Waiting for DNS',
    tone: 'neutral',
    text: 'Add the records below where you bought the domain. Sellora checks them by itself; new records can take a few hours to show.',
  },
  review: {
    label: 'In review',
    tone: 'warning',
    text: 'The records are right. Sellora is checking the domain; you get an email when it connects.',
  },
  active: {
    label: 'Connected',
    tone: 'success',
    text: 'Shoppers reach your store at this address.',
  },
  rejected: {
    label: 'Not approved',
    tone: 'danger',
    text: 'Sellora did not approve this domain. Read the reason below, then remove it.',
  },
};

/** What a domain needs next, in one line for the list. */
export function domainNextStep(d: StoreDomain): string {
  if (d.status === 'active')
    return d.dns && !d.dns.routing
      ? 'Its DNS changed: shoppers may stop reaching the store here. Check the records.'
      : d.primary
        ? 'Main address: shoppers on other addresses are sent here.'
        : 'Also opens the store.';
  if (d.status === 'pending') {
    if (!d.dns) return 'Not checked yet.';
    const left = [!d.dns.ownership && 'TXT', !d.dns.routing && (d.apex ? 'A' : 'CNAME')].filter(
      Boolean,
    );
    return left.length ? `Waiting for the ${left.join(' and ')} record.` : 'Checking…';
  }
  return DOMAIN_STATUS[d.status].text;
}
