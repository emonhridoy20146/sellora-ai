import { Schema, type Types } from 'mongoose';
import { platformSchema } from '../../infra/database/schema-helpers.js';

export interface MfaState {
  totpSecretEnc?: string;
  totpPendingSecretEnc?: string;
  totpEnabledAt?: Date;
  totpLastStep?: number;
  recoveryCodes: { hash: string; usedAt?: Date }[];
}

export const mfaSchema = new Schema<MfaState>(
  {
    totpSecretEnc: { type: String, select: false },
    totpPendingSecretEnc: { type: String, select: false },
    totpEnabledAt: Date,
    totpLastStep: { type: Number, select: false },
    recoveryCodes: {
      type: [{ hash: { type: String, required: true }, usedAt: Date, _id: false }],
      default: [],
      select: false,
    },
  },
  { _id: false, strict: 'throw' },
);

export interface User {
  email: string;
  name: string;
  phone?: string;
  locale: 'en' | 'bn';
  timezone: string;
  avatarFileId?: Types.ObjectId;
  passwordHash?: string;
  passwordChangedAt?: Date;
  emailVerifiedAt?: Date;
  status: 'active' | 'locked' | 'disabled';
  statusReason?: string;
  lockedUntil?: Date;
  failedLoginCount: number;
  mfa: MfaState;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  isDemo: boolean;
}

/** Merchant-side people. A user can belong to many businesses through memberships. */
export const userSchema = platformSchema<User>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    phone: String,
    locale: { type: String, enum: ['en', 'bn'], default: 'en' },
    timezone: { type: String, default: 'Asia/Dhaka' },
    avatarFileId: Schema.Types.ObjectId,
    passwordHash: { type: String, select: false },
    passwordChangedAt: Date,
    emailVerifiedAt: Date,
    status: { type: String, enum: ['active', 'locked', 'disabled'], default: 'active' },
    statusReason: String,
    lockedUntil: Date,
    failedLoginCount: { type: Number, default: 0 },
    mfa: { type: mfaSchema, default: () => ({}) },
    lastLoginAt: Date,
    lastLoginIp: String,
    isDemo: { type: Boolean, default: false },
  },
  { collection: 'users' },
);
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ createdAt: -1 });
