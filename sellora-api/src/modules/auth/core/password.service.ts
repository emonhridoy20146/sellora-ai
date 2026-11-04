import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfig } from '../../../config/app-config.js';

/**
 * argon2id password hashing (OWASP recommended parameters). Hashes created with older
 * parameters are transparently upgraded on the next successful login.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.HashOptions;
  private dummyHash?: Promise<string>;

  constructor(config: AppConfig) {
    this.options = config.isTest
      ? { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 }
      : { type: argon2.argon2id, memoryCost: 47104, timeCost: 1, parallelism: 1 };
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password.normalize('NFKC'), { ...this.options, raw: false });
  }

  async verify(hash: string | undefined | null, password: string): Promise<boolean> {
    if (!hash) {
      // Spend comparable time when the account does not exist (prevents user enumeration).
      this.dummyHash ??= this.hash('dummy-password-for-timing');
      await argon2.verify(await this.dummyHash, password.normalize('NFKC')).catch(() => false);
      return false;
    }
    try {
      return await argon2.verify(hash, password.normalize('NFKC'));
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, this.options);
  }
}
