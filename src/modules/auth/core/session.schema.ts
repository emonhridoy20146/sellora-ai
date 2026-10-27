import { Schema, type Types } from 'mongoose';
import { platformSchema } from '../../../infra/database/schema-helpers.js';

export interface Session {
  realm: 'merchant' | 'platform';
  subjectId: Types.ObjectId;
  tokenHash: string;
  previousTokenHashes: string[];
  rotatedAt?: Date;
  generation: number;
  amr: string[];
  ip?: string;
  userAgent?: string;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revokeReason?: string;
  impersonatedBy?: string;
}

/**
 * Server-side session behind every refresh token. The refresh secret is stored only as a
 * SHA-256 hash; the last few hashes are kept to detect token reuse (theft).
 */
export const sessionSchema = platformSchema<Session>(
  {
    realm: { type: String, enum: ['merchant', 'platform'], required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true },
    previousTokenHashes: { type: [String], default: [] },
    rotatedAt: Date,
    generation: { type: Number, default: 0 },
    amr: { type: [String], default: [] },
    ip: String,
    userAgent: String,
    lastUsedAt: { type: Date, required: true },
    idleExpiresAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokeReason: String,
    impersonatedBy: String,
  },
  { collection: 'sessions' },
);
sessionSchema.index({ subjectId: 1, realm: 1, revokedAt: 1 });
// Keep revoked/expired sessions 30 days for investigations, then drop them.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
