import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import { OneTimeTokenService } from '../auth/core/one-time-token.service.js';
import { SessionService } from '../auth/core/session.service.js';
import { PLATFORM_ROLE_RANK, type PlatformRole } from '../iam/platform-permissions.js';
import {
  PlatformAuthService,
  toPlatformUserDto,
  type PlatformUserDoc,
} from './platform-auth.service.js';
import type { PlatformUser } from './platform-user.schema.js';

const SETUP_TTL_MS = 24 * 3600_000;

/**
 * System admins created by the super-admin. Rules: you can only manage accounts ranked
 * below you (owners can manage everyone but themselves), you cannot grant a role above
 * your own, and the last active owner can never be demoted or disabled.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(
    @InjectModel('PlatformUser') private readonly users: Model<PlatformUser>,
    private readonly oneTime: OneTimeTokenService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly auth: PlatformAuthService,
  ) {}

  private actor(): { id: string; role: PlatformRole } {
    const actor = RequestContext.actor();
    return { id: actor.id, role: actor.platformRole as PlatformRole };
  }

  private assertCanManage(
    target: { role: PlatformRole; id: string },
    newRole?: PlatformRole,
  ): void {
    const me = this.actor();
    if (target.id === me.id)
      throw AppError.forbidden('self_change', 'You cannot change your own platform account here.');
    const myRank = PLATFORM_ROLE_RANK[me.role];
    const isOwner = me.role === 'owner';
    if (!isOwner && PLATFORM_ROLE_RANK[target.role] >= myRank)
      throw AppError.forbidden('rank_too_low', 'You can only manage admins below your role.');
    if (newRole && !isOwner && PLATFORM_ROLE_RANK[newRole] >= myRank)
      throw AppError.forbidden(
        'rank_too_low',
        'You cannot grant a role equal to or above your own.',
      );
  }

  private async assertNotLastOwner(target: PlatformUserDoc): Promise<void> {
    if (target.role !== 'owner') return;
    const owners = await this.users.countDocuments({ role: 'owner', status: 'active' }).exec();
    if (owners <= 1)
      throw AppError.conflict('last_owner', 'The platform must keep at least one active owner.');
  }

  async list() {
    const users = await this.users.find({}).sort({ createdAt: 1 }).lean<PlatformUserDoc[]>().exec();
    return users.map(toPlatformUserDto);
  }

  async invite(input: { email: string; name: string; role: PlatformRole }) {
    this.assertCanManage({ role: input.role, id: 'new' }, input.role);
    let created: PlatformUserDoc;
    try {
      const [doc] = await this.users.create([
        {
          email: input.email,
          name: input.name,
          role: input.role,
          status: 'invited',
          createdBy: this.actor().id,
        },
      ]);
      created = doc!.toObject() as unknown as PlatformUserDoc;
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict(
          'already_exists',
          'A platform account with this email already exists.',
        );
      throw err;
    }
    await this.sendSetupLink(created);
    await this.audit.record({
      action: 'platform.admin.invited',
      target: { type: 'platform_user', id: created._id.toHexString(), label: created.email },
      metadata: { role: input.role },
    });
    return toPlatformUserDto(created);
  }

  private async sendSetupLink(user: PlatformUserDoc): Promise<void> {
    const token = await this.oneTime.issue('platform_setup', user._id.toHexString(), SETUP_TTL_MS);
    await this.mail.send({
      to: user.email,
      category: 'platform.setup',
      ...mailTemplates.platformInvite({
        name: user.name,
        role: user.role,
        url: this.auth.setupUrl(token),
      }),
    });
  }

  private async get(id: string): Promise<PlatformUserDoc> {
    const user = Types.ObjectId.isValid(id)
      ? await this.users.findById(id).lean<PlatformUserDoc>().exec()
      : null;
    if (!user) throw AppError.notFound('platform_user');
    return user;
  }

  async changeRole(id: string, role: PlatformRole) {
    const target = await this.get(id);
    this.assertCanManage({ role: target.role, id }, role);
    if (target.role === 'owner' && role !== 'owner') await this.assertNotLastOwner(target);
    const updated = await this.users
      .findByIdAndUpdate(id, { $set: { role } }, { returnDocument: 'after' })
      .lean<PlatformUserDoc>()
      .exec();
    // Role is embedded in access tokens; end sessions so the change applies immediately.
    await this.sessions.revokeAll(id, 'platform', 'role_changed');
    await this.audit.record({
      action: 'platform.admin.role_changed',
      target: { type: 'platform_user', id, label: target.email },
      metadata: { from: target.role, to: role },
    });
    return toPlatformUserDto(updated!);
  }

  async setStatus(id: string, status: 'active' | 'disabled') {
    const target = await this.get(id);
    this.assertCanManage({ role: target.role, id });
    if (status === 'disabled') await this.assertNotLastOwner(target);
    if (status === 'active' && !target.passwordChangedAt)
      throw AppError.conflict('setup_pending', 'This admin has not finished account setup yet.');
    const updated = await this.users
      .findByIdAndUpdate(id, { $set: { status } }, { returnDocument: 'after' })
      .lean<PlatformUserDoc>()
      .exec();
    if (status === 'disabled') await this.sessions.revokeAll(id, 'platform', 'disabled');
    await this.audit.record({
      action: `platform.admin.${status === 'active' ? 'enabled' : 'disabled'}`,
      target: { type: 'platform_user', id, label: target.email },
    });
    return toPlatformUserDto(updated!);
  }

  /** Sends a fresh setup link, which resets the password and two-factor on completion. */
  async resetAccess(id: string): Promise<void> {
    const target = await this.get(id);
    this.assertCanManage({ role: target.role, id });
    await this.sessions.revokeAll(id, 'platform', 'access_reset');
    await this.sendSetupLink(target);
    await this.audit.record({
      action: 'platform.admin.access_reset',
      target: { type: 'platform_user', id, label: target.email },
    });
  }

  /** Used by the bootstrap script when the platform has no accounts yet. */
  /** True once any platform account (of any status) exists. */
  async hasAccounts(): Promise<boolean> {
    return (await this.users.countDocuments({}).limit(1).exec()) > 0;
  }

  async bootstrapOwner(email: string, name: string): Promise<{ setupUrl: string }> {
    if ((await this.users.countDocuments({}).exec()) > 0)
      throw new Error('Platform already has accounts; use the admin panel to invite more.');
    const [doc] = await this.users.create([
      { email, name, role: 'owner', status: 'invited', createdBy: 'bootstrap' },
    ]);
    const token = await this.oneTime.issue('platform_setup', doc!._id.toHexString(), SETUP_TTL_MS);
    await this.audit.record({
      action: 'platform.bootstrap',
      actor: { type: 'system', id: 'bootstrap' },
      target: { type: 'platform_user', id: doc!._id.toHexString(), label: email },
    });
    return { setupUrl: this.auth.setupUrl(token) };
  }
}
