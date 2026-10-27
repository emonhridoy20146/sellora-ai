import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import { Types, type Model } from 'mongoose';
import { REDIS } from '../../infra/redis/redis.module.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { systemRole } from '../iam/permissions.js';
import type { CustomRole, Membership, Organization } from './schemas.js';

export interface ResolvedAccess {
  orgId: string;
  membershipId: string;
  roleKey: string;
  permissions: string[];
  orgStatus: string;
  isDemo: boolean;
  demoExpiresAt: string | null;
}

const CACHE_TTL_SECONDS = 60;

/**
 * Answers "what may this user do in this business?" for every tenant request. Results are
 * cached in Redis under a per-tenant version number; bumping the version (on any role,
 * membership or status change) invalidates every cached entry of that tenant at once.
 */
@Injectable()
export class TenantAccessService {
  constructor(
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
    @InjectModel('Membership') private readonly memberships: Model<Membership>,
    @InjectModel('CustomRole') private readonly roles: Model<CustomRole>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private async version(orgId: string): Promise<string> {
    return (await this.redis.get(`access-ver:${orgId}`)) ?? '0';
  }

  async invalidate(orgId: string): Promise<void> {
    await this.redis.incr(`access-ver:${orgId}`);
  }

  async resolve(orgId: string, userId: string): Promise<ResolvedAccess | null> {
    if (!Types.ObjectId.isValid(orgId)) return null;
    const ver = await this.version(orgId);
    const key = `access:${orgId}:${userId}:${ver}`;
    const cached = await this.redis.get(key);
    if (cached) return cached === 'none' ? null : (JSON.parse(cached) as ResolvedAccess);

    const access = await this.load(orgId, userId);
    await this.redis.set(key, access ? JSON.stringify(access) : 'none', 'EX', CACHE_TTL_SECONDS);
    return access;
  }

  private async load(orgId: string, userId: string): Promise<ResolvedAccess | null> {
    const org = await this.orgs
      .findById(orgId, { status: 1, isDemo: 1, demoExpiresAt: 1 })
      .lean()
      .exec();
    if (!org || org.status === 'closed') return null;
    const membership = await this.memberships
      .findOne(
        { orgId: new Types.ObjectId(orgId), userId: new Types.ObjectId(userId), status: 'active' },
        null,
        { [CROSS_TENANT]: true },
      )
      .lean()
      .exec();
    if (!membership) return null;
    const permissions = await this.permissionsFor(orgId, membership.roleKey);
    return {
      orgId,
      membershipId: membership._id.toHexString(),
      roleKey: membership.roleKey,
      permissions,
      orgStatus: org.status,
      isDemo: org.isDemo,
      demoExpiresAt: org.demoExpiresAt?.toISOString() ?? null,
    };
  }

  async permissionsFor(orgId: string, roleKey: string): Promise<string[]> {
    const system = systemRole(roleKey);
    if (system) return [...system.permissions];
    const custom = await this.roles
      .findOne({ orgId: new Types.ObjectId(orgId), key: roleKey }, null, { [CROSS_TENANT]: true })
      .lean()
      .exec();
    return custom ? [...custom.permissions] : [];
  }
}
