import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import { SOURCE_KINDS, type SourceKind } from './connectors/connector.js';

/** Minutes between syncs; 0 = only when asked. CSV uploads are always 0. */
export const SYNC_INTERVALS = [0, 15, 60, 360, 1440] as const;
export type SyncInterval = (typeof SYNC_INTERVALS)[number];
/** Websites are crawled at most hourly (ADR 0024). */
export const WEBSITE_INTERVALS = [0, 60, 360, 1440] as const;

export const SOURCE_STATUSES = ['active', 'paused'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['first', 'schedule', 'manual', 'upload'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export interface RunCounts {
  /** Products read from the source. */
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  restored: number;
  /** Products that could not be imported (see the run's problems). */
  failed: number;
  /** Large changes waiting for the merchant (ADR 0024). */
  held: number;
}

export const ZERO_COUNTS: RunCounts = {
  seen: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  archived: 0,
  restored: 0,
  failed: 0,
  held: 0,
};

/** What a website crawl read (ADR 0024). */
export interface PageCounts {
  /** Pages fetched. */
  read: number;
  /** Pages kept for the AI: new, changed, and removed (gone, or not on the site any more). */
  added: number;
  changed: number;
  removed: number;
  /** Addresses found but left for the next crawl (the plan's page limit). */
  notRead: number;
}

export const ZERO_PAGES: PageCounts = { read: 0, added: 0, changed: 0, removed: 0, notRead: 0 };

/** A website source's ownership proof and what its crawl keeps (ADR 0024). */
export interface WebsiteSettings {
  /** Shown in the TXT record and the meta tag. */
  token: string;
  verifiedAt?: Date;
  verifiedBy?: 'dns' | 'meta';
  /** Why the last check failed (cleared when it passes). */
  verifyError?: string;
  checkedAt?: Date;
  importProducts: boolean;
  readPages: boolean;
}

export const HELD_KINDS = ['price', 'archive'] as const;
export type HeldKind = (typeof HELD_KINDS)[number];
export const HELD_DECISIONS = ['pending', 'apply', 'keep'] as const;
export type HeldDecision = (typeof HELD_DECISIONS)[number];

/** A large change the source made that waits for the merchant (ADR 0024). */
export interface HeldChange {
  /** The product's external id, or "archive" for a large archive. */
  ref: string;
  kind: HeldKind;
  /** The product's name, or "12 products". */
  label: string;
  productId?: Types.ObjectId;
  /** Price changes per variant. */
  prices: { variant: string; fromMinor: number; toMinor: number }[];
  /** Products a large archive would archive (names, at most 20). */
  names: string[];
  /** The source's version of the change; a new version replaces the entry. */
  hash: string;
  decision: HeldDecision;
  seenAt: Date;
  decidedAt?: Date;
  decidedBy?: Types.ObjectId;
}

/** A source keeps at most this many held changes. */
export const MAX_HELD = 100;

export interface LastRun {
  runId: Types.ObjectId;
  status: RunStatus;
  finishedAt: Date;
  counts: RunCounts;
  pages?: PageCounts;
  error?: string;
}

/** A place a business's products come from (ADR 0023). */
export interface CatalogSource {
  orgId: Types.ObjectId;
  kind: SourceKind;
  name: string;
  status: SourceStatus;
  /** Shop address or sheet link (normalized). None for CSV uploads. */
  url?: string;
  /** JSON of the credentials, encrypted (EncryptionService) for this business and source. */
  credentialsEnc?: string;
  /** The last four characters of the token or key, to recognise it. */
  credentialsHint?: string;
  /** What the source called itself when it was checked (shop or file name). */
  title?: string;
  intervalMinutes: SyncInterval;
  newProductStatus: 'active' | 'draft';
  syncStock: boolean;
  archiveMissing: boolean;
  nextSyncAt?: Date;
  /** Held by the run in progress; a crashed run's lease runs out. */
  lease?: { runId: Types.ObjectId; until: Date };
  lastRun?: LastRun;
  lastSuccessAt?: Date;
  /** Failed runs in a row; the next try waits longer after each. */
  failures: number;
  /** Products the source had at its last complete run (guards against an empty answer). */
  lastSeen: number;
  createdBy: Types.ObjectId;
  /** Hold price changes over half and large archives for the merchant (ADR 0024). */
  holdLargeChanges?: boolean;
  held?: HeldChange[];
  website?: WebsiteSettings;
}

const countsSchema = new Schema<RunCounts>(
  {
    seen: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    unchanged: { type: Number, default: 0 },
    archived: { type: Number, default: 0 },
    restored: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    held: { type: Number, default: 0 },
  },
  { _id: false, strict: 'throw' },
);

const pageCountsSchema = new Schema<PageCounts>(
  {
    read: { type: Number, default: 0 },
    added: { type: Number, default: 0 },
    changed: { type: Number, default: 0 },
    removed: { type: Number, default: 0 },
    notRead: { type: Number, default: 0 },
  },
  { _id: false, strict: 'throw' },
);

const heldChangeSchema = new Schema<HeldChange>(
  {
    ref: { type: String, required: true },
    kind: { type: String, enum: HELD_KINDS, required: true },
    label: { type: String, required: true },
    productId: Schema.Types.ObjectId,
    prices: {
      type: [
        new Schema(
          {
            variant: { type: String, default: '' },
            fromMinor: { type: Number, required: true },
            toMinor: { type: Number, required: true },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: [],
    },
    names: { type: [String], default: [] },
    hash: { type: String, required: true },
    decision: { type: String, enum: HELD_DECISIONS, default: 'pending' },
    seenAt: { type: Date, required: true },
    decidedAt: Date,
    decidedBy: Schema.Types.ObjectId,
  },
  { _id: false, strict: 'throw' },
);

export const catalogSourceSchema = tenantSchema<CatalogSource>(
  {
    kind: { type: String, enum: SOURCE_KINDS, required: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: SOURCE_STATUSES, default: 'active' },
    url: String,
    credentialsEnc: String,
    credentialsHint: String,
    title: String,
    intervalMinutes: { type: Number, enum: SYNC_INTERVALS, default: 60 },
    newProductStatus: { type: String, enum: ['active', 'draft'], default: 'active' },
    syncStock: { type: Boolean, default: true },
    archiveMissing: { type: Boolean, default: true },
    nextSyncAt: Date,
    lease: new Schema(
      {
        runId: { type: Schema.Types.ObjectId, required: true },
        until: { type: Date, required: true },
      },
      { _id: false, strict: 'throw' },
    ),
    lastRun: new Schema(
      {
        runId: { type: Schema.Types.ObjectId, required: true },
        status: { type: String, enum: RUN_STATUSES, required: true },
        finishedAt: { type: Date, required: true },
        counts: { type: countsSchema, required: true },
        pages: pageCountsSchema,
        error: String,
      },
      { _id: false, strict: 'throw' },
    ),
    lastSuccessAt: Date,
    failures: { type: Number, default: 0 },
    lastSeen: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    holdLargeChanges: { type: Boolean, default: false },
    held: { type: [heldChangeSchema], default: [] },
    website: new Schema<WebsiteSettings>(
      {
        token: { type: String, required: true },
        verifiedAt: Date,
        verifiedBy: { type: String, enum: ['dns', 'meta'] },
        verifyError: String,
        checkedAt: Date,
        importProducts: { type: Boolean, default: true },
        readPages: { type: Boolean, default: true },
      },
      { _id: false, strict: 'throw' },
    ),
  },
  { collection: 'catalog_sources' },
);
// The sweep: due sources across businesses.
catalogSourceSchema.index({ status: 1, nextSyncAt: 1 });

/** One sync of one source, kept 90 days. */
export interface CatalogSyncRun {
  orgId: Types.ObjectId;
  sourceId: Types.ObjectId;
  trigger: RunTrigger;
  status: RunStatus;
  counts: RunCounts;
  /** Websites: what the crawl read. */
  pages?: PageCounts;
  /** Up to 50 products or rows that could not be imported, and why. */
  problems: { ref: string; message: string }[];
  /** Problems beyond the first 50. */
  moreProblems: number;
  /** Why the run stopped, when it did. */
  error?: string;
  /** A CSV upload's text until the run has read it. */
  csv?: string;
  /** Who asked (manual runs and uploads). */
  by?: Types.ObjectId;
  startedAt?: Date;
  finishedAt?: Date;
  expiresAt: Date;
}

export const catalogSyncRunSchema = tenantSchema<CatalogSyncRun>(
  {
    sourceId: { type: Schema.Types.ObjectId, required: true },
    trigger: { type: String, enum: RUN_TRIGGERS, required: true },
    status: { type: String, enum: RUN_STATUSES, required: true },
    counts: { type: countsSchema, default: () => ({ ...ZERO_COUNTS }) },
    pages: pageCountsSchema,
    problems: {
      type: [new Schema({ ref: String, message: String }, { _id: false, strict: 'throw' })],
      default: [],
    },
    moreProblems: { type: Number, default: 0 },
    error: String,
    csv: String,
    by: Schema.Types.ObjectId,
    startedAt: Date,
    finishedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { collection: 'catalog_sync_runs' },
);
catalogSyncRunSchema.index({ orgId: 1, sourceId: 1, createdAt: -1 });
catalogSyncRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
