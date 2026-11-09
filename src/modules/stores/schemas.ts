import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import { BUSINESS_CATEGORY_KEYS, type BusinessCategory } from '../orgs/business-categories.js';
import type { ThemeSettings } from './themes.js';
import { TRAFFIC_SOURCES, type TrafficSource } from './traffic-source.js';

/**
 * draft: being set up · pending: waiting for a super-admin · live: open to shoppers ·
 * rejected: sent back with a reason (fix and submit again) · paused: closed by the business ·
 * suspended: closed by the platform.
 */
export const STORE_STATUSES = [
  'draft',
  'pending',
  'live',
  'rejected',
  'paused',
  'suspended',
] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const STORE_PAGE_KEYS = ['about', 'shipping', 'returns', 'privacy', 'terms'] as const;
export type StorePageKey = (typeof STORE_PAGE_KEYS)[number];

/** Something the automatic check found for the reviewer to look at. */
export interface ReviewFlag {
  /** Where it was found: "name", "product:<id>", "page:about". */
  where: string;
  label: string;
  term: string;
  reason: string;
}

export interface StoreReview {
  submittedAt?: Date;
  submittedBy?: { id: string; label?: string };
  decidedAt?: Date;
  decidedBy?: { id: string; label?: string };
  /** Why it was rejected or suspended; shown to the business. */
  reason?: string;
  flags: ReviewFlag[];
  autoApproved?: boolean;
}

export interface Store {
  orgId: Types.ObjectId;
  name: string;
  /** The store's subdomain label: <handle>.<STORE_DOMAIN>. Unique across the platform. */
  handle: string;
  category: BusinessCategory;
  /** Language of the shop's own words (buttons, checkout) for shoppers. */
  language: 'en' | 'bn';
  themeKey: string;
  theme: ThemeSettings;
  contact: { phone?: string; whatsapp?: string; email?: string; address?: string };
  social: { facebook?: string; instagram?: string; youtube?: string; tiktok?: string };
  seo: { title?: string; description?: string };
  /** Policy and information pages, plain text with blank lines between paragraphs. */
  pages: Partial<Record<StorePageKey, string>>;
  checkout: {
    /** Shown above the Place order button. */
    note?: string;
    /** Orders below this item total are refused (0: none). */
    minOrderMinor: number;
  };
  status: StoreStatus;
  /** The status before a suspension, to return to when it is lifted. */
  statusBeforeSuspension?: StoreStatus;
  review: StoreReview;
  /** First time the store opened to shoppers; the handle is fixed from then on. */
  liveSince?: Date;
  /** The active custom domain shoppers are sent to (ADR 0015); none: the Sellora address. */
  primaryDomain?: string;
  createdBy?: Types.ObjectId;
}

const by = new Schema({ id: String, label: String }, { _id: false, strict: 'throw' });

