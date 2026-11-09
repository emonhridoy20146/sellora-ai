import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FieldError } from '../../common/errors/app-error.js';
import type { CheckedText } from '../stores/store-precheck.js';
import { FEATURE_ICONS } from '../stores/themes.js';

/**
 * What a landing page is made of (ADR 0016): typed sections, one product offer, search
 * and social settings. Everything here is plain data checked by schemas; no section can
 * hold HTML or scripts. Pure functions only, so the editor's rules are unit-tested.
 */

export const LANDING_SECTION_TYPES = [
  'hero',
  'image',
  'gallery',
  'video',
  'benefits',
  'problem_solution',
  'specs',
  'steps',
  'before_after',
  'reviews',
  'countdown',
  'stock_left',
  'price',
  'faq',
  'guarantee',
  'delivery',
  'contact',
  'text',
  'order_form',
] as const;
export type LandingSectionType = (typeof LANDING_SECTION_TYPES)[number];

export const HIDE_ON = ['none', 'mobile', 'desktop'] as const;
export const MAX_SECTIONS = 30;
export const MAX_PACKAGES = 6;
/** Without packages, a shopper may order this many at most. */
export const MAX_FREE_QUANTITY = 10;
export const LANDING_LANGUAGES = ['en', 'bn'] as const;
export type LandingLanguage = (typeof LANDING_LANGUAGES)[number];

/**
 * Paths of the storefront itself, and a few kept for later, that a page cannot take.
 * Kept in step with sellora-storefront/src/app.
 */
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

/** Why a slug cannot be used, or null. */
export function slugProblem(slug: string): 'format' | 'reserved' | null {
  if (!SLUG_RE.test(slug) || slug.includes('--')) return 'format';
  if (RESERVED_SLUGS.has(slug) || slug.startsWith('_')) return 'reserved';
  return null;
}

export const SLUG_MESSAGES = {
  format: 'Use 3 to 60 lower-case letters, numbers and single hyphens',
  reserved: 'This address is used by the store itself; choose another',
} as const;

const line = (max: number) => z.string().trim().max(max);
const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid id');
const sectionIdRe = /^[a-z0-9]{6,12}$/;

/** An uploaded picture of the business; Sellora fills in the URL when the page is saved. */
export const landingImageSchema = z
  .object({ fileId: objectId, url: z.string().max(2000), alt: line(160) })
  .strict();
export type LandingImage = z.infer<typeof landingImageSchema>;

// ---------------------------------------------------------------- video links

export interface VideoEmbed {
  provider: 'youtube' | 'facebook';
  /** YouTube: the 11-character video id. Facebook: the canonical video URL. */
  id: string;
}

/**
 * A YouTube or Facebook video link reduced to what an embed needs, or null for any other
 * link. Only these two players are ever embedded, so a page cannot frame arbitrary sites.
 */
export function parseVideoUrl(raw: string): VideoEmbed | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const ytId = /^[A-Za-z0-9_-]{11}$/;
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? '';
    return ytId.test(id) ? { provider: 'youtube', id } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const fromQuery = url.searchParams.get('v');
    const parts = url.pathname.split('/').filter(Boolean);
    const id =
      fromQuery ??
      (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '') ? (parts[1] ?? '') : '');
    return ytId.test(id) ? { provider: 'youtube', id } : null;
  }
  if (host === 'facebook.com' || host === 'fb.watch') {
    const path = url.pathname.replace(/\/+$/, '');
    const isVideo =
      host === 'fb.watch' ||
      /\/videos\/\d+/.test(path) ||
      /^\/reel\/\d+/.test(path) ||
      (path === '/watch' && /^\d+$/.test(url.searchParams.get('v') ?? ''));
    if (!isVideo) return null;
    const canonical =
      path === '/watch'
        ? `https://www.facebook.com/watch/?v=${url.searchParams.get('v')}`
        : `https://${host === 'fb.watch' ? 'fb.watch' : 'www.facebook.com'}${path}`;
    return { provider: 'facebook', id: canonical };
  }
  return null;
}

// ---------------------------------------------------------------- sections

const base = {
  id: z.string().regex(sectionIdRe, 'Not a valid section id'),
  enabled: z.boolean(),
  hideOn: z.enum(HIDE_ON),
};

const videoUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || parseVideoUrl(v) !== null, 'Use a YouTube or Facebook video link');

const isoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time')
  .transform((v) => new Date(v).toISOString());

