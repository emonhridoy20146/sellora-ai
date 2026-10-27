import { Types, type Schema } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { UnscopedQueryError } from '../../common/errors/app-error.js';

/** Query option that lets platform-level code read across tenants. Grep-audited. */
export const CROSS_TENANT = 'crossTenant';

export class CrossTenantAccessError extends Error {
  constructor(model: string, operation: string) {
    super(`Cross-tenant ${operation} on "${model}": orgId does not match the current tenant scope`);
    this.name = 'CrossTenantAccessError';
  }
}

const QUERY_OPS = [
  'countDocuments',
  'distinct',
  'find',
  'findOne',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
  'deleteMany',
  'deleteOne',
  'findOneAndDelete',
] as const;

function idString(value: unknown): string | undefined {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (typeof value === 'string' && Types.ObjectId.isValid(value)) return value.toLowerCase();
  return undefined;
}

/** Returns the single tenant id the filter is pinned to, or undefined if it is not pinned. */
export function pinnedOrgId(filter: Record<string, unknown> | undefined): string | undefined {
  if (!filter) return undefined;
  const raw = filter.orgId;
  if (raw && typeof raw === 'object' && !(raw instanceof Types.ObjectId)) {
    const keys = Object.keys(raw);
    if (keys.length === 1 && keys[0] === '$eq') return idString((raw as { $eq: unknown }).$eq);
    return undefined;
  }
  return idString(raw);
}

function assertMatchesContext(model: string, op: string, orgId: string): void {
  const tenant = RequestContext.tenant();
  if (tenant && tenant.orgId.toLowerCase() !== orgId) throw new CrossTenantAccessError(model, op);
}

function assertUpdateKeepsTenant(model: string, op: string, update: unknown, orgId: string): void {
  if (!update || typeof update !== 'object') return;
  const u = update as Record<string, unknown>;
  const candidates = [
    u.orgId,
    (u.$set as Record<string, unknown> | undefined)?.orgId,
    (u.$setOnInsert as Record<string, unknown> | undefined)?.orgId,
  ];
  for (const c of candidates) {
    if (c !== undefined && idString(c) !== orgId)
      throw new CrossTenantAccessError(model, `${op} (orgId change)`);
  }
  if ((u.$unset as Record<string, unknown> | undefined)?.orgId !== undefined) {
    throw new CrossTenantAccessError(model, `${op} ($unset orgId)`);
  }
}

/**
 * Defense in depth for multi-tenancy: every query on a tenant collection must be pinned
 * to exactly one orgId, and that orgId must match the tenant in the request context.
 * Repositories add the filter automatically; this plugin catches anything that bypasses
 * them, in every environment.
 */
export function tenantGuardPlugin(schema: Schema): void {
  for (const op of QUERY_OPS) {
    schema.pre(op, function tenantGuardQuery() {
      const options = this.getOptions() as Record<string, unknown>;
      if (options[CROSS_TENANT] === true) return;
      const model = this.model.modelName;
      const orgId = pinnedOrgId(this.getFilter());
      if (!orgId) throw new UnscopedQueryError(model, op);
      assertMatchesContext(model, op, orgId);
      if (
        op.startsWith('update') ||
        op === 'findOneAndUpdate' ||
        op === 'replaceOne' ||
        op === 'findOneAndReplace'
      ) {
        assertUpdateKeepsTenant(model, op, this.getUpdate(), orgId);
      }
    });
  }

  schema.pre('estimatedDocumentCount', function tenantGuardEstimated() {
    const options = this.getOptions() as Record<string, unknown>;
    if (options[CROSS_TENANT] !== true)
      throw new UnscopedQueryError(this.model.modelName, 'estimatedDocumentCount');
  });

  schema.pre('aggregate', function tenantGuardAggregate() {
    const options = this.options as Record<string, unknown>;
    if (options[CROSS_TENANT] === true) return;
    const model = this.model().modelName;
    const first = this.pipeline()[0] as Record<string, unknown> | undefined;
    const match = first?.$match as Record<string, unknown> | undefined;
    const orgId = pinnedOrgId(match);
    if (!orgId) throw new UnscopedQueryError(model, 'aggregate');
    assertMatchesContext(model, 'aggregate', orgId);
  });

  schema.pre('save', function tenantGuardSave() {
    const orgId = idString(this.get('orgId'));
    if (!orgId)
      throw new UnscopedQueryError(
        (this.constructor as { modelName?: string }).modelName ?? 'unknown',
        'save',
      );
    assertMatchesContext(
      (this.constructor as { modelName?: string }).modelName ?? 'unknown',
      'save',
      orgId,
    );
  });

  schema.pre('insertMany', function tenantGuardInsertMany(_next: unknown, docs: unknown) {
    const list = Array.isArray(docs) ? docs : [docs];
    for (const doc of list as Record<string, unknown>[]) {
      const orgId = idString(doc.orgId);
      if (!orgId) throw new UnscopedQueryError(this.modelName, 'insertMany');
      assertMatchesContext(this.modelName, 'insertMany', orgId);
    }
  });

  schema.pre('bulkWrite', function tenantGuardBulkWrite(_next: unknown, ops: unknown) {
    for (const op of (ops ?? []) as Record<string, Record<string, unknown>>[]) {
      const [kind, body] = Object.entries(op)[0] ?? [];
      if (!kind || !body) continue;
      const orgId =
        kind === 'insertOne'
          ? idString((body.document as Record<string, unknown>).orgId)
          : pinnedOrgId(body.filter as Record<string, unknown>);
      if (!orgId) throw new UnscopedQueryError(this.modelName, `bulkWrite.${kind}`);
      assertMatchesContext(this.modelName, `bulkWrite.${kind}`, orgId);
      if (body.update)
        assertUpdateKeepsTenant(this.modelName, `bulkWrite.${kind}`, body.update, orgId);
    }
  });
}
