import { Schema, type Types } from 'mongoose';
import { platformSchema, type WithId } from '../../infra/database/schema-helpers.js';
import { BACKUP_TIERS, type BackupTier, type RestorePart, type RunStatus } from './backup-rules.js';

export const RUN_STATUSES = ['running', 'verifying', 'verified', 'failed', 'deleted'] as const;
export const RUN_REASONS = ['scheduled', 'manual', 'safety', 'merchant'] as const;
export type RunReason = (typeof RUN_REASONS)[number];

export interface Actor {
  type: 'platform' | 'user' | 'system';
  id?: string;
  label?: string;
}

/**
 * One backup (ADR 0020): of the whole platform or of one business. The file lives in object
 * storage; this record says where, how big, its checksum and whether it was verified. Stored
 * as a platform collection: tenant runs carry `orgId` but are only read by the backup service.
 */
export interface BackupRun {
  scope: 'platform' | 'tenant';
  orgId?: Types.ObjectId;
  reason: RunReason;
  status: RunStatus;
  tiers: BackupTier[];
  key?: string;
  kid?: string;
  size?: number;
  sha256?: string;
  counts?: Record<string, number>;
  docs?: number;
  startedAt: Date;
  finishedAt?: Date;
  verifiedAt?: Date;
  /** Set only while the run is going; unique, so one run per scope at a time. */
  lockKey?: string;
  leaseUntil?: Date;
  error?: string;
  testRestore?: { at: Date; ok: boolean; ms: number; error?: string };
  /** Set while a test restore waits for the worker. */
  testRestoreQueuedAt?: Date;
  offsite?: { at: Date; ok: boolean; error?: string };
  startedBy?: Actor;
  deletedAt?: Date;
  /** The record itself is removed after this (a year after its file went). */
  expiresAt?: Date;
}
export type BackupRunDoc = WithId<BackupRun>;

const actor = {
  type: { type: String, enum: ['platform', 'user', 'system'], required: true },
  id: String,
  label: String,
};

export const BackupRunSchema = platformSchema<BackupRun>(
  {
    scope: { type: String, enum: ['platform', 'tenant'], required: true },
    orgId: Schema.Types.ObjectId,
    reason: { type: String, enum: RUN_REASONS, required: true },
    status: { type: String, enum: RUN_STATUSES, required: true },
    tiers: { type: [String], enum: BACKUP_TIERS, default: [] },
    key: String,
    kid: String,
    size: Number,
    sha256: String,
    counts: { type: Schema.Types.Mixed },
    docs: Number,
    startedAt: { type: Date, required: true },
    finishedAt: Date,
    verifiedAt: Date,
    lockKey: String,
    leaseUntil: Date,
    error: String,
    testRestore: { at: Date, ok: Boolean, ms: Number, error: String },
    testRestoreQueuedAt: Date,
    offsite: { at: Date, ok: Boolean, error: String },
    startedBy: actor,
    deletedAt: Date,
    expiresAt: Date,
  },
  { collection: 'backup_runs', minimize: false },
);
BackupRunSchema.index({ scope: 1, status: 1, startedAt: -1 });
BackupRunSchema.index({ orgId: 1, startedAt: -1 });
BackupRunSchema.index(
  { lockKey: 1 },
  { unique: true, partialFilterExpression: { lockKey: { $type: 'string' } } },
);
BackupRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Nightly backup settings (one document). */
export interface BackupSettings {
  _id: string;
  enabled: boolean;
  hour: number;
  timezone: string;
  keep: { daily: number; weekly: number; monthly: number };
  updatedAt?: Date;
}

export const BackupSettingsSchema = new Schema<BackupSettings>(
  {
    _id: { type: String, required: true },
    enabled: { type: Boolean, required: true },
    hour: { type: Number, required: true },
    timezone: { type: String, required: true },
    keep: {
      daily: { type: Number, required: true },
      weekly: { type: Number, required: true },
      monthly: { type: Number, required: true },
    },
  },
  { collection: 'backup_settings', timestamps: true, strict: 'throw' },
);

/** A restore of one business's parts from a backup, with its safety backup. */
export interface BackupRestore {
  orgId: Types.ObjectId;
  runId: Types.ObjectId;
  safetyRunId?: Types.ObjectId;
  parts: RestorePart[];
  status: 'running' | 'done' | 'failed';
  reason: string;
  by: Actor;
  startedAt: Date;
  finishedAt?: Date;
  /** Documents written per collection. */
  restored?: Record<string, number>;
  removed?: Record<string, number>;
  error?: string;
  lockKey?: string;
}
export type BackupRestoreDoc = WithId<BackupRestore>;

export const BackupRestoreSchema = platformSchema<BackupRestore>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    runId: { type: Schema.Types.ObjectId, required: true },
    safetyRunId: Schema.Types.ObjectId,
    parts: { type: [String], required: true },
    status: { type: String, enum: ['running', 'done', 'failed'], required: true },
    reason: { type: String, required: true },
    by: actor,
    startedAt: { type: Date, required: true },
    finishedAt: Date,
    restored: { type: Schema.Types.Mixed },
    removed: { type: Schema.Types.Mixed },
    error: String,
    lockKey: String,
  },
  { collection: 'backup_restores', minimize: false },
);
BackupRestoreSchema.index({ orgId: 1, startedAt: -1 });
BackupRestoreSchema.index(
  { lockKey: 1 },
  { unique: true, partialFilterExpression: { lockKey: { $type: 'string' } } },
);
