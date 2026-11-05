import { Schema, type Types } from 'mongoose';
import { tenantSchema } from '../../infra/database/schema-helpers.js';
import { SOURCE_KINDS, type SourceKind } from './connectors/connector.js';

/** Minutes between syncs; 0 = only when asked. CSV uploads are always 0. */
export const SYNC_INTERVALS = [0, 15, 60, 360, 1440] as const;
export type SyncInterval = (typeof SYNC_INTERVALS)[number];

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
}

export const ZERO_COUNTS: RunCounts = {
  seen: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  archived: 0,
  restored: 0,
  failed: 0,
};

export interface LastRun {
  runId: Types.ObjectId;
  status: RunStatus;
  finishedAt: Date;
  counts: RunCounts;
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
        error: String,
      },
      { _id: false, strict: 'throw' },
    ),
    lastSuccessAt: Date,
    failures: { type: Number, default: 0 },
    lastSeen: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
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
