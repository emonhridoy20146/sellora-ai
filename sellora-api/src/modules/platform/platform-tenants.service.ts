import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../../common/errors/app-error.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/core/session.service.js';
import { OrgsService, toOrgDto } from '../orgs/orgs.service.js';
import type { Membership } from '../orgs/schemas.js';
import { UsersService, toPublicUser } from '../users/users.service.js';

/** Super-admin view over all businesses and merchant users. */
@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly orgs: OrgsService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @InjectModel('Membership') private readonly memberships: Model<Membership>,
  ) {}

  async listTenants(q: { text?: string; status?: string; page: number; pageSize: number }) {
    const { items, total } = await this.orgs.search({
      text: q.text,
      status: q.status,
      limit: q.pageSize,
      skip: (q.page - 1) * q.pageSize,
    });
    const counts = await this.memberships
      .aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { orgId: { $in: items.map((o) => o._id) } } },
        { $group: { _id: '$orgId', n: { $sum: 1 } } },
      ])
      .option({ [CROSS_TENANT]: true })
      .exec();
    const owners = await this.users.findByIds(items.map((o) => o.ownerUserId));
    const ownerById = new Map(owners.map((u) => [u._id.toHexString(), u]));
    const countByOrg = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return {
      items: items.map((org) => ({
        ...toOrgDto(org),
        memberCount: countByOrg.get(org._id.toHexString()) ?? 0,
        owner: (() => {
          const u = ownerById.get(org.ownerUserId.toHexString());
          return u ? { id: u._id.toHexString(), name: u.name, email: u.email } : null;
        })(),
        statusReason: org.statusReason ?? null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async tenantDetail(orgId: string) {
    const org = await this.orgs.get(orgId);
    const members = await this.memberships
      .find({ orgId: org._id }, null, { [CROSS_TENANT]: true })
      .lean()
      .exec();
    const users = await this.users.findByIds(members.map((m) => m.userId));
    const userById = new Map(users.map((u) => [u._id.toHexString(), u]));
    return {
      ...toOrgDto(org),
      statusReason: org.statusReason ?? null,
      statusChangedAt: org.statusChangedAt?.toISOString() ?? null,
      members: members.map((m) => {
        const u = userById.get(m.userId.toHexString());
        return {
          id: m._id.toHexString(),
          userId: m.userId.toHexString(),
          name: u?.name ?? '',
          email: u?.email ?? '',
          roleKey: m.roleKey,
          status: m.status,
        };
      }),
    };
  }

  async setTenantStatus(
    orgId: string,
    status: 'active' | 'suspended',
    reason: string,
    actorId: string,
  ) {
    const org = await this.orgs.setStatus(orgId, status, reason, actorId);
    return toOrgDto(org);
  }

  async setDemo(orgId: string, hours: number | null) {
    const org = await this.orgs.setDemo(
      orgId,
      hours ? new Date(Date.now() + hours * 3600_000) : null,
    );
    return toOrgDto(org);
  }

  async listUsers(q: { text?: string; status?: string; page: number; pageSize: number }) {
    const { items, total } = await this.users.search({
      text: q.text,
      status: q.status,
      limit: q.pageSize,
      skip: (q.page - 1) * q.pageSize,
    });
    return {
      items: items.map((u) => ({
        ...toPublicUser(u),
        status: u.status,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async userDetail(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.notFound('user');
    const orgs = await this.orgs.listForUser(userId);
    const sessions = await this.sessions.listActive(userId, 'merchant');
    return {
      ...toPublicUser(user),
      status: user.status,
      statusReason: user.statusReason ?? null,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      lastLoginIp: user.lastLoginIp ?? null,
      organizations: orgs.map(({ org, roleKey }) => ({
        id: org._id.toHexString(),
        name: org.name,
        roleKey,
        status: org.status,
      })),
      activeSessions: sessions.length,
    };
  }

  async setUserStatus(userId: string, status: 'active' | 'locked' | 'disabled', reason: string) {
    const user = await this.users.update(
      userId,
      status === 'active'
        ? { $set: { status, failedLoginCount: 0 }, $unset: { statusReason: '', lockedUntil: '' } }
        : { $set: { status, statusReason: reason } },
    );
    if (!user) throw AppError.notFound('user');
    if (status !== 'active')
      await this.sessions.revokeAll(userId, 'merchant', `platform_${status}`);
    await this.audit.record({
      action: `platform.user.${status}`,
      target: { type: 'user', id: userId, label: user.email },
      metadata: { reason },
    });
    return { ...toPublicUser(user), status: user.status };
  }

  async forceLogout(userId: string): Promise<{ revoked: number }> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.notFound('user');
    const revoked = await this.sessions.revokeAll(userId, 'merchant', 'platform_force_logout');
    await this.audit.record({
      action: 'platform.user.force_logout',
      target: { type: 'user', id: userId, label: user.email },
      metadata: { revoked },
    });
    return { revoked };
  }

  /** For a user who lost their phone and recovery codes, after identity checks by support. */
  async resetUserMfa(userId: string, reason: string): Promise<void> {
    const user = await this.users.update(userId, {
      $unset: {
        'mfa.totpSecretEnc': '',
        'mfa.totpEnabledAt': '',
        'mfa.totpLastStep': '',
        'mfa.totpPendingSecretEnc': '',
      },
      $set: { 'mfa.recoveryCodes': [] },
    });
    if (!user) throw AppError.notFound('user');
    await this.sessions.revokeAll(userId, 'merchant', 'platform_mfa_reset');
    await this.audit.record({
      action: 'platform.user.mfa_reset',
      target: { type: 'user', id: userId, label: user.email },
      metadata: { reason },
    });
  }

  async overview() {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [
      tenants,
      activeTenants,
      suspendedTenants,
      demoTenants,
      users,
      newUsersToday,
      newTenantsWeek,
    ] = await Promise.all([
      this.orgs.count({ status: { $ne: 'closed' } }),
      this.orgs.count({ status: 'active' }),
      this.orgs.count({ status: 'suspended' }),
      this.orgs.count({ isDemo: true, status: 'active' }),
      this.users.count(),
      this.users.count({ createdAt: { $gte: dayAgo } }),
      this.orgs.count({ createdAt: { $gte: weekAgo } }),
    ]);
    return {
      tenants,
      activeTenants,
      suspendedTenants,
      demoTenants,
      users,
      newUsersToday,
      newTenantsWeek,
    };
  }
}
