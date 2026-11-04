import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { AppError } from '../../common/errors/app-error.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './core/password.service.js';
import { SessionService } from './core/session.service.js';
import { TotpService } from './core/totp.service.js';

/** Authenticator-app two-factor authentication for merchant users. */
@Injectable()
export class MfaService {
  constructor(
    private readonly users: UsersService,
    private readonly totp: TotpService,
    private readonly encryption: EncryptionService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private aad(userId: string): string {
    return `totp:${userId}`;
  }

  /** Step 1: create a pending secret and return the otpauth URI for the QR code. */
  async setup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized();
    if (user.mfa.totpEnabledAt)
      throw AppError.conflict('mfa_already_enabled', 'Two-factor authentication is already on.');
    const secret = this.totp.createSecret();
    await this.users.update(user._id, {
      $set: { 'mfa.totpPendingSecretEnc': this.encryption.encrypt(secret, this.aad(userId)) },
    });
    return { secret, otpauthUrl: this.totp.uri(secret, user.email) };
  }

  /** Step 2: confirm with a code from the app. Returns one-time recovery codes. */
  async enable(
    userId: string,
    code: string,
    currentSessionId: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.users.findWithSecrets({ _id: new Types.ObjectId(userId) });
    if (!user) throw AppError.unauthorized();
    if (user.mfa.totpEnabledAt)
      throw AppError.conflict('mfa_already_enabled', 'Two-factor authentication is already on.');
    if (!user.mfa.totpPendingSecretEnc)
      throw AppError.badRequest('mfa_setup_required', 'Start two-factor setup first.');
    const secret = this.encryption.decrypt(user.mfa.totpPendingSecretEnc, this.aad(userId));
    const result = await this.totp.verify(secret, code);
    if (!result.valid)
      throw AppError.unauthorized(
        'invalid_mfa_code',
        'The code is incorrect. Check the time on your phone and try again.',
      );
    const { codes, hashes } = this.totp.createRecoveryCodes();
    await this.users.update(user._id, {
      $set: {
        'mfa.totpSecretEnc': this.encryption.encrypt(secret, this.aad(userId)),
        'mfa.totpEnabledAt': new Date(),
        'mfa.totpLastStep': result.timeStep,
        'mfa.recoveryCodes': hashes.map((hash) => ({ hash })),
      },
      $unset: { 'mfa.totpPendingSecretEnc': '' },
    });
    // Sessions created before MFA was on were not verified with it; end them.
    await this.sessions.revokeAll(userId, 'merchant', 'mfa_enabled', currentSessionId);
    await this.audit.record({ action: 'auth.mfa.enabled' });
    await this.mail.send({
      to: user.email,
      category: 'auth.mfa_changed',
      ...mailTemplates.mfaChanged(user.locale, { name: user.name, enabled: true }),
    });
    return { recoveryCodes: codes };
  }

  async disable(
    userId: string,
    password: string,
    code: { code?: string; recoveryCode?: string },
  ): Promise<void> {
    const user = await this.users.findWithSecrets({ _id: new Types.ObjectId(userId) });
    if (!user) throw AppError.unauthorized();
    if (!user.mfa.totpEnabledAt)
      throw AppError.conflict('mfa_not_enabled', 'Two-factor authentication is not on.');
    if (!(await this.passwords.verify(user.passwordHash, password)))
      throw AppError.forbidden('invalid_password', 'Your password is incorrect.');
    if (!(await this.auth.checkSecondFactor(user, code)))
      throw AppError.unauthorized('invalid_mfa_code', 'The code is incorrect.');
    await this.users.update(user._id, {
      $unset: {
        'mfa.totpSecretEnc': '',
        'mfa.totpEnabledAt': '',
        'mfa.totpLastStep': '',
        'mfa.totpPendingSecretEnc': '',
      },
      $set: { 'mfa.recoveryCodes': [] },
    });
    await this.audit.record({ action: 'auth.mfa.disabled' });
    await this.mail.send({
      to: user.email,
      category: 'auth.mfa_changed',
      ...mailTemplates.mfaChanged(user.locale, { name: user.name, enabled: false }),
    });
  }

  async regenerateRecoveryCodes(
    userId: string,
    password: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.users.findWithSecrets({ _id: new Types.ObjectId(userId) });
    if (!user) throw AppError.unauthorized();
    if (!user.mfa.totpEnabledAt)
      throw AppError.conflict('mfa_not_enabled', 'Two-factor authentication is not on.');
    if (!(await this.passwords.verify(user.passwordHash, password)))
      throw AppError.forbidden('invalid_password', 'Your password is incorrect.');
    const { codes, hashes } = this.totp.createRecoveryCodes();
    await this.users.update(user._id, {
      $set: { 'mfa.recoveryCodes': hashes.map((hash) => ({ hash })) },
    });
    await this.audit.record({ action: 'auth.mfa.recovery_codes_regenerated' });
    return { recoveryCodes: codes };
  }

  async status(
    userId: string,
  ): Promise<{ enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number }> {
    const user = await this.users.findWithSecrets({ _id: new Types.ObjectId(userId) });
    if (!user) throw AppError.unauthorized();
    return {
      enabled: Boolean(user.mfa.totpEnabledAt),
      enabledAt: user.mfa.totpEnabledAt?.toISOString() ?? null,
      recoveryCodesRemaining: user.mfa.recoveryCodes.filter((c) => !c.usedAt).length,
    };
  }
}
