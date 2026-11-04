import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppConfig } from '../../config/app-config.js';
import { AppError } from '../../common/errors/app-error.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { safeEqual } from '../../common/crypto/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { OneTimeTokenService } from '../auth/core/one-time-token.service.js';
import { PasswordService } from '../auth/core/password.service.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { SessionService, type IssuedTokens } from '../auth/core/session.service.js';
import { TokenService } from '../auth/core/token.service.js';
import { TotpService } from '../auth/core/totp.service.js';
import type { PlatformUser } from './platform-user.schema.js';

export type PlatformUserDoc = PlatformUser & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const SECRET_FIELDS =
  '+passwordHash +mfa.totpSecretEnc +mfa.totpPendingSecretEnc +mfa.totpLastStep +mfa.recoveryCodes';
const CHALLENGE_TTL_S = 300;
const SETUP_TTL_S = 900;

export type PlatformLoginResult =
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; setupToken: string };

export function toPlatformUserDto(u: PlatformUserDoc) {
  return {
    id: u._id.toHexString(),
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    mfaEnabled: Boolean(u.mfa.totpEnabledAt),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

/**
 * Platform realm sign-in. Two-factor authentication is mandatory: a correct password
 * only yields a short challenge token, never a session, until a TOTP code is verified.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    @InjectModel('PlatformUser') private readonly users: Model<PlatformUser>,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    private readonly encryption: EncryptionService,
    private readonly sessions: SessionService,
    private readonly oneTime: OneTimeTokenService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private aad(id: string): string {
    return `platform-totp:${id}`;
  }

  private load(id: string, secrets = false): Promise<PlatformUserDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    const q = this.users.findById(id);
    if (secrets) q.select(SECRET_FIELDS);
    return q.lean<PlatformUserDoc>().exec();
  }

  async login(
    email: string,
    password: string,
    client: { ip?: string; userAgent?: string },
  ): Promise<PlatformLoginResult> {
    if (client.ip) {
      await this.limits.consume('login:ip', `p:${client.ip}`);
      await this.limits.assertNotBlocked('login-fail:ip', `p:${client.ip}`);
    }
    await this.limits.assertNotBlocked('login-fail:account', `p:${email}`);
    const user = await this.users
      .findOne({ email })
      .select(SECRET_FIELDS)
      .lean<PlatformUserDoc>()
      .exec();
    const ok = await this.passwords.verify(user?.passwordHash, password);
    if (
      !user ||
      !ok ||
      user.status !== 'active' ||
      (user.lockedUntil && user.lockedUntil > new Date())
    ) {
      await this.limits.consume('login-fail:account', `p:${email}`).catch(() => undefined);
      if (client.ip)
        await this.limits.consume('login-fail:ip', `p:${client.ip}`).catch(() => undefined);
      await this.audit.recordSafe({
        action: 'platform.auth.login.failed',
        outcome: 'failure',
        actor: user
          ? { type: 'platform', id: user._id.toHexString(), label: user.email }
          : { type: 'anonymous', id: 'anonymous', label: email },
        metadata: { ip: client.ip, reason: !user || !ok ? 'bad_credentials' : user.status },
      });
      throw AppError.unauthorized('invalid_credentials', 'Email or password is incorrect.');
    }
    const id = user._id.toHexString();
    if (!user.mfa.totpEnabledAt) {
      return {
        status: 'mfa_setup_required',
        setupToken: await this.tokens.signPurpose('platform-mfa-setup', id, {}, SETUP_TTL_S),
      };
    }
    return {
      status: 'mfa_required',
      mfaToken: await this.tokens.signPurpose('mfa', id, { realm: 'platform' }, CHALLENGE_TTL_S),
    };
  }

  /** First sign-in: create the authenticator secret (requires the setup token). */
  async beginMfaSetup(setupToken: string): Promise<{ secret: string; otpauthUrl: string }> {
    const claims = await this.tokens.verifyPurpose(setupToken, 'platform-mfa-setup');
    const user = await this.load(claims.sub);
    if (!user || user.status !== 'active' || user.mfa.totpEnabledAt)
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');
    const secret = this.totp.createSecret();
    await this.users
      .updateOne(
        { _id: user._id },
        {
          $set: {
            'mfa.totpPendingSecretEnc': this.encryption.encrypt(secret, this.aad(claims.sub)),
          },
        },
      )
      .exec();
    return { secret, otpauthUrl: this.totp.uri(secret, user.email, ' Platform') };
  }

  async completeMfaSetup(
    setupToken: string,
    code: string,
    client: { ip?: string; userAgent?: string },
  ): Promise<{ tokens: IssuedTokens; user: PlatformUserDoc; recoveryCodes: string[] }> {
    const claims = await this.tokens.verifyPurpose(setupToken, 'platform-mfa-setup');
    const user = await this.load(claims.sub, true);
    if (
      !user ||
      user.status !== 'active' ||
      user.mfa.totpEnabledAt ||
      !user.mfa.totpPendingSecretEnc
    ) {
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');
    }
    await this.limits.assertNotBlocked('mfa-fail:subject', `p:${claims.sub}`);
    const secret = this.encryption.decrypt(user.mfa.totpPendingSecretEnc, this.aad(claims.sub));
    const result = await this.totp.verify(secret, code);
    if (!result.valid) {
      await this.limits.consume('mfa-fail:subject', `p:${claims.sub}`);
      throw AppError.unauthorized('invalid_mfa_code', 'The code is incorrect.');
    }
    const { codes, hashes } = this.totp.createRecoveryCodes();
    const enabledAt = new Date();
    await this.users
      .updateOne(
        { _id: user._id },
        {
          $set: {
            'mfa.totpSecretEnc': this.encryption.encrypt(secret, this.aad(claims.sub)),
            'mfa.totpEnabledAt': enabledAt,
            'mfa.totpLastStep': result.timeStep,
            'mfa.recoveryCodes': hashes.map((hash) => ({ hash })),
          },
          $unset: { 'mfa.totpPendingSecretEnc': '' },
        },
      )
      .exec();
    await this.audit.record({
      action: 'platform.auth.mfa.enabled',
      actor: { type: 'platform', id: claims.sub, label: user.email },
    });
    const tokens = await this.startSession(user, ['pwd', 'totp'], client);
    return {
      tokens,
      user: { ...user, mfa: { ...user.mfa, totpEnabledAt: enabledAt } },
      recoveryCodes: codes,
    };
  }

  async loginWithMfa(
    mfaToken: string,
    input: { code?: string; recoveryCode?: string },
    client: { ip?: string; userAgent?: string },
  ): Promise<{ tokens: IssuedTokens; user: PlatformUserDoc }> {
    const claims = await this.tokens.verifyPurpose(mfaToken, 'mfa');
    if (claims.realm !== 'platform')
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');
    await this.limits.assertNotBlocked('mfa-fail:subject', `p:${claims.sub}`);
    const user = await this.load(claims.sub, true);
    if (!user || user.status !== 'active' || !user.mfa.totpEnabledAt || !user.mfa.totpSecretEnc)
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');

    let method: 'totp' | 'recovery' | null = null;
    if (input.code) {
      const secret = this.encryption.decrypt(user.mfa.totpSecretEnc, this.aad(claims.sub));
      const result = await this.totp.verify(secret, input.code, user.mfa.totpLastStep);
      if (result.valid) {
        const claimed = await this.users
          .updateOne(
            {
              _id: user._id,
              $or: [
                { 'mfa.totpLastStep': { $exists: false } },
                { 'mfa.totpLastStep': { $lt: result.timeStep } },
              ],
            },
            { $set: { 'mfa.totpLastStep': result.timeStep } },
          )
          .exec();
        if (claimed.modifiedCount === 1) method = 'totp';
      }
    } else if (input.recoveryCode) {
      const hash = this.totp.hashRecoveryCode(input.recoveryCode);
      if (user.mfa.recoveryCodes.some((c) => !c.usedAt && safeEqual(c.hash, hash))) {
        const claimed = await this.users
          .updateOne(
            {
              _id: user._id,
              'mfa.recoveryCodes': { $elemMatch: { hash, usedAt: { $exists: false } } },
            },
            { $set: { 'mfa.recoveryCodes.$.usedAt': new Date() } },
          )
          .exec();
        if (claimed.modifiedCount === 1) method = 'recovery';
      }
    }
    if (!method) {
      await this.limits.consume('mfa-fail:subject', `p:${claims.sub}`);
      await this.audit.recordSafe({
        action: 'platform.auth.mfa.failed',
        outcome: 'failure',
        actor: { type: 'platform', id: claims.sub, label: user.email },
      });
      throw AppError.unauthorized('invalid_mfa_code', 'The code is incorrect.');
    }
    await this.limits.reset('mfa-fail:subject', `p:${claims.sub}`);
    return { tokens: await this.startSession(user, ['pwd', method], client), user };
  }

  private async startSession(
    user: PlatformUserDoc,
    amr: string[],
    client: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    const tokens = await this.sessions.create({
      realm: 'platform',
      subjectId: user._id.toHexString(),
      amr,
      platformRole: user.role,
      ...client,
    });
    await this.users
      .updateOne(
        { _id: user._id },
        {
          $set: {
            lastLoginAt: new Date(),
            failedLoginCount: 0,
            ...(client.ip ? { lastLoginIp: client.ip } : {}),
          },
        },
      )
      .exec();
    await this.limits.reset('login-fail:account', `p:${user.email}`);
    await this.audit.record({
      action: 'platform.auth.login',
      actor: {
        type: 'platform',
        id: user._id.toHexString(),
        sessionId: tokens.sessionId,
        label: user.email,
      },
      metadata: { amr, ip: client.ip },
    });
    return tokens;
  }

  async refresh(
    refreshToken: string,
    client: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    return this.sessions.refresh(refreshToken, 'platform', client, async (subjectId) => {
      const user = await this.load(subjectId);
      if (!user || user.status !== 'active')
        throw AppError.unauthorized(
          'session_revoked',
          'This session has ended. Please sign in again.',
        );
      return user.role;
    });
  }

  /** Account setup from the emailed invitation link: choose a password. */
  async previewSetup(token: string): Promise<{ email: string; name: string; role: string }> {
    const peek = await this.oneTime.peek('platform_setup', token);
    const user = peek ? await this.load(peek.subjectId) : null;
    if (!user)
      throw AppError.badRequest('invalid_token', 'This setup link is invalid or has expired.');
    return { email: user.email, name: user.name, role: user.role };
  }

  async completeSetup(token: string, password: string): Promise<void> {
    const consumed = await this.oneTime.consume('platform_setup', token);
    const user = consumed ? await this.load(consumed.subjectId) : null;
    if (!user || user.status === 'disabled')
      throw AppError.badRequest('invalid_token', 'This setup link is invalid or has expired.');
    await this.users
      .updateOne(
        { _id: user._id },
        {
          $set: {
            passwordHash: await this.passwords.hash(password),
            passwordChangedAt: new Date(),
            status: 'active',
            'mfa.recoveryCodes': [],
          },
          $unset: {
            'mfa.totpSecretEnc': '',
            'mfa.totpEnabledAt': '',
            'mfa.totpLastStep': '',
            'mfa.totpPendingSecretEnc': '',
          },
        },
      )
      .exec();
    await this.sessions.revokeAll(user._id.toHexString(), 'platform', 'account_setup');
    await this.audit.record({
      action: 'platform.auth.setup_completed',
      actor: { type: 'platform', id: user._id.toHexString(), label: user.email },
    });
  }

  async me(id: string): Promise<PlatformUserDoc> {
    const user = await this.load(id);
    if (!user || user.status !== 'active') throw AppError.unauthorized();
    return user;
  }

  setupUrl(token: string): string {
    return `${this.config.get('WEB_APP_URL')}/admin/setup?token=${encodeURIComponent(token)}`;
  }

  /**
   * A fresh authenticator code for a sensitive step (downloading or restoring a backup), on top
   * of the session. Each code works once, like at sign-in; wrong codes count toward the lock.
   */
  async confirmCode(userId: string, code: string): Promise<void> {
    await this.limits.assertNotBlocked('mfa-fail:subject', `p:${userId}`);
    const user = await this.load(userId, true);
    if (!user || user.status !== 'active' || !user.mfa.totpSecretEnc)
      throw AppError.forbidden('mfa_required', 'Set up two-step verification first.');
    const secret = this.encryption.decrypt(user.mfa.totpSecretEnc, this.aad(userId));
    const result = await this.totp.verify(secret, code, user.mfa.totpLastStep);
    let ok = false;
    if (result.valid) {
      const claimed = await this.users
        .updateOne(
          {
            _id: user._id,
            $or: [
              { 'mfa.totpLastStep': { $exists: false } },
              { 'mfa.totpLastStep': { $lt: result.timeStep } },
            ],
          },
          { $set: { 'mfa.totpLastStep': result.timeStep } },
        )
        .exec();
      ok = claimed.modifiedCount === 1;
    }
    if (!ok) {
      await this.limits.consume('mfa-fail:subject', `p:${userId}`);
      await this.audit.recordSafe({
        action: 'platform.auth.confirm.failed',
        outcome: 'failure',
        actor: { type: 'platform', id: userId, label: user.email },
      });
      throw AppError.validation([
        { path: 'code', message: 'The code is incorrect or was already used. Wait for a new one.' },
      ]);
    }
    await this.limits.reset('mfa-fail:subject', `p:${userId}`);
  }
}
