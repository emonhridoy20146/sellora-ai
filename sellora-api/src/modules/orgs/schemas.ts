import { Schema, type Types } from 'mongoose';
import { platformSchema, tenantSchema } from '../../infra/database/schema-helpers.js';
import { BUSINESS_CATEGORY_KEYS, type BusinessCategory } from './business-categories.js';

export interface Organization {
  name: string;
  slug: string;
  legalName?: string;
  category: BusinessCategory;
  country: string;
  currency: string;
  timezone: string;
  locale: 'en' | 'bn';
  contact?: { phone?: string; email?: string; address?: string; website?: string };
  logoFileId?: Types.ObjectId;
  status: 'active' | 'suspended' | 'closed';
  statusReason?: string;
  statusChangedAt?: Date;
  statusChangedBy?: string;
  ownerUserId: Types.ObjectId;
  isDemo: boolean;
  demoExpiresAt?: Date;
  createdBy: Types.ObjectId;
  settings?: { orderNumberPrefix: string; weekStartsOn: number };
}

/** A business (tenant). Every tenant-owned document carries its _id as orgId. */
export const organizationSchema = platformSchema<Organization>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true },
    legalName: String,
    category: { type: String, enum: BUSINESS_CATEGORY_KEYS, default: 'other' },
    country: { type: String, default: 'BD' },
    currency: { type: String, default: 'BDT' },
    timezone: { type: String, default: 'Asia/Dhaka' },
    locale: { type: String, enum: ['en', 'bn'], default: 'en' },
    contact: {
      type: new Schema(
        { phone: String, email: String, address: String, website: String },
        { _id: false, strict: 'throw' },
      ),
      default: () => ({}),
    },
    logoFileId: Schema.Types.ObjectId,
    status: { type: String, enum: ['active', 'suspended', 'closed'], default: 'active' },
    statusReason: String,
    statusChangedAt: Date,
    statusChangedBy: String,
    ownerUserId: { type: Schema.Types.ObjectId, required: true },
    isDemo: { type: Boolean, default: false },
    demoExpiresAt: Date,
    createdBy: { type: Schema.Types.ObjectId, required: true },
    settings: {
      type: new Schema(
        {
          orderNumberPrefix: { type: String, default: 'SL' },
          weekStartsOn: { type: Number, default: 6 },
        },
        { _id: false, strict: 'throw' },
      ),
      default: () => ({}),
    },
  },
  { collection: 'organizations' },
);
organizationSchema.index({ slug: 1 }, { unique: true });
organizationSchema.index({ ownerUserId: 1 });
organizationSchema.index({ status: 1, createdAt: -1 });

export interface Membership {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  roleKey: string;
  status: 'active' | 'suspended';
  invitedBy?: Types.ObjectId;
  joinedAt: Date;
}

export const membershipSchema = tenantSchema<Membership>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    roleKey: { type: String, required: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    invitedBy: Schema.Types.ObjectId,
    joinedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'memberships' },
);
membershipSchema.index({ orgId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1 });
membershipSchema.index({ orgId: 1, roleKey: 1 });

export interface CustomRole {
  orgId: Types.ObjectId;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  createdBy?: Types.ObjectId;
}

export const customRoleSchema = tenantSchema<CustomRole>(
  {
    key: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    permissions: { type: [String], default: [] },
    createdBy: Schema.Types.ObjectId,
  },
  { collection: 'roles' },
);
customRoleSchema.index({ orgId: 1, key: 1 }, { unique: true });

export interface Invitation {
  orgId: Types.ObjectId;
  email: string;
  roleKey: string;
  tokenHash: string;
  expiresAt: Date;
  invitedBy: Types.ObjectId;
  acceptedAt?: Date;
  acceptedBy?: Types.ObjectId;
  revokedAt?: Date;
}

export const invitationSchema = tenantSchema<Invitation>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    roleKey: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    invitedBy: { type: Schema.Types.ObjectId, required: true },
    acceptedAt: Date,
    acceptedBy: Schema.Types.ObjectId,
    revokedAt: Date,
  },
  { collection: 'invitations' },
);
invitationSchema.index({ tokenHash: 1 }, { unique: true });
invitationSchema.index({ orgId: 1, email: 1 });
