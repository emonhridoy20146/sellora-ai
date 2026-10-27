import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppConfig } from '../../config/app-config.js';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { randomToken, sha256 } from '../../common/crypto/tokens.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { OWNER_ROLE_KEY } from '../iam/permissions.js';
import { UsersService } from '../users/users.service.js';
import { InvitationRepository, MembershipRepository } from './repositories.js';
import { RolesService, holdsAll } from './roles.service.js';
import type { Invitation, Membership, Organization } from './schemas.js';
import { TenantAccessService } from './tenant-access.service.js';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

export interface InvitationDto {
  id: string;
  email: string;
  role: { key: string; name: string };
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
}

function statusOf(inv: Invitation): InvitationDto['status'] {
  if (inv.acceptedAt) return 'accepted';
  if (inv.revokedAt) return 'revoked';
  if (inv.expiresAt <= new Date()) return 'expired';
  return 'pending';
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly invitations: InvitationRepository,
    private readonly members: MembershipRepository,
    private readonly roles: RolesService,
    private readonly users: UsersService,
    private readonly access: TenantAccessService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly limits: RateLimitService,
    private readonly tx: TransactionService,
    private readonly config: AppConfig,
    @InjectModel('Invitation') private readonly invitationModel: Model<Invitation>,
    @InjectModel('Membership') private readonly membershipModel: Model<Membership>,
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
  ) {}

  async list(): Promise<InvitationDto[]> {
    const [items, roles] = await Promise.all([
      this.invitations.find({}, { sort: { _id: -1 }, limit: 200 }),
      this.roles.list(),
    ]);
    const roleName = new Map(roles.map((r) => [r.key, r.name]));
    return items.map((i) => ({
      id: i._id.toHexString(),
      email: i.email,
      role: { key: i.roleKey, name: roleName.get(i.roleKey) ?? i.roleKey },
      status: statusOf(i),
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    }));
  }

  async create(email: string, roleKey: string): Promise<InvitationDto> {
    const tenant = RequestContext.tenant()!;
    const actorId = RequestContext.actor().id;
    const inviter = await this.users.findById(actorId);
    if (!inviter?.emailVerifiedAt)
      throw AppError.forbidden('email_unverified', 'Verify your email before inviting staff.');
    if (roleKey === OWNER_ROLE_KEY)
      throw AppError.forbidden('owner_protected', 'You cannot invite someone as owner.');
    const role = await this.roles.resolve(roleKey);
    if (!role) throw AppError.validation([{ path: 'roleKey', message: 'Unknown role' }]);
    if (!holdsAll(tenant.permissions, role.permissions))
      throw AppError.forbidden(
        'permission_escalation',
        'You cannot invite someone with permissions you do not have.',
      );
    await this.limits.consume('invite:org', tenant.orgId);

    const existingUser = await this.users.findByEmail(email);
    if (existingUser && (await this.members.exists({ userId: existingUser._id }))) {
      throw AppError.conflict('already_member', 'This person is already on your team.');
    }
    if (
      await this.invitations.exists({
        email,
        acceptedAt: { $exists: false },
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
    ) {
      throw AppError.conflict(
        'already_invited',
        'There is already a pending invitation for this email.',
      );
    }

    const token = randomToken(32);
    const org = await this.orgs.findById(tenant.orgId, { name: 1 }).lean().exec();
    const invitation = await this.tx.run(async () => {
      const created = await this.invitations.create({
        email,
        roleKey,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedBy: new Types.ObjectId(actorId),
      });
      await this.audit.record({
        action: 'invitation.created',
        orgId: tenant.orgId,
        target: { type: 'invitation', id: created._id.toHexString(), label: email },
        metadata: { roleKey },
      });
      return created;
    });
    await this.mail.send({
      to: email,
      category: 'org.invitation',
      ...mailTemplates.invitation(inviter.locale, {
        orgName: org?.name ?? 'a business',
        inviterName: inviter.name,
        roleName: role.name,
        url: `${this.config.get('WEB_APP_URL')}/invite/${token}`,
      }),
    });
    return {
      id: invitation._id.toHexString(),
      email,
      role: { key: roleKey, name: role.name },
      status: 'pending',
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }

  async revoke(id: string): Promise<void> {
    const tenant = RequestContext.tenant()!;
    const inv = await this.invitations.findById(id);
    if (!inv) throw AppError.notFound('invitation');
    if (statusOf(inv) !== 'pending')
      throw AppError.conflict('invitation_closed', 'This invitation is no longer pending.');
    await this.invitations.updateOne({ _id: inv._id }, { $set: { revokedAt: new Date() } });
    await this.audit.record({
      action: 'invitation.revoked',
      orgId: tenant.orgId,
      target: { type: 'invitation', id, label: inv.email },
    });
  }

  private async findByToken(token: string): Promise<(Invitation & { _id: Types.ObjectId }) | null> {
    if (!token || token.length > 200) return null;
    return this.invitationModel
      .findOne({ tokenHash: sha256(token) }, null, { [CROSS_TENANT]: true })
      .lean<Invitation & { _id: Types.ObjectId }>()
      .exec();
  }

  /** Public preview so the accept page can show who invited you to what. */
  async preview(token: string): Promise<{
    orgName: string;
    roleName: string;
    email: string;
    status: InvitationDto['status'];
  }> {
    const inv = await this.findByToken(token);
    if (!inv) throw AppError.notFound('invitation');
    const org = await this.orgs.findById(inv.orgId, { name: 1 }).lean().exec();
    const role = await RequestContext.withTenant(inv.orgId.toHexString(), () =>
      this.roles.resolve(inv.roleKey),
    );
    return {
      orgName: org?.name ?? '',
      roleName: role?.name ?? inv.roleKey,
      email: maskEmail(inv.email),
      status: statusOf(inv),
    };
  }

  /** The signed-in user accepts. Their account email must match the invited email. */
  async accept(token: string, userId: string): Promise<{ orgId: string }> {
    const inv = await this.findByToken(token);
    if (!inv || statusOf(inv) !== 'pending')
      throw AppError.notFound('invitation', 'This invitation is invalid or has expired.');
    const user = await this.users.findById(userId);
    if (!user || user.email !== inv.email)
      throw AppError.forbidden(
        'invitation_email_mismatch',
        'Sign in with the email address the invitation was sent to.',
      );
    const orgId = inv.orgId.toHexString();
    await this.tx.run(async () => {
      const claimed = await this.invitationModel
        .updateOne(
          {
            _id: inv._id,
            orgId: inv.orgId,
            acceptedAt: { $exists: false },
            revokedAt: { $exists: false },
          },
          { $set: { acceptedAt: new Date(), acceptedBy: user._id } },
          { [CROSS_TENANT]: true } as never,
        )
        .exec();
      if (claimed.modifiedCount !== 1)
        throw AppError.conflict('invitation_closed', 'This invitation was already used.');
      await RequestContext.withTenant(orgId, async () => {
        const already = await this.members.exists({ userId: user._id });
        if (already)
          throw AppError.conflict('already_member', 'You are already a member of this business.');
        await this.membershipModel.create([
          {
            orgId: inv.orgId,
            userId: user._id,
            roleKey: inv.roleKey,
            invitedBy: inv.invitedBy,
            status: 'active',
          },
        ]);
      });
      // The token reached this inbox, which proves ownership of the address.
      if (!user.emailVerifiedAt)
        await this.users.update(user._id, { $set: { emailVerifiedAt: new Date() } });
      await this.audit.record({
        action: 'invitation.accepted',
        orgId,
        target: { type: 'invitation', id: inv._id.toHexString(), label: inv.email },
        metadata: { roleKey: inv.roleKey },
      });
    });
    await this.access.invalidate(orgId);
    return { orgId };
  }
}
