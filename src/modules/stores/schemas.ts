import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import { BUSINESS_CATEGORY_KEYS, type BusinessCategory } from '../orgs/business-categories.js';
import type { ThemeSettings } from './themes.js';

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
  createdBy: Schema.Types.ObjectId,
});
// Handles are subdomains, so they are unique across every business.
storeSchema.index({ handle: 1 }, { unique: true });
storeSchema.index({ orgId: 1, createdAt: 1 });
// The super-admin's review queue.
storeSchema.index({ status: 1, 'review.submittedAt': 1 });