export const landingSectionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('hero'),
      heading: line(120),
      subheading: line(300),
      badge: line(40),
      buttonLabel: line(30),
      /** Null shows the product's first picture. */
      image: landingImageSchema.nullable(),
      showPrice: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('image'),
      image: landingImageSchema.nullable(),
      caption: line(200),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('gallery'),
      title: line(80),
      /** `product` shows the product's own pictures; `custom` the ones below. */
      source: z.enum(['product', 'custom']),
      images: z.array(landingImageSchema).max(12),
    })
    .strict(),
  z.object({ ...base, type: z.literal('video'), title: line(80), url: videoUrl }).strict(),
  z
    .object({
      ...base,
      type: z.literal('benefits'),
      title: line(80),
      items: z.array(z.object({ title: line(60), text: line(240) }).strict()).max(8),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('problem_solution'),
      problemTitle: line(80),
      problem: line(800),
      solutionTitle: line(80),
      solution: line(800),
      image: landingImageSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('specs'),
      title: line(80),
      rows: z.array(z.object({ label: line(40), value: line(160) }).strict()).max(16),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('steps'),
      title: line(80),
      steps: z.array(z.object({ text: line(240) }).strict()).max(8),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('before_after'),
      title: line(80),
      before: landingImageSchema.nullable(),
      after: landingImageSchema.nullable(),
      caption: line(200),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('reviews'),
      title: line(80),
      items: z
        .array(
          z
            .object({
              name: line(40),
              text: line(500),
              rating: z.number().int().min(1).max(5),
              /** A screenshot of the customer's message, for example. */
              image: landingImageSchema.nullable(),
            })
            .strict(),
        )
        .max(12),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('countdown'),
      heading: line(80),
      endsAt: isoDate.nullable(),
      /** Shown instead of the timer once it reaches zero. */
      endedText: line(120),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('stock_left'),
      /** "{count}" becomes the real stock. */
      text: line(80),
      /** Shown only when stock is at or below this. */
      threshold: z.number().int().min(1).max(100),
    })
    .strict(),
  z.object({ ...base, type: z.literal('price'), heading: line(80), note: line(200) }).strict(),
  z
    .object({
      ...base,
      type: z.literal('faq'),
      title: line(80),
      items: z.array(z.object({ question: line(160), answer: line(800) }).strict()).max(15),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('guarantee'),
      title: line(80),
      items: z
        .array(z.object({ icon: z.enum(FEATURE_ICONS), title: line(40), text: line(160) }).strict())
        .max(4),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('delivery'),
      heading: line(80),
      text: line(500),
      /** List the business's delivery areas and charges. */
      showAreas: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('contact'),
      heading: line(80),
      text: line(200),
      call: z.boolean(),
      whatsapp: z.boolean(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('text'), heading: line(80), body: line(3000) }).strict(),
  z
    .object({
      ...base,
      type: z.literal('order_form'),
      heading: line(80),
      subheading: line(200),
      buttonLabel: line(30),
    })
    .strict(),
]);
export type LandingSection = z.infer<typeof landingSectionSchema>;

// ---------------------------------------------------------------- offer and page

export const landingPackageSchema = z
  .object({
    id: z.string().regex(sectionIdRe, 'Not a valid package id'),
    label: line(60).min(1, 'Name the package'),
    quantity: z.number().int().min(1).max(20),
    /** The package's whole price; null charges the product's own price times the quantity. */
    priceMinor: z.number().int().min(1).max(100_000_000).nullable(),
    badge: line(30),
  })
  .strict();
export type LandingPackage = z.infer<typeof landingPackageSchema>;

export const landingOfferSchema = z
  .object({
    productId: objectId.nullable(),
    packages: z
      .array(landingPackageSchema)
      .max(MAX_PACKAGES)
      .refine((p) => new Set(p.map((x) => x.id)).size === p.length, 'Package ids must differ'),
    addOn: z
      .object({
        productId: objectId,
        variantId: objectId,
        priceMinor: z.number().int().min(1).max(100_000_000),
        label: line(120).min(1, 'Say what the add-on is'),
      })
      .strict()
      .nullable(),
    /** Ask for a note ("anything we should know?"). */
    noteField: z.boolean(),
  })
  .strict();
export type LandingOffer = z.infer<typeof landingOfferSchema>;

export const landingContentSchema = z
  .object({
    sections: z
      .array(landingSectionSchema)
      .max(MAX_SECTIONS)
      .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'Section ids must differ')
      .refine(
        (s) => s.filter((x) => x.type === 'order_form').length <= 1,
        'A page has one order form',
      ),
    offer: landingOfferSchema,
    seo: z
      .object({
        title: line(70),
        description: line(200),
        image: landingImageSchema.nullable(),
        /** Let search engines list the page. */
        index: z.boolean(),
      })
      .strict(),
    settings: z
      .object({
        /** A button that stays at the bottom of phone screens and jumps to the order form. */
        stickyButton: z.boolean(),
        stickyLabel: line(30),
      })
      .strict(),
  })
  .strict();
