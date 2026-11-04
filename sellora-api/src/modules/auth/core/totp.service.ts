import { Injectable } from '@nestjs/common';
import { generate, generateSecret, generateURI, verify } from 'otplib';
import { AppConfig } from '../../../config/app-config.js';
import { normalizeRecoveryCode, recoveryCode, sha256 } from '../../../common/crypto/tokens.js';

export interface TotpVerification {
  valid: boolean;
  /** Time step that matched, stored to block replay of the same code. */
  timeStep?: number;
}

/** RFC 6238 TOTP (30 s, 6 digits, SHA-1 for authenticator app compatibility). */
@Injectable()
export class TotpService {
  constructor(private readonly config: AppConfig) {}

  createSecret(): string {
    return generateSecret({ length: 20 });
  }

  uri(secret: string, accountLabel: string, issuerSuffix = ''): string {
    return generateURI({
      issuer: `${this.config.get('APP_NAME')}${issuerSuffix}`,
      label: accountLabel,
      secret,
    });
  }

  /**
   * Accepts the current code and one step either side for clock drift. A code whose step is
   * not newer than `lastUsedStep` is rejected so a captured code cannot be replayed.
   */
  async verify(
    secret: string,
    code: string,
    lastUsedStep?: number | null,
  ): Promise<TotpVerification> {
    if (!/^\d{6}$/.test(code)) return { valid: false };
    const result = await verify({ secret, token: code, epochTolerance: 30 });
    if (!result.valid || !('timeStep' in result)) return { valid: false };
    if (lastUsedStep !== undefined && lastUsedStep !== null && result.timeStep <= lastUsedStep)
      return { valid: false };
    return { valid: true, timeStep: result.timeStep };
  }

  /** For tests and tooling only. */
  async currentCode(secret: string, epochSeconds?: number): Promise<string> {
    return generate({ secret, ...(epochSeconds ? { epoch: epochSeconds } : {}) });
  }

  createRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
    const codes = Array.from({ length: count }, () => recoveryCode());
    return { codes, hashes: codes.map((c) => sha256(normalizeRecoveryCode(c))) };
  }

  hashRecoveryCode(code: string): string {
    return sha256(normalizeRecoveryCode(code));
  }
}
