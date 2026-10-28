import { Schema, type Types } from 'mongoose';
import { platformSchema, tenantSchema } from '../../infra/database/schema-helpers.js';

/** A business's fraud check preferences. */
export interface FraudSettings {
  orgId: Types.ObjectId;
  /** Share courier-confirmed delivery outcomes with the Sellora network (and see the network's). */
  shareOutcomes: boolean;
  sharedSince?: Date;
}

export const fraudSettingsSchema = tenantSchema<FraudSettings>({
  shareOutcomes: { type: Boolean, default: false },
  sharedSince: Date,
});
fraudSettingsSchema.path('orgId').index(false);
fraudSettingsSchema.index({ orgId: 1 }, { unique: true });

/**
 * One parcel's end, shared with the network: whether the courier delivered it or brought it
 * back, for a phone number known only as a keyed hash. No names, addresses, products or
 * amounts. Rows expire after two years and are deleted when the business stops sharing.
 */
export interface DeliveryOutcome {
  /** The parcel's id, so a parcel counts once. */
  _id: Types.ObjectId;
  phoneHash: string;
  orgId: Types.ObjectId;
  outcome: 'delivered' | 'returned';
  at: Date;
}

export const OUTCOME_RETENTION_DAYS = 730;

export const deliveryOutcomeSchema = platformSchema<DeliveryOutcome>(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    phoneHash: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, required: true },
    outcome: { type: String, enum: ['delivered', 'returned'], required: true },
    at: { type: Date, required: true },
  },
  { collection: 'delivery_outcomes', timestamps: false },
);
deliveryOutcomeSchema.index({ phoneHash: 1, orgId: 1 });
deliveryOutcomeSchema.index({ orgId: 1 });
deliveryOutcomeSchema.index({ at: 1 }, { expireAfterSeconds: OUTCOME_RETENTION_DAYS * 86_400 });