export const storeSchema = tenantSchema<Store>({
  name: { type: String, required: true, trim: true },
  handle: { type: String, required: true, lowercase: true },
  category: { type: String, enum: BUSINESS_CATEGORY_KEYS, required: true },
  language: { type: String, enum: ['en', 'bn'], default: 'en' },
  themeKey: { type: String, required: true },
  // Validated in full by themeSettingsSchema before every save.
  theme: { type: Schema.Types.Mixed, required: true },
  contact: {
    type: new Schema(
      { phone: String, whatsapp: String, email: String, address: String },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  social: {
    type: new Schema(
      { facebook: String, instagram: String, youtube: String, tiktok: String },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  seo: {
    type: new Schema({ title: String, description: String }, { _id: false, strict: 'throw' }),
    default: () => ({}),
  },
  pages: {
    type: new Schema(
      { about: String, shipping: String, returns: String, privacy: String, terms: String },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  checkout: {
    type: new Schema(
      { note: String, minOrderMinor: { type: Number, default: 0, min: 0 } },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({ minOrderMinor: 0 }),
  },
  status: { type: String, enum: STORE_STATUSES, default: 'draft' },
  statusBeforeSuspension: { type: String, enum: STORE_STATUSES },
  review: {
    type: new Schema(
      {
        submittedAt: Date,
        submittedBy: by,
        decidedAt: Date,
        decidedBy: by,
        reason: String,
        flags: {
          type: [
            new Schema(
              { where: String, label: String, term: String, reason: String },
              { _id: false, strict: 'throw' },
            ),
          ],
          default: [],
        },
        autoApproved: Boolean,
      },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({ flags: [] }),
  },
  liveSince: Date,
  primaryDomain: String,
  createdBy: Schema.Types.ObjectId,
});
// Handles are subdomains, so they are unique across every business.
storeSchema.index({ handle: 1 }, { unique: true });
storeSchema.index({ orgId: 1, createdAt: 1 });
// The super-admin's review queue.
storeSchema.index({ status: 1, 'review.submittedAt': 1 });

// ---------------------------------------------------------------- custom domains

/**
 * pending: waiting for the DNS records · review: DNS right, waiting for a super-admin ·
 * active: serving shoppers · rejected: refused or disconnected by the platform, with a reason.
 */
export const DOMAIN_STATUSES = ['pending', 'review', 'active', 'rejected'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
/** Statuses that hold the name: no other store anywhere can have it meanwhile. */
export const CLAIMING_STATUSES: readonly DomainStatus[] = ['review', 'active'];

export interface DomainDnsCheck {
  checkedAt: Date;
  ownership: boolean;
  routing: boolean;
  problems: string[];
  found: { txt: string[]; cname: string[]; addresses: string[] };
}

/** A business's own domain connected to one of its stores (ADR 0015). */
export interface StoreDomain {
  orgId: Types.ObjectId;
  storeId: Types.ObjectId;
  /** Lower-case ASCII; international names in punycode. */
  domain: string;
  /** A registrable domain (example.com) rather than a subdomain (www.example.com). */
  apex: boolean;
  /** Goes in the TXT record that proves the business controls the domain. */
  token: string;
  status: DomainStatus;
  /** True while the status claims the name (unique across the platform). */
  claimed: boolean;
  dns?: DomainDnsCheck;
  /** Automatic checks made so far, for the back-off. */
  checks: number;
  /** When the worker checks it next; unset when automatic checks have stopped. */
  nextCheckAt?: Date;
  /** First time its DNS was right (when it joined the review queue). */
  verifiedAt?: Date;
  activatedAt?: Date;
  review: { decidedAt?: Date; decidedBy?: { id: string; label?: string }; reason?: string };
  createdBy?: Types.ObjectId;
}

export const storeDomainSchema = tenantSchema<StoreDomain>(
  {
    storeId: { type: Schema.Types.ObjectId, required: true },
    domain: { type: String, required: true, lowercase: true },
    apex: { type: Boolean, required: true },
    token: { type: String, required: true },
    status: { type: String, enum: DOMAIN_STATUSES, default: 'pending' },
    claimed: { type: Boolean, default: false },
    dns: {
      type: new Schema(
        {
          checkedAt: Date,
          ownership: Boolean,
          routing: Boolean,
          problems: [String],
          found: {
            type: new Schema(
              { txt: [String], cname: [String], addresses: [String] },
              { _id: false, strict: 'throw' },
            ),
          },
        },
        { _id: false, strict: 'throw' },
      ),
    },
    checks: { type: Number, default: 0 },
    nextCheckAt: Date,
    verifiedAt: Date,
    activatedAt: Date,
    review: {
      type: new Schema(
        { decidedAt: Date, decidedBy: by, reason: String },
        { _id: false, strict: 'throw' },
      ),
      default: () => ({}),
    },
    createdBy: Schema.Types.ObjectId,
  },
  { collection: 'store_domains' },
);
// One store anywhere holds a name once its DNS has been proven; unproven entries may repeat.
storeDomainSchema.index(
  { domain: 1 },
  { unique: true, partialFilterExpression: { claimed: true }, name: 'domain_claimed_unique' },
);
storeDomainSchema.index({ domain: 1, status: 1 });
storeDomainSchema.index({ orgId: 1, storeId: 1, createdAt: 1 });
// The worker's due checks and the super-admin's queue.
storeDomainSchema.index({ nextCheckAt: 1 }, { sparse: true });
storeDomainSchema.index({ status: 1, verifiedAt: 1 });

// ---------------------------------------------------------------- visits and sales

/** Visitors counted per traffic source (see traffic-source.ts). */
export type SourceCounts = Partial<Record<TrafficSource, number>>;

/**
 * One store's shoppers on one day (in the business's time zone), ADR 0027. Each visitor
 * counts once a day at each step: visited, looked at a product, added to the cart, opened
 * the checkout. Orders and their value come from the orders themselves.
 */
export interface StoreStat {
  orgId: Types.ObjectId;
  storeId: Types.ObjectId;
  day: string;
  visitors: number;
  productViewers: number;
  cartVisitors: number;
  checkoutVisitors: number;
  orders: number;
  revenueMinor: number;
  sources: SourceCounts;
  orderSources: SourceCounts;
}

/** One product's lookers and buyers in one store on one day. */
export interface StoreProductStat {
  orgId: Types.ObjectId;
  storeId: Types.ObjectId;
  productId: Types.ObjectId;
  day: string;
  viewers: number;
  orders: number;
  units: number;
  revenueMinor: number;
}

const sourceCounts = new Schema(
  Object.fromEntries(TRAFFIC_SOURCES.map((s) => [s, { type: Number, default: 0 }])),
  { _id: false, strict: 'throw' },
);

export const storeStatSchema = tenantSchema<StoreStat>(
  {
    storeId: { type: Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    visitors: { type: Number, default: 0 },
    productViewers: { type: Number, default: 0 },
    cartVisitors: { type: Number, default: 0 },
    checkoutVisitors: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    revenueMinor: { type: Number, default: 0 },
    sources: { type: sourceCounts, default: () => ({}) },
    orderSources: { type: sourceCounts, default: () => ({}) },
  },
  { collection: 'store_stats' },
);
storeStatSchema.index({ storeId: 1, day: 1 }, { unique: true });
storeStatSchema.index({ orgId: 1, day: 1 });

export const storeProductStatSchema = tenantSchema<StoreProductStat>(
  {
    storeId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    viewers: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    units: { type: Number, default: 0 },
    revenueMinor: { type: Number, default: 0 },
  },
  { collection: 'store_product_stats' },
);
storeProductStatSchema.index({ storeId: 1, productId: 1, day: 1 }, { unique: true });
storeProductStatSchema.index({ storeId: 1, day: 1 });
