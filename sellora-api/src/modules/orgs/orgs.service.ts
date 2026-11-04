import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isSupportedCurrency } from '../../common/money/money.js';
import { isReservedSlug, slugify, withRandomSuffix } from '../../common/utils/slug.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OWNER_ROLE_KEY, systemRole } from '../iam/permissions.js';
import type { BusinessCategory } from './business-categories.js';
import type { Membership, Organization } from './schemas.js';
import { TenantAccessService } from './tenant-access.service.js';

export type OrganizationDoc = WithId<Organization>;

export const ORG_CREATED = 'org.created';
export const ORG_STATUS_CHANGED = 'org.status_changed';

export interface OrgCreatedEvent {
  orgId: string;
  ownerUserId: string;
  isDemo: boolean;
}

export interface CreateOrgInput {
  name: string;
  slug?: string;
  category: BusinessCategory;
  country: string;
  currency: string;
  timezone: string;
  locale: 'en' | 'bn';
  phone?: string;
}

export function toOrgDto(
  org: OrganizationDoc,
  access?: { roleKey: string; permissions: string[] },
) {
  return {
    id: org._id.toHexString(),
    name: org.name,
    slug: org.slug,
    legalName: org.legalName ?? null,
    category: org.category,
    country: org.country,
    currency: org.currency,
    timezone: org.timezone,
    locale: org.locale,
    contact: {
      phone: org.contact?.phone ?? null,
      email: org.contact?.email ?? null,
      address: org.contact?.address ?? null,
      website: org.contact?.website ?? null,
    },
    status: org.status,
    isDemo: org.isDemo,
    demoExpiresAt: org.demoExpiresAt?.toISOString() ?? null,
    settings: { orderNumberPrefix: org.settings?.orderNumberPrefix ?? 'SL' },
    createdAt: org.createdAt.toISOString(),
    ...(access
      ? {
          role: { key: access.roleKey, name: systemRole(access.roleKey)?.name ?? access.roleKey },
          permissions: access.permissions,
        }
      : {}),
  };
}

@Injectable()
export class OrgsService {
  constructor(
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
    @InjectModel('Membership') private readonly memberships: Model<Membership>,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
    private readonly access: TenantAccessService,
    private readonly events: EventEmitter2,
  ) {}

