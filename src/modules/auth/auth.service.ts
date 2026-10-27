import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { AppConfig } from '../../config/app-config.js';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { safeEqual } from '../../common/crypto/tokens.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates, type Locale } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import { UsersService, type UserDoc } from '../users/users.service.js';
import { OneTimeTokenService } from './core/one-time-token.service.js';
import { PasswordService } from './core/password.service.js';
import { RateLimitService } from './core/rate-limit.service.js';
import { SessionService, type IssuedTokens } from './core/session.service.js';
import { TokenService } from './core/token.service.js';
import { TotpService } from './core/totp.service.js';

const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 30 * 60_000;
const MFA_CHALLENGE_TTL_S = 300;
const LOCK_AFTER_FAILURES = 10;
const LOCK_MINUTES = 30;

export type LoginResult =
  | { kind: 'session'; tokens: IssuedTokens; user: UserDoc }
  | { kind: 'mfa_required'; mfaToken: string };

interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly oneTime: OneTimeTokenService,
    private readonly totp: TotpService,
    private readonly encryption: EncryptionService,
    private readonly limits: RateLimitService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  private webUrl(path: string): string {
    return `${this.config.get('WEB_APP_URL')}${path}`;
  }

  /**
   * Creates an account and emails a verification link. The response is identical whether
   * or not the email is already registered, so sign-up cannot be used to discover accounts.
   */
  async signup(
    input: { name: string; email: string; password: string; locale: Locale; phone?: string },
    client: ClientInfo,
  ): Promise<void> {
    if (!(await this.platformSettings.get()).signupEnabled)
      throw AppError.forbidden(
        'signup_disabled',
        'New sign-ups are paused right now. Please try again later.',
      );
    if (client.ip) await this.limits.consume('signup:ip', client.ip);
    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      await this.mail.send({
        to: existing.email,
        category: 'auth.signup_existing',
        ...mailTemplates.signupAttemptExistingAccount(existing.locale, {
          name: existing.name,
          loginUrl: this.webUrl('/login'),
          resetUrl: this.webUrl('/forgot-password'),
        }),
      });
      await this.audit.recordSafe({
        action: 'auth.signup.duplicate',
        outcome: 'denied',
        actor: { type: 'anonymous', id: 'anonymous' },
        target: { type: 'user', id: existing._id.toHexString() },
      });
      return;
    }
    let user: UserDoc;
    try {
      user = await this.users.create({
        name: input.name,
        email: input.email,
        locale: input.locale,
        ...(input.phone ? { phone: input.phone } : {}),
        passwordHash: await this.passwords.hash(input.password),
        passwordChangedAt: new Date(),
      });
    } catch (err) {
      if (isDuplicateKey(err)) return;
      throw err;
    }
    await this.audit.record({
      action: 'auth.signup',
      actor: { type: 'user', id: user._id.toHexString(), label: user.email },
      target: { type: 'user', id: user._id.toHexString() },
    });
    await this.sendVerification(user);
  }

  private async sendVerification(user: UserDoc): Promise<void> {
    const token = await this.oneTime.issue('email_verify', user._id.toHexString(), VERIFY_TTL_MS, {
      email: user.email,
    });
    await this.mail.send({
      to: user.email,
      category: 'auth.verify',
      ...mailTemplates.verifyEmail(user.locale, {
        name: user.name,
        url: this.webUrl(`/verify-email?token=${encodeURIComponent(token)}`),
      }),
    });
  }

  async resendVerification(email: string): Promise<void> {
    await this.limits.consume('verify-resend:account', email);
    const user = await this.users.findByEmail(email);
    if (!user || user.emailVerifiedAt) return;
    await this.sendVerification(user);
  }

  async verifyEmail(token: string): Promise<void> {
    const consumed = await this.oneTime.consume('email_verify', token);
    if (!consumed)
      throw AppError.badRequest(
        'invalid_token',
        'This verification link is invalid or has expired.',
      );
    const user = await this.users.findById(consumed.subjectId);
    if (!user || user.email !== consumed.data.email)
      throw AppError.badRequest(
        'invalid_token',
        'This verification link is invalid or has expired.',
      );
    if (!user.emailVerifiedAt)
      await this.users.update(user._id, { $set: { emailVerifiedAt: new Date() } });
    await this.audit.record({
      action: 'auth.email_verified',
      actor: { type: 'user', id: user._id.toHexString(), label: user.email },
      target: { type: 'user', id: user._id.toHexString() },
    });
  }

  async login(
    input: { email: string; password: string },
    client: ClientInfo,
  ): Promise<LoginResult> {
    if (client.ip) {
      await this.limits.consume('login:ip', client.ip);
      await this.limits.assertNotBlocked('login-fail:ip', client.ip);
    }
    await this.limits.assertNotBlocked('login-fail:account', input.email);

    const user = await this.users.findWithSecrets({ email: input.email });
    const passwordOk = await this.passwords.verify(user?.passwordHash, input.password);
    if (!user || !passwordOk) {
      await this.recordFailure(input.email, client, user ?? undefined, 'bad_credentials');
      throw AppError.unauthorized('invalid_credentials', 'Email or password is incorrect.');
    }
    if (user.status === 'disabled') {
      await this.recordFailure(input.email, client, user, 'disabled');
      throw AppError.forbidden('account_disabled', 'This account is disabled. Contact support.');
    }
    if (user.status === 'locked' || (user.lockedUntil && user.lockedUntil > new Date())) {
      await this.recordFailure(input.email, client, user, 'locked');
      throw AppError.forbidden(
        'account_locked',
        'This account is temporarily locked. Reset your password or try again later.',
      );
    }

    if (this.passwords.needsRehash(user.passwordHash!)) {
      await this.users.update(user._id, {
        $set: { passwordHash: await this.passwords.hash(input.password) },
      });
    }

    if (user.mfa.totpEnabledAt) {
      const mfaToken = await this.tokens.signPurpose(
        'mfa',
        user._id.toHexString(),
        { realm: 'merchant' },
        MFA_CHALLENGE_TTL_S,
      );
      return { kind: 'mfa_required', mfaToken };
    }
    const tokens = await this.completeLogin(user, ['pwd'], client);
    return { kind: 'session', tokens, user };
  }

  async loginWithMfa(
    input: { mfaToken: string; code?: string; recoveryCode?: string },
    client: ClientInfo,
  ): Promise<{ tokens: IssuedTokens; user: UserDoc }> {
    const challenge = await this.tokens.verifyPurpose(input.mfaToken, 'mfa');
    if (challenge.realm !== 'merchant')
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');
    await this.limits.assertNotBlocked('mfa-fail:subject', challenge.sub);
    const user = await this.users.findWithSecrets({ _id: new Types.ObjectId(challenge.sub) });
    if (!user || user.status !== 'active' || !user.mfa.totpEnabledAt)
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');

    const method = await this.checkSecondFactor(user, input);
    if (!method) {
      await this.limits.consume('mfa-fail:subject', challenge.sub).catch(async (err: unknown) => {
        await this.audit.recordSafe({
          action: 'auth.mfa.blocked',
          outcome: 'denied',
          actor: { type: 'user', id: challenge.sub },
        });
        throw err;
      });
      await this.audit.recordSafe({
        action: 'auth.mfa.failed',
        outcome: 'failure',
        actor: { type: 'user', id: challenge.sub, label: user.email },
      });
      throw AppError.unauthorized('invalid_mfa_code', 'The code is incorrect.');
    }
    await this.limits.reset('mfa-fail:subject', challenge.sub);
    const tokens = await this.completeLogin(user, ['pwd', method], client);
    return { tokens, user };
  }

  /** Verifies a TOTP or recovery code, consuming it so it cannot be replayed. */
  async checkSecondFactor(
    user: UserDoc,
    input: { code?: string; recoveryCode?: string },
  ): Promise<'totp' | 'recovery' | null> {
    if (input.code && user.mfa.totpSecretEnc) {
      const secret = this.encryption.decrypt(
        user.mfa.totpSecretEnc,
        `totp:${user._id.toHexString()}`,
      );
      const result = await this.totp.verify(secret, input.code, user.mfa.totpLastStep);
      if (!result.valid) return null;
      // Conditional update: two concurrent requests with the same code cannot both pass.
      const claimed = await this.users.updateWhere(
        {
          _id: user._id,
          $or: [
            { 'mfa.totpLastStep': { $exists: false } },
            { 'mfa.totpLastStep': { $lt: result.timeStep } },
          ],
        },
        { $set: { 'mfa.totpLastStep': result.timeStep } },
      );
      return claimed ? 'totp' : null;
    }
    if (input.recoveryCode) {
      const hash = this.totp.hashRecoveryCode(input.recoveryCode);
      const match = user.mfa.recoveryCodes.find((c) => !c.usedAt && safeEqual(c.hash, hash));
      if (!match) return null;
      const claimed = await this.users.updateWhere(
        {
          _id: user._id,
          'mfa.recoveryCodes': { $elemMatch: { hash, usedAt: { $exists: false } } },
        },
        { $set: { 'mfa.recoveryCodes.$.usedAt': new Date() } },
      );
      if (claimed)
        await this.audit.record({
          action: 'auth.mfa.recovery_code_used',
          actor: { type: 'user', id: user._id.toHexString(), label: user.email },
          metadata: { remaining: user.mfa.recoveryCodes.filter((c) => !c.usedAt).length - 1 },
        });
      return claimed ? 'recovery' : null;
    }
    return null;
  }

  private async completeLogin(
    user: UserDoc,
    amr: string[],
    client: ClientInfo,
  ): Promise<IssuedTokens> {
    const tokens = await this.sessions.create({
      realm: 'merchant',
      subjectId: user._id.toHexString(),
      amr,
      ...client,
    });
    const knownIp = user.lastLoginIp === client.ip;
    await this.users.update(user._id, {
      $set: {
        lastLoginAt: new Date(),
        failedLoginCount: 0,
        ...(client.ip ? { lastLoginIp: client.ip } : {}),
      },
      $unset: { lockedUntil: '' },
    });
    await this.limits.reset('login-fail:account', user.email);
    await this.audit.record({
      action: 'auth.login',
      actor: {
        type: 'user',
        id: user._id.toHexString(),
        sessionId: tokens.sessionId,
        label: user.email,
      },
      metadata: { amr, ip: client.ip },
    });
    if (!knownIp && user.lastLoginAt && client.ip) {
      await this.mail.send({
        to: user.email,
        category: 'auth.new_login',
        ...mailTemplates.newDeviceLogin(user.locale, {
          name: user.name,
          ip: client.ip,
          userAgent: client.userAgent ?? 'unknown device',
          when: new Date().toUTCString(),
        }),
      });
    }
    return tokens;
  }

  private async recordFailure(
    email: string,
    client: ClientInfo,
    user: UserDoc | undefined,
    reason: string,
  ): Promise<void> {
    await Promise.all([
      this.limits.consume('login-fail:account', email).catch(() => undefined),
      client.ip
        ? this.limits.consume('login-fail:ip', client.ip).catch(() => undefined)
        : undefined,
    ]);
    if (user && reason === 'bad_credentials') {
      const updated = await this.users.update(user._id, { $inc: { failedLoginCount: 1 } });
      const failures = updated?.failedLoginCount ?? 0;
      if (failures > 0 && failures % LOCK_AFTER_FAILURES === 0) {
        await this.users.update(user._id, {
          $set: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
        });
        await this.audit.recordSafe({
          action: 'auth.account_temporarily_locked',
          outcome: 'denied',
          actor: { type: 'system', id: 'auth' },
          target: { type: 'user', id: user._id.toHexString(), label: user.email },
        });
      }
    }
    await this.audit.recordSafe({
      action: 'auth.login.failed',
      outcome: 'failure',
      actor: user
        ? { type: 'user', id: user._id.toHexString(), label: user.email }
        : { type: 'anonymous', id: 'anonymous', label: email },
      metadata: { reason, ip: client.ip },
    });
  }

  async refresh(refreshToken: string, client: ClientInfo): Promise<IssuedTokens> {
    if (client.ip) await this.limits.consume('refresh:ip', client.ip);
    return this.sessions.refresh(refreshToken, 'merchant', client);
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    await this.sessions.revoke(sessionId, 'logout');
    await this.audit.recordSafe({ action: 'auth.logout' });
  }

  async forgotPassword(email: string, client: ClientInfo): Promise<void> {
    if (client.ip) await this.limits.consume('forgot:ip', client.ip);
    await this.limits.consume('forgot:account', email);
    const user = await this.users.findByEmail(email);
    if (!user || user.status === 'disabled') return;
    const token = await this.oneTime.issue('password_reset', user._id.toHexString(), RESET_TTL_MS);
    await this.mail.send({
      to: user.email,
      category: 'auth.password_reset',
      ...mailTemplates.passwordReset(user.locale, {
        name: user.name,
        url: this.webUrl(`/reset-password?token=${encodeURIComponent(token)}`),
      }),
    });
    await this.audit.recordSafe({
      action: 'auth.password_reset.requested',
      actor: { type: 'anonymous', id: 'anonymous' },
      target: { type: 'user', id: user._id.toHexString() },
    });
  }

  /** Resets the password, unlocks the account and signs out every session. */
  async resetPassword(token: string, password: string): Promise<void> {
    const consumed = await this.oneTime.consume('password_reset', token);
    if (!consumed)
      throw AppError.badRequest('invalid_token', 'This reset link is invalid or has expired.');
    const user = await this.users.findById(consumed.subjectId);
    if (!user || user.status === 'disabled')
      throw AppError.badRequest('invalid_token', 'This reset link is invalid or has expired.');
    await this.users.update(user._id, {
      $set: {
        passwordHash: await this.passwords.hash(password),
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        ...(user.status === 'locked' ? { status: 'active' } : {}),
        ...(!user.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {}),
      },
      $unset: { lockedUntil: '' },
    });
    await this.sessions.revokeAll(user._id.toHexString(), 'merchant', 'password_reset');
    await this.limits.reset('login-fail:account', user.email);
    await this.audit.record({
      action: 'auth.password_reset',
      actor: { type: 'user', id: user._id.toHexString(), label: user.email },
    });
    await this.mail.send({
      to: user.email,
      category: 'auth.password_changed',
      ...mailTemplates.passwordChanged(user.locale, { name: user.name }),
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string,
  ): Promise<void> {
    const user = await this.users.findWithSecrets({ _id: new Types.ObjectId(userId) });
    if (!user || !(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw AppError.forbidden('invalid_password', 'Your current password is incorrect.');
    }
    if (currentPassword === newPassword)
      throw AppError.validation([
        { path: 'newPassword', message: 'Choose a password you have not used here before' },
      ]);
    await this.users.update(user._id, {
      $set: { passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: new Date() },
    });
    const revoked = await this.sessions.revokeAll(
      userId,
      'merchant',
      'password_changed',
      keepSessionId,
    );
    await this.audit.record({
      action: 'auth.password_changed',
      metadata: { otherSessionsRevoked: revoked },
    });
    await this.mail.send({
      to: user.email,
      category: 'auth.password_changed',
      ...mailTemplates.passwordChanged(user.locale, { name: user.name }),
    });
  }

  async me(userId: string): Promise<UserDoc> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized();
    return user;
  }

  async updateProfile(
    userId: string,
    patch: { name?: string; phone?: string | null; locale?: Locale; timezone?: string },
  ): Promise<UserDoc> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.locale !== undefined) $set.locale = patch.locale;
    if (patch.timezone !== undefined) $set.timezone = patch.timezone;
    if (patch.phone === null) $unset.phone = '';
    else if (patch.phone !== undefined) $set.phone = patch.phone;
    const updated = await this.users.update(userId, {
      ...(Object.keys($set).length ? { $set } : {}),
      ...(Object.keys($unset).length ? { $unset } : {}),
    });
    if (!updated) throw AppError.unauthorized();
    await this.audit.record({
      action: 'user.profile_updated',
      metadata: { fields: [...Object.keys($set), ...Object.keys($unset)] },
    });
    return updated;
  }

  currentSessionId(): string | undefined {
    return RequestContext.actor().sessionId;
  }
}
