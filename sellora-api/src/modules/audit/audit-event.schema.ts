import { Schema, type Types } from 'mongoose';
import { platformSchema } from '../../infra/database/schema-helpers.js';

export interface AuditActor {
  type: string;
  id: string;
  sessionId?: string;
  label?: string;
  impersonatedBy?: string;
}

export interface AuditEvent {
  scope: string;
  seq: number;
  orgId?: Types.ObjectId;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actor: AuditActor;
  target?: { type: string; id?: string; label?: string };
  ip?: string;
  userAgent?: string;
  requestId?: string;
  metadata: Record<string, unknown>;
  at: Date;
  prevHash: string;
  hash: string;
}

const actorSchema = new Schema<AuditActor>(
  {
    type: { type: String, required: true },
    id: { type: String, required: true },
    sessionId: String,
    label: String,
    impersonatedBy: String,
  },
  { _id: false, strict: 'throw' },
);

const targetSchema = new Schema(
  { type: { type: String, required: true }, id: String, label: String },
  { _id: false, strict: 'throw' },
);

/**
 * Append-only, hash-chained audit log. `scope` is "platform" or a tenant id; each event
 * stores the hash of the previous event in the same scope, so deleting or editing an
 * event breaks the chain and is detected by AuditService.verifyChain.
 */
export const auditEventSchema = platformSchema<AuditEvent>(
  {
    scope: { type: String, required: true },
    seq: { type: Number, required: true },
    orgId: { type: Schema.Types.ObjectId },
    action: { type: String, required: true },
    outcome: { type: String, enum: ['success', 'failure', 'denied'], default: 'success' },
    actor: { type: actorSchema, required: true },
    target: targetSchema,
    ip: String,
    userAgent: String,
    requestId: String,
    metadata: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, required: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: false, collection: 'audit_events' },
);
auditEventSchema.index({ scope: 1, seq: 1 }, { unique: true });
auditEventSchema.index({ orgId: 1, at: -1 });
auditEventSchema.index({ scope: 1, at: -1 });
auditEventSchema.index({ 'actor.id': 1, at: -1 });
auditEventSchema.index({ action: 1, at: -1 });

export interface AuditHead {
  _id: string;
  seq: number;
  hash: string;
}

export const auditHeadSchema = platformSchema<AuditHead>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: false, collection: 'audit_heads' },
);
