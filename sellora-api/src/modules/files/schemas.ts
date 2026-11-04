import { Schema, type Types } from 'mongoose';
import { tenantSchema, uniquePerTenant } from '../../infra/database/schema-helpers.js';

export const FILE_PURPOSES = ['product_image', 'chat_media', 'store_asset'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/** Purposes a browser may upload to. Chat media is saved by the server from the channels. */
export const UPLOAD_PURPOSES = [
  'product_image',
  'store_asset',
] as const satisfies readonly FilePurpose[];

export const FILE_STATUSES = ['pending', 'ready'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export interface FileRef {
  type: string;
  id: string;
}

/**
 * One uploaded file. The bytes live in object storage under `key`; this record says who
 * owns them, what they are and what uses them. A file is `pending` from the moment an
 * upload link is handed out until the upload is checked, then `ready`.
 */
export interface StoredFile {
  orgId: Types.ObjectId;
  key: string;
  purpose: FilePurpose;
  filename: string;
  contentType: string;
  size: number;
  status: FileStatus;
  visibility: 'public' | 'private';
  /** What refers to this file (for example a product). Unused files can be cleaned up. */
  usedBy: FileRef[];
  createdBy: { type: string; id: string };
  /** Pending files are removed after this time if the upload never completed. */
  expiresAt?: Date;
  readyAt?: Date;
}

export const storedFileSchema = tenantSchema<StoredFile>({
  key: { type: String, required: true },
  purpose: { type: String, enum: FILE_PURPOSES, required: true },
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  size: { type: Number, required: true, min: 1 },
  status: { type: String, enum: FILE_STATUSES, required: true },
  visibility: { type: String, enum: ['public', 'private'], required: true },
  usedBy: {
    type: [new Schema({ type: String, id: String }, { _id: false, strict: 'throw' })],
    default: [],
  },
  createdBy: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }),
  expiresAt: Date,
  readyAt: Date,
});
storedFileSchema.index({ key: 1 }, { unique: true });
storedFileSchema.index({ orgId: 1, purpose: 1, createdAt: -1 });
storedFileSchema.index({ orgId: 1, status: 1 });
// Cleanup sweeps run across businesses.
storedFileSchema.index({ status: 1, expiresAt: 1 });
storedFileSchema.index({ status: 1, purpose: 1, readyAt: 1 });

/** Bytes a business has stored or reserved for uploads in progress. */
export interface StorageUsage {
  orgId: Types.ObjectId;
  usedBytes: number;
}

export const storageUsageSchema = tenantSchema<StorageUsage>({
  usedBytes: { type: Number, required: true, default: 0 },
});
storageUsageSchema.path('orgId').index(false);
uniquePerTenant(storageUsageSchema);
