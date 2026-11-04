import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compact HMAC-signed tokens (payload.signature, both base64url) for URLs the storage
 * layer hands out: local uploads and private downloads. Expiry is part of the payload.
 */
export class UrlSigner {
  constructor(private readonly secret: string) {}

  sign(payload: Record<string, unknown> & { exp: number }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /** The payload when the signature is valid and the token has not expired, else null. */
  verify<T extends { exp: number }>(token: string, now = Date.now()): T | null {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = Buffer.from(this.mac(body), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let payload: T;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    } catch {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    return payload;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
