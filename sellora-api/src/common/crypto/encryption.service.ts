import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppConfig } from '../../config/app-config.js';

const VERSION = 'v1';

/**
 * AES-256-GCM envelope for secrets stored in MongoDB (TOTP seeds, channel access tokens,
 * gateway credentials). Ciphertext format: v1.<kid>.<iv>.<tag>.<data> (base64url parts).
 * Keys rotate by adding a new kid and switching DATA_ENCRYPTION_ACTIVE_KID; old values
 * still decrypt and are re-encrypted on next write.
 */
@Injectable()
export class EncryptionService {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKid: string;

  constructor(config: AppConfig) {
    for (const pair of config.get('DATA_ENCRYPTION_KEYS').split(',')) {
      const [kid, b64] = pair.trim().split(':');
      if (!kid || !b64) throw new Error('DATA_ENCRYPTION_KEYS entries must be kid:base64key');
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) throw new Error(`Encryption key "${kid}" must be 32 bytes`);
      this.keys.set(kid, key);
    }
    this.activeKid = config.get('DATA_ENCRYPTION_ACTIVE_KID');
  }

  encrypt(plaintext: string, associatedData?: string): string {
    const key = this.keys.get(this.activeKid)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (associatedData) cipher.setAAD(Buffer.from(associatedData));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.activeKid,
      iv.toString('base64url'),
      tag.toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, associatedData?: string): string {
    const [version, kid, ivB64, tagB64, dataB64] = payload.split('.');
    if (version !== VERSION || !kid || !ivB64 || !tagB64 || dataB64 === undefined) {
      throw new Error('Malformed encrypted value');
    }
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Unknown encryption key id "${kid}"`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    if (associatedData) decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.activeKid;
  }
}
