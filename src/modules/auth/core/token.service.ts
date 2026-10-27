import { Injectable } from '@nestjs/common';
import {
  SignJWT,
  errors as joseErrors,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../../../config/app-config.js';
import { AppError } from '../../../common/errors/app-error.js';

export type Realm = 'merchant' | 'platform';

export interface AccessClaims {
  sub: string;
  sid: string;
  realm: Realm;
  amr: string[];
  /** Platform role, only for platform tokens. */
  prole?: string;
}

const AUDIENCE: Record<Realm, string> = { merchant: 'sellora:app', platform: 'sellora:platform' };
const ALG = 'EdDSA';

type Key = Awaited<ReturnType<typeof importSPKI>>;

/**
 * Signs and verifies JWTs with Ed25519. Access tokens are short-lived and always tied to
 * a server-side session (sid) that can be revoked. Purpose tokens (MFA challenge, platform
 * setup) carry their own audience so they can never be used as access tokens.
 */
@Injectable()
export class TokenService {
  private privateKey?: Key;
  private readonly publicKeys = new Map<string, Key>();
  private ready?: Promise<void>;

  constructor(private readonly config: AppConfig) {}

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
      this.privateKey = await importPKCS8(decode(this.config.get('JWT_PRIVATE_KEY')), ALG);
      this.publicKeys.set(
        this.config.get('JWT_KEY_ID'),
        await importSPKI(decode(this.config.get('JWT_PUBLIC_KEY')), ALG),
      );
      const previous = this.config.get('JWT_PREVIOUS_PUBLIC_KEYS');
      if (previous) {
        for (const { kid, pem } of JSON.parse(previous) as { kid: string; pem: string }[]) {
          this.publicKeys.set(kid, await importSPKI(decode(pem), ALG));
        }
      }
    })();
    return this.ready;
  }

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresIn: number }> {
    await this.init();
    const ttl =
      claims.realm === 'platform'
        ? this.config.get('PLATFORM_ACCESS_TOKEN_TTL_SECONDS')
        : this.config.get('ACCESS_TOKEN_TTL_SECONDS');
    const token = await new SignJWT({
      sid: claims.sid,
      amr: claims.amr,
      ...(claims.prole ? { prole: claims.prole } : {}),
    })
      .setProtectedHeader({ alg: ALG, kid: this.config.get('JWT_KEY_ID'), typ: 'at+jwt' })
      .setSubject(claims.sub)
      .setIssuer(this.config.get('JWT_ISSUER'))
      .setAudience(AUDIENCE[claims.realm])
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ttl}s`)
      .sign(this.privateKey!);
    return { token, expiresIn: ttl };
  }

  async verifyAccess(token: string, realm: Realm): Promise<AccessClaims> {
    const payload = await this.verify(token, AUDIENCE[realm], 'at+jwt');
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
      throw AppError.unauthorized('invalid_token', 'The access token is invalid.');
    return {
      sub: payload.sub,
      sid: payload.sid,
      realm,
      amr: Array.isArray(payload.amr) ? (payload.amr as string[]) : [],
      ...(typeof payload.prole === 'string' ? { prole: payload.prole } : {}),
    };
  }

  /** Short-lived single-purpose token (e.g. "mfa" challenge after a correct password). */
  async signPurpose(
    purpose: string,
    subject: string,
    data: Record<string, unknown>,
    ttlSeconds: number,
  ): Promise<string> {
    await this.init();
    return new SignJWT({ ...data, pur: purpose })
      .setProtectedHeader({ alg: ALG, kid: this.config.get('JWT_KEY_ID'), typ: 'pt+jwt' })
      .setSubject(subject)
      .setIssuer(this.config.get('JWT_ISSUER'))
      .setAudience(`sellora:purpose:${purpose}`)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.privateKey!);
  }

  async verifyPurpose(
    token: string,
    purpose: string,
  ): Promise<JWTPayload & { sub: string; jti: string }> {
    const payload = await this.verify(token, `sellora:purpose:${purpose}`, 'pt+jwt');
    if (
      payload.pur !== purpose ||
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');
    }
    return payload as JWTPayload & { sub: string; jti: string };
  }

  private async verify(token: string, audience: string, typ: string): Promise<JWTPayload> {
    await this.init();
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid ? this.publicKeys.get(header.kid) : undefined;
          if (!key) throw new joseErrors.JWKSNoMatchingKey();
          return key;
        },
        {
          issuer: this.config.get('JWT_ISSUER'),
          audience,
          algorithms: [ALG],
          typ,
          clockTolerance: 5,
        },
      );
      return payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired)
        throw AppError.unauthorized('token_expired', 'The token has expired.');
      throw AppError.unauthorized('invalid_token', 'The token is invalid or expired.');
    }
  }
}