export type LandingContent = z.infer<typeof landingContentSchema>;

/** A short random id for a section or package. */
export function blockId(): string {
  return randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------- pictures

/** Every uploaded picture the content uses, with where it sits (for error paths). */
export function contentImages(content: LandingContent): { fileId: string; path: string }[] {
  const out: { fileId: string; path: string }[] = [];
  const add = (img: LandingImage | null, path: string) => {
    if (img) out.push({ fileId: img.fileId, path: `${path}.fileId` });
  };
  content.sections.forEach((s, i) => {
    const at = `content.sections.${i}`;
    switch (s.type) {
      case 'hero':
      case 'image':
      case 'problem_solution':
        add(s.image, `${at}.image`);
        break;
      case 'gallery':
        s.images.forEach((img, j) => add(img, `${at}.images.${j}`));
        break;
      case 'before_after':
        add(s.before, `${at}.before`);
        add(s.after, `${at}.after`);
        break;
      case 'reviews':
        s.items.forEach((r, j) => add(r.image, `${at}.items.${j}.image`));
        break;
      case 'video':
      case 'benefits':
      case 'specs':
      case 'steps':
      case 'countdown':
      case 'stock_left':
      case 'price':
      case 'faq':
      case 'guarantee':
      case 'delivery':
      case 'contact':
      case 'text':
      case 'order_form':
        break;
    }
  });
  add(content.seo.image, 'content.seo.image');
  return out;
}

/** The same content with each picture's URL (and nothing else) replaced. */
export function withImageUrls(
  content: LandingContent,
  url: (fileId: string) => string,
): LandingContent {
  const fix = (img: LandingImage | null): LandingImage | null =>
    img ? { ...img, url: url(img.fileId) } : null;
  return {
    ...content,
    sections: content.sections.map((s): LandingSection => {
      switch (s.type) {
        case 'hero':
        case 'image':
        case 'problem_solution':
          return { ...s, image: fix(s.image) };
        case 'gallery':
          return { ...s, images: s.images.map((img) => fix(img)!) };
        case 'before_after':
          return { ...s, before: fix(s.before), after: fix(s.after) };
        case 'reviews':
          return { ...s, items: s.items.map((r) => ({ ...r, image: fix(r.image) })) };
        case 'video':
        case 'benefits':
        case 'specs':
        case 'steps':
        case 'countdown':
        case 'stock_left':
        case 'price':
        case 'faq':
        case 'guarantee':
        case 'delivery':
        case 'contact':
        case 'text':
        case 'order_form':
          return s;
      }
    }),
    seo: { ...content.seo, image: fix(content.seo.image) },
  };
}

// ---------------------------------------------------------------- checks

/** Every piece of text a shopper reads, for the automatic word check (ADR 0014). */
export function contentTexts(name: string, content: LandingContent): CheckedText[] {
  const texts: CheckedText[] = [
    { where: 'name', label: 'Page name', text: name },
    {
      where: 'seo',
      label: 'Search title and description',
      text: `${content.seo.title} ${content.seo.description}`,
    },
  ];
  content.sections.forEach((s, i) => {
    let parts: string[];
    switch (s.type) {
      case 'hero':
        parts = [s.heading, s.subheading, s.badge, s.buttonLabel];
        break;
      case 'image':
        parts = [s.caption, s.image?.alt ?? ''];
        break;
      case 'gallery':
      case 'video':
        parts = [s.title];
        break;
      case 'benefits':
        parts = [s.title, ...s.items.flatMap((x) => [x.title, x.text])];
        break;
      case 'problem_solution':
        parts = [s.problemTitle, s.problem, s.solutionTitle, s.solution];
        break;
      case 'specs':
        parts = [s.title, ...s.rows.flatMap((r) => [r.label, r.value])];
        break;
      case 'steps':
        parts = [s.title, ...s.steps.map((x) => x.text)];
        break;
      case 'before_after':
        parts = [s.title, s.caption];
        break;
      case 'reviews':
        parts = [s.title, ...s.items.flatMap((r) => [r.name, r.text])];
        break;
      case 'countdown':
        parts = [s.heading, s.endedText];
        break;
      case 'stock_left':
        parts = [s.text];
        break;
      case 'price':
        parts = [s.heading, s.note];
        break;
      case 'faq':
        parts = [s.title, ...s.items.flatMap((x) => [x.question, x.answer])];
        break;
      case 'guarantee':
        parts = [s.title, ...s.items.flatMap((x) => [x.title, x.text])];
        break;
      case 'delivery':
      case 'contact':
        parts = [s.heading, s.text];
        break;
      case 'text':
        parts = [s.heading, s.body];
        break;
      case 'order_form':
        parts = [s.heading, s.subheading, s.buttonLabel];
        break;
    }
    const text = parts.filter(Boolean).join(' ');
    if (text) texts.push({ where: `section:${s.id}`, label: `Section ${i + 1} (${s.type})`, text });
  });
  const offerText = [
    ...content.offer.packages.flatMap((p) => [p.label, p.badge]),
    content.offer.addOn?.label ?? '',
    content.settings.stickyLabel,
  ]
    .filter(Boolean)
    .join(' ');
  if (offerText) texts.push({ where: 'offer', label: 'Packages and add-on', text: offerText });
  return texts;
}

/** What the offer's products look like when the page is checked for publishing. */
export interface OfferProducts {
  product: { active: boolean; currencyOk: boolean; variantIds: string[] } | null;
  addOn: { active: boolean; currencyOk: boolean; variantIds: string[] } | null;
}

/** Why the content cannot be published yet (empty when it can). */
export function publishProblems(content: LandingContent, products: OfferProducts): FieldError[] {
  const errors: FieldError[] = [];
  const forms = content.sections.filter((s) => s.type === 'order_form' && s.enabled);
  if (forms.length !== 1)
    errors.push({ path: 'content.sections', message: 'Show one order form on the page' });
  const { offer } = content;
  if (!offer.productId)
    errors.push({ path: 'content.offer.productId', message: 'Choose the product this page sells' });
  else if (!products.product)
    errors.push({ path: 'content.offer.productId', message: 'This product no longer exists' });
  else if (!products.product.active)
    errors.push({ path: 'content.offer.productId', message: 'Make the product active first' });
  else if (!products.product.currencyOk)
    errors.push({
      path: 'content.offer.productId',
      message: "The product's currency is not the business's currency",
    });
  if (offer.addOn) {
    if (!products.addOn || !products.addOn.active)
      errors.push({
        path: 'content.offer.addOn.productId',
        message: 'The add-on product is missing or not active',
      });
    else if (!products.addOn.variantIds.includes(offer.addOn.variantId))
      errors.push({
        path: 'content.offer.addOn.variantId',
        message: 'This add-on option no longer exists',
      });
    else if (!products.addOn.currencyOk)
      errors.push({
        path: 'content.offer.addOn.productId',
        message: "The add-on's currency is not the business's currency",
      });
    if (offer.addOn.productId === offer.productId)
      errors.push({
        path: 'content.offer.addOn.productId',
        message: 'Choose a different product for the add-on',
      });
  }
  content.sections.forEach((s, i) => {
    if (!s.enabled) return;
    if (s.type === 'video' && !s.url)
      errors.push({ path: `content.sections.${i}.url`, message: 'Add the video link' });
    if (s.type === 'countdown' && !s.endsAt)
      errors.push({ path: `content.sections.${i}.endsAt`, message: 'Set when the offer ends' });
    if (s.type === 'image' && !s.image)
      errors.push({ path: `content.sections.${i}.image`, message: 'Add the picture' });
    if (s.type === 'gallery' && s.source === 'custom' && s.images.length === 0)
      errors.push({ path: `content.sections.${i}.images`, message: 'Add at least one picture' });
    if (s.type === 'before_after' && (!s.before || !s.after))
      errors.push({
        path: `content.sections.${i}`,
        message: 'Add both the before and the after picture',
      });
  });
  return errors;
}

// ---------------------------------------------------------------- prices

/**
 * What a package costs as an order line: the product's regular unit price with the saving
 * as a discount, so invoices show both. When the package costs more than the regular price
 * (the product got cheaper after the page was made) the unit price is raised instead, and
 * any rounding comes back as discount, so the total is always exactly the package price.
 */
export function packageCharge(
  regularUnitMinor: number,
  quantity: number,
  packagePriceMinor: number | null,
): { unitPriceMinor: number; discountMinor: number; totalMinor: number } {
  const regular = regularUnitMinor * quantity;
  if (packagePriceMinor === null)
    return { unitPriceMinor: regularUnitMinor, discountMinor: 0, totalMinor: regular };
  if (packagePriceMinor <= regular)
    return {
      unitPriceMinor: regularUnitMinor,
      discountMinor: regular - packagePriceMinor,
      totalMinor: packagePriceMinor,
    };
  const unit = Math.ceil(packagePriceMinor / quantity);
  return {
    unitPriceMinor: unit,
    discountMinor: unit * quantity - packagePriceMinor,
    totalMinor: packagePriceMinor,
  };
}

/** The calendar day (YYYY-MM-DD) of `at` in the business's time zone. */
export { dayKey } from '../../common/time/zoned.js';
