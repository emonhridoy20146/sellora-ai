import { Schema, Types, type SchemaOptions } from 'mongoose';
import { tenantGuardPlugin } from './tenant-guard.plugin.js';

const baseOptions: SchemaOptions = {
  timestamps: true,
  versionKey: false,
  strict: 'throw',
  id: false,
  toJSON: { virtuals: false },
  minimize: false,
};

/**
 * Schema for platform-level collections (users, plans, platform settings). The document
 * shape is declared by the interface `T` rather than inferred, which keeps the model
 * types readable and stable across Mongoose upgrades.
 */
export function platformSchema<T>(
  definition: Record<string, unknown>,
  options: SchemaOptions = {},
): Schema<T> {
  return new Schema(definition as never, { ...baseOptions, ...options } as never);
}

/**
 * Schema for tenant-owned collections. Adds an indexed, immutable `orgId` and the tenant
 * guard plugin. Compound indexes should start with orgId.
 */
export function tenantSchema<T extends { orgId: Types.ObjectId }>(
  definition: Record<string, unknown>,
  options: SchemaOptions = {},
): Schema<T> {
  const schema = platformSchema<T>(
    {
      orgId: { type: Schema.Types.ObjectId, required: true, immutable: true, index: true },
      ...definition,
    },
    options,
  );
  schema.plugin(tenantGuardPlugin);
  return schema;
}

/**
 * One document per business (settings, wallets, subscriptions): makes the `orgId` index
 * unique. Declaring a second `{ orgId: 1 }` index instead leaves two definitions with the
 * same key, and MongoDB keeps whichever it builds first, often the one that is not unique.
 */
export function uniquePerTenant<T>(schema: Schema<T>): Schema<T> {
  schema.path('orgId').index({ unique: true });
  return schema;
}

export type WithId<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export function oid(value: string | Types.ObjectId): Types.ObjectId {
  return typeof value === 'string' ? new Types.ObjectId(value) : value;
}

export function idOf(doc: { _id: Types.ObjectId }): string {
  return doc._id.toHexString();
}
