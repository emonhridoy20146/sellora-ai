import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { BusinessCategory } from '../orgs/business-categories.js';

/**
 * Store themes. A theme is a manifest: design tokens (colours, type, corners, header and
 * product card styles) and the home page sections a new store starts with. The storefront
 * app renders every theme with the same section components, so adding a theme is a new
 * manifest here plus its token styles there; the store engine does not change.
 */

export const FONT_CHOICES = ['sans', 'serif', 'rounded'] as const;
export const RADIUS_CHOICES = ['none', 'small', 'large'] as const;
export const HEADER_STYLES = ['left', 'centered', 'bold'] as const;
export const CARD_STYLES = ['plain', 'bordered', 'soft'] as const;
export const SECTION_TYPES = [
  'hero',
  'categories',
  'products',
  'features',
  'banner',
  'text',
] as const;
export const FEATURE_ICONS = ['truck', 'cash', 'return', 'support', 'shield', 'gift'] as const;
export const PRODUCT_SOURCES = ['newest', 'bestsellers', 'category'] as const;

export type FontChoice = (typeof FONT_CHOICES)[number];
export type SectionType = (typeof SECTION_TYPES)[number];

const hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1f6feb')
  .transform((v) => v.toLowerCase());
const line = (max: number) => z.string().trim().max(max);
/** An uploaded store image (logo, hero, banner): its file id; the URL is filled in by Sellora. */
const image = z.object({ fileId: z.string().regex(/^[a-f0-9]{24}$/), url: z.string() }).strict();

const sectionBase = { id: z.string().regex(/^[a-z0-9]{6,12}$/), enabled: z.boolean() };

export const sectionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...sectionBase,
      type: z.literal('hero'),
      heading: line(80),
      subheading: line(200),
      buttonLabel: line(30),
      image: image.nullable(),
    })
    .strict(),
  z.object({ ...sectionBase, type: z.literal('categories'), title: line(60) }).strict(),
  z
    .object({
      ...sectionBase,
      type: z.literal('products'),
      title: line(60),
      source: z.enum(PRODUCT_SOURCES),
      categoryId: z
        .string()
        .regex(/^[a-f0-9]{24}$/)
        .nullable(),
      limit: z.union([z.literal(4), z.literal(8), z.literal(12)]),
    })
    .strict(),
  z
    .object({
      ...sectionBase,
      type: z.literal('features'),
      items: z
        .array(z.object({ icon: z.enum(FEATURE_ICONS), title: line(40), text: line(120) }).strict())
        .min(1)
        .max(4),
    })
    .strict(),
  z
    .object({
      ...sectionBase,
      type: z.literal('banner'),
      heading: line(80),
      text: line(200),
      buttonLabel: line(30),
      image: image.nullable(),
    })
    .strict(),
  z
    .object({ ...sectionBase, type: z.literal('text'), heading: line(80), body: line(2000) })
    .strict(),
]);
export type StoreSection = z.infer<typeof sectionSchema>;

export const themeSettingsSchema = z
  .object({
    palette: z.object({ primary: hex, accent: hex }).strict(),
    font: z.enum(FONT_CHOICES),
    radius: z.enum(RADIUS_CHOICES),
    header: z.enum(HEADER_STYLES),
    card: z.enum(CARD_STYLES),
    logo: image.nullable(),
    announcement: line(140),
    sections: z
      .array(sectionSchema)
      .max(12)
      .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'Section ids must differ'),
  })
  .strict();
export type ThemeSettings = z.infer<typeof themeSettingsSchema>;

export interface ThemePalette {
  name: string;
  primary: string;
  accent: string;
}

export interface ThemeManifest {
  key: string;
  name: string;
  /** One line for the theme picker. */
  tagline: string;
  /** Business categories this theme is built for, best fit first. */
  categories: BusinessCategory[];
  palettes: ThemePalette[];
  defaults: Omit<ThemeSettings, 'logo' | 'announcement' | 'sections' | 'palette'>;
}