  async create(
    userId: string,
    input: CreateOrgInput,
    opts: { isDemo?: boolean; demoExpiresAt?: Date } = {},
  ): Promise<OrganizationDoc> {
    if (!isSupportedCurrency(input.currency))
      throw AppError.validation([{ path: 'currency', message: 'Currency is not supported yet' }]);
    const owned = await this.orgs
      .countDocuments({ ownerUserId: new Types.ObjectId(userId), status: { $ne: 'closed' } })
      .exec();
    if (owned >= 20)
      throw AppError.unprocessable('org_limit_reached', 'You can own at most 20 businesses.');

    let slug = input.slug ?? slugify(input.name);
    if (isReservedSlug(slug)) {
      if (input.slug)
        throw AppError.conflict('slug_unavailable', 'This address is reserved. Choose another.');
      slug = withRandomSuffix(slug);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const org = await this.tx.run(async () => {
          const orgId = new Types.ObjectId();
          const owner = new Types.ObjectId(userId);
          const [created] = await this.orgs.create([
            {
              _id: orgId,
              name: input.name,
              slug,
              category: input.category,
              country: input.country,
              currency: input.currency,
              timezone: input.timezone,
              locale: input.locale,
              contact: input.phone ? { phone: input.phone } : {},
              ownerUserId: owner,
              createdBy: owner,
              isDemo: opts.isDemo ?? false,
              ...(opts.demoExpiresAt ? { demoExpiresAt: opts.demoExpiresAt } : {}),
            },
          ]);
          await RequestContext.withTenant(orgId.toHexString(), () =>
            this.memberships.create([
              { orgId, userId: owner, roleKey: OWNER_ROLE_KEY, status: 'active' },
            ]),
          );
          await this.audit.record({
            action: 'org.created',
            orgId,
            target: { type: 'organization', id: orgId.toHexString(), label: input.name },
            metadata: { slug, category: input.category },
          });
          return created!.toObject() as unknown as OrganizationDoc;
        });
        const event: OrgCreatedEvent = {
          orgId: org._id.toHexString(),
          ownerUserId: userId,
          isDemo: org.isDemo,
        };
        await this.events.emitAsync(ORG_CREATED, event);
        return org;
      } catch (err) {
        if (isDuplicateKey(err)) {
          if (input.slug)
            throw AppError.conflict(
              'slug_unavailable',
              'This address is already taken. Choose another.',
            );
          slug = withRandomSuffix(slugify(input.name));
          continue;
        }
        throw err;
      }
    }
    throw AppError.conflict(
      'slug_unavailable',
      'Could not find a free address. Choose one yourself.',
    );
  }

  async listForUser(userId: string): Promise<{ org: OrganizationDoc; roleKey: string }[]> {
    const memberships = await this.memberships
      .find(
        { userId: new Types.ObjectId(userId), status: 'active' },
        { orgId: 1, roleKey: 1 },
        { [CROSS_TENANT]: true },
      )
      .lean()
      .exec();
    if (memberships.length === 0) return [];
    const orgs = await this.orgs
      .find({ _id: { $in: memberships.map((m) => m.orgId) }, status: { $ne: 'closed' } })
      .sort({ createdAt: 1 })
      .lean<OrganizationDoc[]>()
      .exec();
    const roleByOrg = new Map(memberships.map((m) => [m.orgId.toHexString(), m.roleKey]));
    return orgs.map((org) => ({ org, roleKey: roleByOrg.get(org._id.toHexString())! }));
  }

  async get(orgId: string): Promise<OrganizationDoc> {
    const org = Types.ObjectId.isValid(orgId)
      ? await this.orgs.findById(orgId).lean<OrganizationDoc>().exec()
      : null;
    if (!org) throw AppError.notFound('organization');
    return org;
  }

  async update(
    orgId: string,
    patch: Partial<Pick<CreateOrgInput, 'name' | 'category' | 'timezone' | 'locale'>> & {
      legalName?: string | null;
      contact?: {
        phone?: string | null;
        email?: string | null;
        address?: string | null;
        website?: string | null;
      };
      orderNumberPrefix?: string;
    },
  ): Promise<OrganizationDoc> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    for (const key of ['name', 'category', 'timezone', 'locale'] as const)
      if (patch[key] !== undefined) $set[key] = patch[key];
    if (patch.legalName !== undefined) {
      if (patch.legalName === null) $unset.legalName = '';
      else $set.legalName = patch.legalName;
    }
    if (patch.contact) {
      for (const [k, v] of Object.entries(patch.contact)) {
        if (v === undefined) continue;
        if (v === null) $unset[`contact.${k}`] = '';
        else $set[`contact.${k}`] = v;
      }
    }
    if (patch.orderNumberPrefix !== undefined)
      $set['settings.orderNumberPrefix'] = patch.orderNumberPrefix;
    const updated = await this.tx.run(async () => {
      const doc = await this.orgs
        .findByIdAndUpdate(
          orgId,
          {
            ...(Object.keys($set).length ? { $set } : {}),
            ...(Object.keys($unset).length ? { $unset } : {}),
          },
          { returnDocument: 'after', runValidators: true },
        )
        .lean<OrganizationDoc>()
        .exec();
      if (!doc) throw AppError.notFound('organization');
      await this.audit.record({
        action: 'org.updated',
        orgId,
        target: { type: 'organization', id: orgId, label: doc.name },
        metadata: { fields: [...Object.keys($set), ...Object.keys($unset)] },
      });
      return doc;
    });
    return updated;
  }

  /** Platform action: suspend, reactivate or close a business. */
  async setStatus(
    orgId: string,
    status: 'active' | 'suspended' | 'closed',
    reason: string,
    actorId: string,
  ): Promise<OrganizationDoc> {
    const doc = await this.tx.run(async () => {
      const updated = await this.orgs
        .findByIdAndUpdate(
          orgId,
          {
            $set: {
              status,
              statusReason: reason,
              statusChangedAt: new Date(),
              statusChangedBy: actorId,
            },
          },
          { returnDocument: 'after' },
        )
        .lean<OrganizationDoc>()
        .exec();
      if (!updated) throw AppError.notFound('organization');
      await this.audit.record({
        action: `org.status.${status}`,
        orgId,
        target: { type: 'organization', id: orgId, label: updated.name },
        metadata: { reason },
      });
      return updated;
    });
    await this.access.invalidate(orgId);
    this.events.emit(ORG_STATUS_CHANGED, { orgId, status, reason });
    return doc;
  }

  async setDemo(orgId: string, demoExpiresAt: Date | null): Promise<OrganizationDoc> {
    const doc = await this.orgs
      .findByIdAndUpdate(
        orgId,
        demoExpiresAt
          ? { $set: { isDemo: true, demoExpiresAt } }
          : { $set: { isDemo: false }, $unset: { demoExpiresAt: '' } },
        { returnDocument: 'after' },
      )
      .lean<OrganizationDoc>()
      .exec();
    if (!doc) throw AppError.notFound('organization');
    await this.audit.record({
      action: 'org.demo.updated',
      orgId,
      target: { type: 'organization', id: orgId },
      metadata: { demoExpiresAt },
    });
    await this.access.invalidate(orgId);
    return doc;
  }

  async search(q: {
    text?: string;
    status?: string;
    limit: number;
    skip: number;
  }): Promise<{ items: OrganizationDoc[]; total: number }> {
    const filter: Record<string, unknown> = {};
    if (q.text) {
      const escaped = q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { slug: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (q.status) filter.status = q.status;
    const [items, total] = await Promise.all([
      this.orgs
        .find(filter)
        .sort({ _id: -1 })
        .skip(q.skip)
        .limit(q.limit)
        .lean<OrganizationDoc[]>()
        .exec(),
      this.orgs.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }

  count(filter: Record<string, unknown> = {}): Promise<number> {
    return this.orgs.countDocuments(filter).exec();
  }

  /** Expired demo businesses, for the maintenance job that suspends them. */
  findExpiredDemos(now = new Date()): Promise<OrganizationDoc[]> {
    return this.orgs
      .find({ isDemo: true, status: 'active', demoExpiresAt: { $lte: now } })
      .limit(500)
      .lean<OrganizationDoc[]>()
      .exec();
  }
}
