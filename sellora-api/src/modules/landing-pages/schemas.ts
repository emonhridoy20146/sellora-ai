import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import type { ReviewFlag } from '../stores/schemas.js';
import type { LandingContent, LandingLanguage } from './blocks.js';

export const LANDING_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'live',
  'paused',
  'taken_down',
] as const;
/** Where a page stands, worked out from its fields (see `landingStatus`). */
export type LandingStatus = (typeof LANDING_STATUSES)[number];

/** A snapshot sent for review. The reviewer approves exactly this, not the later draft. */
export interface LandingSubmission {
  status: 'pending' | 'rejected';
  /** The draft revision the snapshot was taken from. */
  revision: number;
  content: LandingContent;
  submittedAt: Date;
  submittedBy: { id: string };
  flags: ReviewFlag[];
  decidedAt?: Date;
  decidedBy?: { id: string };
  /** Why the changes were not approved; shown to the business. */
  reason?: string;
}

export interface LandingPublished {
  version: number;
  revision: number;
  content: LandingContent;
  publishedAt: Date;
  autoApproved: boolean;
}

/**
 * A product sales page at `<store address>/<slug>` (ADR 0016). The business edits `draft`;
 * shoppers see `published`. `revision` counts draft saves.
 */
export interface LandingPage {
  orgId: Types.ObjectId;
  storeId: Types.ObjectId;
  name: string;
  slug: string;
  language: LandingLanguage;
  draft: LandingContent;
  revision: number;
  submission?: LandingSubmission;
  published?: LandingPublished;
  /** Paused by the business: shoppers see that the offer is not available. */
  paused: boolean;
  /** Taken down by Sellora. */
  takedown?: { reason: string; at: Date; by: { id: string } };
  createdBy: { id: string };
}

/** A published version, kept so it can be copied back into the draft. */
export interface LandingPageVersion {
  orgId: Types.ObjectId;
  pageId: Types.ObjectId;
  version: number;
  content: LandingContent;
  publishedAt: Date;
  approvedBy: { id: string };
  autoApproved: boolean;
}

/** Visitors and orders of one page on one day (in the business's time zone). */
export interface LandingPageStat {
  orgId: Types.ObjectId;
  pageId: Types.ObjectId;
  day: string;
  visitors: number;
  orders: number;
  revenueMinor: number;
}

const flagSchema = new Schema(
  { where: String, label: String, term: String, reason: String },
  { _id: false, strict: 'throw' },
);
const actorSchema = new Schema({ id: { type: String, required: true } }, { _id: false });

export const landingPageSchema = tenantSchema<LandingPage>(
  {
    storeId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true },
    language: { type: String, enum: ['en', 'bn'], required: true },
    draft: { type: Schema.Types.Mixed, required: true },
    revision: { type: Number, required: true, default: 1 },
    submission: new Schema(
      {
        status: { type: String, enum: ['pending', 'rejected'], required: true },
        revision: { type: Number, required: true },
        content: { type: Schema.Types.Mixed, required: true },
        submittedAt: { type: Date, required: true },
        submittedBy: { type: actorSchema, required: true },
        flags: { type: [flagSchema], default: [] },
        decidedAt: Date,
        decidedBy: actorSchema,
        reason: String,
      },
      { _id: false, strict: 'throw' },
    ),
    published: new Schema(
      {
        version: { type: Number, required: true },
        revision: { type: Number, required: true },
        content: { type: Schema.Types.Mixed, required: true },
        publishedAt: { type: Date, required: true },
        autoApproved: { type: Boolean, default: false },
      },
      { _id: false, strict: 'throw' },
    ),
    paused: { type: Boolean, default: false },
    takedown: new Schema(
      {
        reason: { type: String, required: true },
        at: { type: Date, required: true },
        by: { type: actorSchema, required: true },
      },
      { _id: false, strict: 'throw' },
    ),
    createdBy: { type: actorSchema, required: true },
  },
  { collection: 'landing_pages' },
);
// A slug is the page's path on its store, so it is unique per store.
landingPageSchema.index({ storeId: 1, slug: 1 }, { unique: true });
landingPageSchema.index({ orgId: 1, createdAt: -1 });
landingPageSchema.index(
  { 'submission.status': 1, 'submission.submittedAt': 1 },
  { partialFilterExpression: { 'submission.status': 'pending' } },
);

export const landingPageVersionSchema = tenantSchema<LandingPageVersion>(
  {
    pageId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    content: { type: Schema.Types.Mixed, required: true },
    publishedAt: { type: Date, required: true },
    approvedBy: { type: actorSchema, required: true },
    autoApproved: { type: Boolean, default: false },
  },
  { collection: 'landing_page_versions' },
);
landingPageVersionSchema.index({ pageId: 1, version: -1 }, { unique: true });

export const landingPageStatSchema = tenantSchema<LandingPageStat>(
  {
    pageId: { type: Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    visitors: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    revenueMinor: { type: Number, default: 0 },
  },
  { collection: 'landing_page_stats' },
);
landingPageStatSchema.index({ pageId: 1, day: 1 }, { unique: true });
landingPageStatSchema.index({ orgId: 1, day: 1 });

/** Where a page stands for the business and the reviewer. */
export function landingStatus(
  p: Pick<LandingPage, 'published' | 'submission' | 'paused' | 'takedown'>,
): LandingStatus {
  if (p.takedown) return 'taken_down';
  if (p.published) return p.paused ? 'paused' : 'live';
  if (p.submission?.status === 'pending') return 'in_review';
  if (p.submission?.status === 'rejected') return 'changes_requested';
  return 'draft';
}
