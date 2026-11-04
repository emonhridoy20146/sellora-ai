import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/core/password.service.js';
import { OWNER_ROLE_KEY } from '../iam/permissions.js';
import { UsersService } from '../users/users.service.js';
import { MembershipRepository } from './repositories.js';
import { RolesService, holdsAll } from './roles.service.js';
import type { Organization } from './schemas.js';
import { TenantAccessService } from './tenant-access.service.js';

export interface MemberDto {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: { key: string; name: string };
  status: string;
  mfaEnabled: boolean;
  joinedAt: string;
  isYou: boolean;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly roles: RolesService,
    private readonly users: UsersService,
    private readonly access: TenantAccessService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly tx: TransactionService,
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
  ) {}

  async list(): Promise<MemberDto[]> {
    const memberships = await this.members.find({}, { sort: { joinedAt: 1 }, limit: 1000 });
    const users = await this.users.findByIds(memberships.map((m) => m.userId));
    const userById = new Map(users.map((u) => [u._id.toHexString(), u]));
    const roleList = await this.roles.list();
    const roleName = new Map(roleList.map((r) => [r.key, r.name]));
    const me = RequestContext.actor().id;
    return memberships.flatMap((m) => {
      const user = userById.get(m.userId.toHexString());
      if (!user) return [];
      return [
        {
          id: m._id.toHexString(),
          userId: user._id.toHexString(),
          name: user.name,
          email: user.email,
          role: { key: m.roleKey, name: roleName.get(m.roleKey) ?? m.roleKey },
          status: m.status,
          mfaEnabled: Boolean(user.mfa.totpEnabledAt),
          joinedAt: m.joinedAt.toISOString(),
          isYou: user._id.toHexString() === me,
        },
      ];
    });
  }

  /** Checks the actor may manage `target` (anti-escalation and owner protection). */
  private async assertCanManage(targetRoleKey: string, targetUserId: string): Promise<void> {
    const tenant = RequestContext.tenant()!;
    if (targetRoleKey === OWNER_ROLE_KEY)
      throw AppError.forbidden(
        'owner_protected',
        'The owner cannot be changed or removed. Transfer ownership first.',
      );
    if (targetUserId === RequestContext.actor().id)
      throw AppError.forbidden('self_change', 'You cannot change your own role.');
    const targetPermissions = await this.access.permissionsFor(tenant.orgId, targetRoleKey);
    if (!holdsAll(tenant.permissions, targetPermissions)) {
      throw AppError.forbidden(
        'permission_escalation',
        'You cannot manage someone with more access than you.',
      );
    }
  }

  async changeRole(memberId: string, roleKey: string): Promise<void> {
    const tenant = RequestContext.tenant()!;
    const member = await this.members.findById(memberId);
    if (!member) throw AppError.notFound('member');
    await this.assertCanManage(member.roleKey, member.userId.toHexString());
    if (roleKey === OWNER_ROLE_KEY)
      throw AppError.forbidden(
        'owner_protected',
        'Use ownership transfer to make someone the owner.',
      );
    const role = await this.roles.resolve(roleKey);
    if (!role) throw AppError.validation([{ path: 'roleKey', message: 'Unknown role' }]);
    if (!holdsAll(tenant.permissions, role.permissions))
      throw AppError.forbidden(
        'permission_escalation',
        'You cannot assign a role with permissions you do not have.',
      );
    await this.tx.run(async () => {
      await this.members.updateOne({ _id: member._id }, { $set: { roleKey } });
      await this.audit.record({
        action: 'member.role_changed',
        orgId: tenant.orgId,
        target: { type: 'member', id: memberId },
        metadata: { from: member.roleKey, to: roleKey, userId: member.userId },
      });
    });
    await this.access.invalidate(tenant.orgId);
  }

  async setStatus(memberId: string, status: 'active' | 'suspended'): Promise<void> {
    const tenant = RequestContext.tenant()!;
    const member = await this.members.findById(memberId);
    if (!member) throw AppError.notFound('member');
    await this.assertCanManage(member.roleKey, member.userId.toHexString());
    await this.tx.run(async () => {
      await this.members.updateOne({ _id: member._id }, { $set: { status } });
      await this.audit.record({
        action: `member.${status === 'active' ? 'reactivated' : 'suspended'}`,
        orgId: tenant.orgId,
        target: { type: 'member', id: memberId },
        metadata: { userId: member.userId },
      });
    });
    await this.access.invalidate(tenant.orgId);
  }

  async remove(memberId: string): Promise<void> {
    const tenant = RequestContext.tenant()!;
    const member = await this.members.findById(memberId);
    if (!member) throw AppError.notFound('member');
    await this.assertCanManage(member.roleKey, member.userId.toHexString());
    await this.tx.run(async () => {
      await this.members.deleteOne({ _id: member._id });
      await this.audit.record({
        action: 'member.removed',
        orgId: tenant.orgId,
        target: { type: 'member', id: memberId },
        metadata: { userId: member.userId, roleKey: member.roleKey },
      });
    });
    await this.access.invalidate(tenant.orgId);
  }

  async leave(): Promise<void> {
    const tenant = RequestContext.tenant()!;
    if (tenant.roleKey === OWNER_ROLE_KEY)
      throw AppError.forbidden(
        'owner_protected',
        'Transfer ownership before leaving the business.',
      );
    await this.tx.run(async () => {
      await this.members.deleteOne({ _id: new Types.ObjectId(tenant.membershipId) });
      await this.audit.record({
        action: 'member.left',
        orgId: tenant.orgId,
        target: { type: 'member', id: tenant.membershipId },
      });
    });
    await this.access.invalidate(tenant.orgId);
  }

  /** Owner hands the business to another active member and becomes an admin. */
  async transferOwnership(toMemberId: string, password: string): Promise<void> {
    const tenant = RequestContext.tenant()!;
    const actorId = RequestContext.actor().id;
    if (tenant.roleKey !== OWNER_ROLE_KEY)
      throw AppError.forbidden('owner_only', 'Only the owner can transfer ownership.');
    const me = await this.users.findWithSecrets({ _id: new Types.ObjectId(actorId) });
    if (!me || !(await this.passwords.verify(me.passwordHash, password)))
      throw AppError.forbidden('invalid_password', 'Your password is incorrect.');
    const target = await this.members.findById(toMemberId);
    if (!target || target.status !== 'active') throw AppError.notFound('member');
    if (target.userId.toHexString() === actorId)
      throw AppError.badRequest('already_owner', 'You already own this business.');
    const targetUser = await this.users.findById(target.userId);
    if (!targetUser?.emailVerifiedAt)
      throw AppError.unprocessable(
        'email_unverified',
        'The new owner must verify their email first.',
      );

    await this.tx.run(async () => {
      await this.members.updateOne(
        { _id: new Types.ObjectId(tenant.membershipId) },
        { $set: { roleKey: 'admin' } },
      );
      await this.members.updateOne({ _id: target._id }, { $set: { roleKey: OWNER_ROLE_KEY } });
      await this.orgs
        .updateOne(
          { _id: new Types.ObjectId(tenant.orgId) },
          { $set: { ownerUserId: target.userId } },
        )
        .exec();
      await this.audit.record({
        action: 'org.ownership_transferred',
        orgId: tenant.orgId,
        target: { type: 'user', id: target.userId.toHexString(), label: targetUser.email },
        metadata: { from: actorId },
      });
    });
    await this.access.invalidate(tenant.orgId);
  }
}