export const THEMES: readonly ThemeManifest[] = [
  {
    key: 'bazaar',
    name: 'Bazaar',
    tagline: 'A busy, friendly shop front for many kinds of products.',
    categories: ['other', 'grocery', 'electronics', 'home', 'services', 'digital', 'sports'],
    palettes: [
      { name: 'Market orange', primary: '#e8590c', accent: '#1c7ed6' },
      { name: 'Deep green', primary: '#2b8a3e', accent: '#f59f00' },
      { name: 'Royal blue', primary: '#1c3faa', accent: '#f03e3e' },
    ],
    defaults: { font: 'sans', radius: 'small', header: 'bold', card: 'bordered' },
  },
  {
    key: 'nakshi',
    name: 'Nakshi',
    tagline: 'Elegant and calm, for clothing, ethnic wear and jewellery.',
    categories: ['fashion', 'jewelry', 'handicrafts'],
    palettes: [
      { name: 'Maroon and gold', primary: '#7a1f2b', accent: '#b8860b' },
      { name: 'Ink and rose', primary: '#22223b', accent: '#c9184a' },
      { name: 'Forest and sand', primary: '#2d4a3e', accent: '#c08b5c' },
    ],
    defaults: { font: 'serif', radius: 'none', header: 'centered', card: 'plain' },
  },
  {
    key: 'volt',
    name: 'Volt',
    tagline: 'Sharp and technical, for phones, gadgets and accessories.',
    categories: ['electronics', 'automotive', 'sports', 'digital'],
    palettes: [
      { name: 'Electric blue', primary: '#1d4ed8', accent: '#f97316' },
      { name: 'Graphite and lime', primary: '#1f2937', accent: '#65a30d' },
      { name: 'Signal red', primary: '#c1121f', accent: '#1d3557' },
    ],
    defaults: { font: 'sans', radius: 'small', header: 'left', card: 'bordered' },
  },
  {
    key: 'glow',
    name: 'Glow',
    tagline: 'Soft and bright, for skincare, cosmetics and perfume.',
    categories: ['beauty', 'health', 'jewelry', 'kids'],
    palettes: [
      { name: 'Blush', primary: '#c2255c', accent: '#f08c00' },
      { name: 'Lavender', primary: '#6741d9', accent: '#e64980' },
      { name: 'Peach', primary: '#d9480f', accent: '#0c8599' },
    ],
    defaults: { font: 'rounded', radius: 'large', header: 'centered', card: 'soft' },
  },
  {
    key: 'fresh',
    name: 'Fresh',
    tagline: 'Clean and appetising, for groceries, organic food and home kitchens.',
    categories: ['grocery', 'food', 'health', 'pets'],
    palettes: [
      { name: 'Leaf', primary: '#2f9e44', accent: '#f08c00' },
      { name: 'Honey', primary: '#b45309', accent: '#15803d' },
      { name: 'Teal', primary: '#0b7285', accent: '#e67700' },
    ],
    defaults: { font: 'rounded', radius: 'large', header: 'left', card: 'soft' },
  },
  {
    key: 'nest',
    name: 'Nest',
    tagline: 'Warm and roomy, for home decor, furniture, books and kids.',
    categories: ['home', 'furniture', 'kids', 'books', 'handicrafts'],
    palettes: [
      { name: 'Walnut', primary: '#6b4226', accent: '#2b8a3e' },
      { name: 'Slate', primary: '#364fc7', accent: '#e8590c' },
      { name: 'Olive', primary: '#5c6b2e', accent: '#a61e4d' },
    ],
    defaults: { font: 'serif', radius: 'small', header: 'left', card: 'plain' },
  },
];

export const THEME_KEYS = THEMES.map((t) => t.key) as [string, ...string[]];

export function themeByKey(key: string): ThemeManifest | undefined {
  return THEMES.find((t) => t.key === key);
}

