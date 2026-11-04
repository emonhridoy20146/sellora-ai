import { Schema, type Types } from 'mongoose';
import { platformSchema } from '../../../infra/database/schema-helpers.js';

export const ONE_TIME_PURPOSES = [
  'email_verify',
  'password_reset',
  'platform_setup',
  'email_change',
] as const;
export type OneTimePurpose = (typeof ONE_TIME_PURPOSES)[number];

export interface OneTimeToken {
  purpose: OneTimePurpose;
  subjectId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  data: Record<string, unknown>;
}

/** Single-use tokens sent by email. Only the SHA-256 hash is stored. */
export const oneTimeTokenSchema = platformSchema<OneTimeToken>(
  {
    purpose: { type: String, enum: ONE_TIME_PURPOSES, required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'one_time_tokens' },
);
oneTimeTokenSchema.index({ subjectId: 1, purpose: 1 });
oneTimeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
