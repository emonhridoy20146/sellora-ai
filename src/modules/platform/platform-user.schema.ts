import { platformSchema } from '../../infra/database/schema-helpers.js';
import { PLATFORM_ROLES, type PlatformRole } from '../iam/platform-permissions.js';
import { mfaSchema, type MfaState } from '../users/user.schema.js';

export interface PlatformUser {
  email: string;
  name: string;
  role: PlatformRole;
  status: 'invited' | 'active' | 'disabled';
  passwordHash?: string;
  passwordChangedAt?: Date;
  mfa: MfaState;
  failedLoginCount: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  createdBy?: string;
  telegramChatId?: string;
}

/**
 * Super-admin realm accounts (platform owner and the system admins they create). Stored
 * apart from merchant users: a merchant account can never become a platform account.
 */
export const platformUserSchema = platformSchema<PlatformUser>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: PLATFORM_ROLES, required: true },
    status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited' },
    passwordHash: { type: String, select: false },
    passwordChangedAt: Date,
    mfa: { type: mfaSchema, default: () => ({}) },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    lastLoginIp: String,
    createdBy: String,
    telegramChatId: String,
  },
  { collection: 'platform_users' },
);
platformUserSchema.index({ email: 1 }, { unique: true });

export interface PlatformSettings {
  _id: string;
  signupEnabled: boolean;
  trial: { enabled: boolean; days: number };
  demo: { defaultHours: number };
  maintenance: { enabled: boolean; message: string };
  support: { email: string; whatsapp: string };
  updatedBy?: string;
}

export const platformSettingsSchema = platformSchema<PlatformSettings>(
  {
    _id: { type: String, required: true },
    signupEnabled: { type: Boolean, default: true },
    trial: {
      enabled: { type: Boolean, default: true },
      days: { type: Number, default: 14, min: 0, max: 90 },
    },
    demo: { defaultHours: { type: Number, default: 72, min: 1, max: 24 * 30 } },
    maintenance: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: '' },
    },
    support: {
      email: { type: String, default: 'support@sellora.ai' },
      whatsapp: { type: String, default: '' },
    },
    updatedBy: String,
  },
  { collection: 'platform_settings' },
);