/** The three themes that fit a business category best (the category's own first). */
export function suggestedThemes(category: BusinessCategory): string[] {
  const ranked = THEMES.map((t, i) => {
    const pos = t.categories.indexOf(category);
    return { key: t.key, score: pos === -1 ? 100 + i : pos * 10 + i };
  }).sort((a, b) => a.score - b.score);
  return ranked.slice(0, 3).map((r) => r.key);
}

/** A short random id for a home page section. */
export function sectionId(): string {
  return randomBytes(4).toString('hex');
}

interface StarterText {
  heroHeading: string;
  heroSub: string;
  shopNow: string;
  categories: string;
  newArrivals: string;
  bestSellers: string;
  features: { icon: (typeof FEATURE_ICONS)[number]; title: string; text: string }[];
}

const STARTER: Record<'en' | 'bn', StarterText> = {
  en: {
    heroHeading: 'Welcome to {name}',
    heroSub: 'Order in a minute and pay cash on delivery anywhere in Bangladesh.',
    shopNow: 'Shop now',
    categories: 'Shop by category',
    newArrivals: 'New arrivals',
    bestSellers: 'Best sellers',
    features: [
      { icon: 'cash', title: 'Cash on delivery', text: 'Pay when the parcel reaches you.' },
      { icon: 'truck', title: 'Home delivery', text: 'Delivered to your door across the country.' },
      {
        icon: 'return',
        title: 'Easy returns',
        text: 'Tell us within 3 days if something is wrong.',
      },
      { icon: 'support', title: 'Talk to us', text: 'Call or message us any time.' },
    ],
  },
  bn: {
    heroHeading: '{name}-এ স্বাগতম',
    heroSub: 'এক মিনিটে অর্ডার করুন, পণ্য হাতে পেয়ে টাকা দিন। সারা বাংলাদেশে ডেলিভারি।',
    shopNow: 'এখনই কিনুন',
    categories: 'ক্যাটাগরি অনুযায়ী দেখুন',
    newArrivals: 'নতুন পণ্য',
    bestSellers: 'সবচেয়ে বেশি বিক্রি',
    features: [
      { icon: 'cash', title: 'ক্যাশ অন ডেলিভারি', text: 'পণ্য হাতে পেয়ে টাকা দিন।' },
      { icon: 'truck', title: 'হোম ডেলিভারি', text: 'সারা দেশে আপনার দরজায় পৌঁছে দিই।' },
      { icon: 'return', title: 'সহজ রিটার্ন', text: 'সমস্যা হলে ৩ দিনের মধ্যে জানান।' },
      { icon: 'support', title: 'যোগাযোগ', text: 'যেকোনো সময় কল বা মেসেজ করুন।' },
    ],
  },
};

/** Home page sections and settings a new store starts with, in the store's language. */
export function starterSettings(
  theme: ThemeManifest,
  storeName: string,
  language: 'en' | 'bn',
): ThemeSettings {
  const t = STARTER[language];
  const palette = theme.palettes[0]!;
  return {
    palette: { primary: palette.primary, accent: palette.accent },
    ...theme.defaults,
    logo: null,
    announcement: '',
    sections: [
      {
        id: sectionId(),
        enabled: true,
        type: 'hero',
        heading: t.heroHeading.replace('{name}', storeName).slice(0, 80),
        subheading: t.heroSub,
        buttonLabel: t.shopNow,
        image: null,
      },
      { id: sectionId(), enabled: true, type: 'categories', title: t.categories },
      {
        id: sectionId(),
        enabled: true,
        type: 'products',
        title: t.newArrivals,
        source: 'newest',
        categoryId: null,
        limit: 8,
      },
      { id: sectionId(), enabled: true, type: 'features', items: t.features },
      {
        id: sectionId(),
        enabled: true,
        type: 'products',
        title: t.bestSellers,
        source: 'bestsellers',
        categoryId: null,
        limit: 4,
      },
    ],
  };
}
