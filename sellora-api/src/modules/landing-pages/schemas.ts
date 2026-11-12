import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import type { ReviewFlag } from '../stores/schemas.js';
import type { LandingContent, LandingLanguage } from './blocks.js';

export const LANDING_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'scheduled',
  'live',
  'paused',
  'taken_down',
] as const;
/** Where a page stands, worked out from its fields (see `landingStatus`). */
export type LandingStatus = (typeof LANDING_STATUSES)[number];

/** What the business wants done with a version once it is approved (ADR 0031). */
export type SubmissionPurpose = 'publish' | 'ab_test';

/** An A/B test's settings, chosen when the business sends the test version for review. */
export interface AbTestSettings {
  /** Percent of visitors who see the new version (B). */
  splitB: number;
  /** Make the better version live by itself once the numbers are clear. */
  autoWinner: boolean;
  /** Visitors each version needs before a winner can be called. */
  minVisitors: number;
  /** Days after which a test without a clear winner ends and keeps A. */
  maxDays: number;
}

/** A snapshot sent for review. The reviewer approves exactly this, not the later draft. */
export interface LandingSubmission {
  status: 'pending' | 'rejected';
  /** Publish it (the default), or show it to some visitors as an A/B test (ADR 0031). */
  purpose?: SubmissionPurpose;
  /** Publish it at this time instead of when it is approved (ADR 0031). */
  publishAt?: Date;
  abTest?: AbTestSettings;
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

/** An approved version waiting for its publishing time (ADR 0031). */
export interface LandingScheduled {
  revision: number;
  content: LandingContent;
  publishAt: Date;
  approvedAt: Date;
  approvedBy: { id: string };
  autoApproved: boolean;
}

/** The A/B test running on a page: its id, split and the B version shoppers may see. */
export interface LandingRunningTest {
  id: Types.ObjectId;
  splitB: number;
  /** The draft revision version B was taken from. */
  revision: number;
  content: LandingContent;
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
  /** An approved version that goes live at a set time (ADR 0031). */
  scheduled?: LandingScheduled;
  /** When the offer ends: the page is paused at this time (ADR 0031). */
  pauseAt?: Date;
  /** The A/B test running on the page (ADR 0031). */
  abTest?: LandingRunningTest;
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
const abTestSettingsSchema = new Schema(
  {
    splitB: { type: Number, required: true, min: 10, max: 90 },
    autoWinner: { type: Boolean, required: true },
    minVisitors: { type: Number, required: true, min: 50, max: 100_000 },
    maxDays: { type: Number, required: true, min: 3, max: 60 },
  },
  { _id: false, strict: 'throw' },
);

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
        purpose: { type: String, enum: ['publish', 'ab_test'] },
        publishAt: Date,
        abTest: abTestSettingsSchema,
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
    scheduled: new Schema(
      {
        revision: { type: Number, required: true },
        content: { type: Schema.Types.Mixed, required: true },
        publishAt: { type: Date, required: true },
        approvedAt: { type: Date, required: true },
        approvedBy: { type: actorSchema, required: true },
        autoApproved: { type: Boolean, default: false },
      },
      { _id: false, strict: 'throw' },
    ),
    pauseAt: Date,
    abTest: new Schema(
      {
        id: { type: Schema.Types.ObjectId, required: true },
        splitB: { type: Number, required: true, min: 10, max: 90 },
        revision: { type: Number, required: true },
        content: { type: Schema.Types.Mixed, required: true },
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
// The worker's minute sweep (ADR 0031): versions due to go live and offers due to end.
landingPageSchema.index(
  { 'scheduled.publishAt': 1 },
  { partialFilterExpression: { scheduled: { $type: 'object' } } },
);
landingPageSchema.index(
  { pauseAt: 1 },
  { partialFilterExpression: { pauseAt: { $type: 'date' } } },
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
  p: Pick<LandingPage, 'published' | 'submission' | 'paused' | 'takedown'> &
    Partial<Pick<LandingPage, 'scheduled'>>,
): LandingStatus {
  if (p.takedown) return 'taken_down';
  if (p.published) return p.paused ? 'paused' : 'live';
  if (p.scheduled) return 'scheduled';
  if (p.submission?.status === 'pending') return 'in_review';
  if (p.submission?.status === 'rejected') return 'changes_requested';
  return 'draft';
}

export const AB_TEST_END_REASONS = [
  'chosen',
  'auto_winner',
  'no_clear_winner',
  'taken_down',
] as const;
export type AbTestEndReason = (typeof AB_TEST_END_REASONS)[number];

/** What one version of an A/B test got. */
export interface AbCounts {
  /** Different visitors who saw it (once per browser for the whole test). */
  visitors: number;
  /** Visitors who ordered at least once (the conversion the test compares). */
  buyers: number;
  orders: number;
  revenueMinor: number;
}

/**
 * An A/B test on a landing page (ADR 0031): visitors are split between the live version (A)
 * and a reviewed new version (B), and the version with more buyers per visitor wins.
 */
export interface LandingAbTest {
  orgId: Types.ObjectId;
  pageId: Types.ObjectId;
  status: 'running' | 'ended';
  settings: AbTestSettings;
  /** The published version shown as A. */
  a: { version: number };
  b: {
    revision: number;
    content: LandingContent;
    approvedBy: { id: string };
    autoApproved: boolean;
  };
  counts: { a: AbCounts; b: AbCounts };
  startedAt: Date;
  startedBy: { id: string };
  endedAt?: Date;
  endedBy?: { id: string };
  endReason?: AbTestEndReason;
  /** The version kept; null when the test ended without one being chosen. */
  winner?: 'a' | 'b' | null;
  /** The version number B got when it was made live. */
  publishedVersion?: number;
}

const countsSchema = new Schema(
  {
    visitors: { type: Number, default: 0 },
    buyers: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    revenueMinor: { type: Number, default: 0 },
  },
  { _id: false, strict: 'throw' },
);

export const landingAbTestSchema = tenantSchema<LandingAbTest>(
  {
    pageId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['running', 'ended'], required: true },
    settings: { type: abTestSettingsSchema, required: true },
    a: new Schema({ version: { type: Number, required: true } }, { _id: false, strict: 'throw' }),
    b: new Schema(
      {
        revision: { type: Number, required: true },
        content: { type: Schema.Types.Mixed, required: true },
        approvedBy: { type: actorSchema, required: true },
        autoApproved: { type: Boolean, default: false },
      },
      { _id: false, strict: 'throw' },
    ),
    counts: {
      type: new Schema({ a: countsSchema, b: countsSchema }, { _id: false, strict: 'throw' }),
      default: () => ({ a: {}, b: {} }),
    },
    startedAt: { type: Date, required: true },
    startedBy: { type: actorSchema, required: true },
    endedAt: Date,
    endedBy: actorSchema,
    endReason: { type: String, enum: AB_TEST_END_REASONS },
    winner: { type: String, enum: ['a', 'b', null] },
    publishedVersion: Number,
  },
  { collection: 'landing_ab_tests' },
);
landingAbTestSchema.index({ pageId: 1, startedAt: -1 });
landingAbTestSchema.index({ status: 1 }, { partialFilterExpression: { status: 'running' } });

// ---------------------------------------------------------------- the business's own templates (ADR 0031)

/** A page's sections and settings kept to start new pages from; no product is kept. */
export interface LandingTemplateContent {
  sections: LandingContent['sections'];
  settings: LandingContent['settings'];
  packages: LandingContent['offer']['packages'];
  noteField: boolean;
}

export interface LandingTemplate {
  orgId: Types.ObjectId;
  name: string;
  description: string;
  language: LandingLanguage;
  content: LandingTemplateContent;
  /** The page it was saved from (it may be gone since). */
  fromPageId: Types.ObjectId;
  createdBy: { id: string };
  createdAt: Date;
  updatedAt: Date;
}

export const landingTemplateSchema = tenantSchema<LandingTemplate>(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    language: { type: String, enum: ['en', 'bn'], required: true },
    content: { type: Schema.Types.Mixed, required: true },
    fromPageId: { type: Schema.Types.ObjectId, required: true },
    createdBy: { type: actorSchema, required: true },
  },
  { collection: 'landing_templates' },
);
landingTemplateSchema.index({ orgId: 1, createdAt: -1 });
