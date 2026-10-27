import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import { Types, type Model } from 'mongoose';
import { AppConfig } from '../../../config/app-config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { randomToken, safeEqual, sha256 } from '../../../common/crypto/tokens.js';
import { REDIS } from '../../../infra/redis/redis.module.js';
import { AuditService } from '../../audit/audit.service.js';
import type { Session } from './session.schema.js';
import { TokenService, type Realm } from './token.service.js';

export type SessionDoc = Session & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export interface IssuedTokens {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

const REUSE_GRACE_MS = 20_000;
const KEEP_PREVIOUS = 5;

/**
 * Session lifecycle for both realms: creation, refresh-token rotation with reuse detection,
 * revocation, and a Redis-backed "is this session alive" check used on every request.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectModel('Session') private readonly sessions: Model<Session>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tokens: TokenService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private ttl(realm: Realm): { absoluteMs: number; idleMs: number } {
    if (realm === 'platform') {
      const ms = this.config.get('PLATFORM_SESSION_TTL_HOURS') * 3600_000;
      return { absoluteMs: ms, idleMs: Math.min(ms, 2 * 3600_000) };
    }
    return {
      absoluteMs: this.config.get('REFRESH_TOKEN_TTL_DAYS') * 86_400_000,
      idleMs: this.config.get('REFRESH_TOKEN_IDLE_DAYS') * 86_400_000,
    };
  }

  private cacheKey(sid: string): string {
    return `sess:${sid}`;
  }

  async create(input: {
    realm: Realm;
    subjectId: string;
    amr: string[];
    ip?: string;
    userAgent?: string;
    platformRole?: string;
    impersonatedBy?: string;
  }): Promise<IssuedTokens> {
    const now = new Date();
    const { absoluteMs, idleMs } = this.ttl(input.realm);
    const secret = randomToken(32);
    const [session] = await this.sessions.create([
      {
        realm: input.realm,
        subjectId: new Types.ObjectId(input.subjectId),
        tokenHash: sha256(secret),
        amr: input.amr,
        ip: input.ip,
        userAgent: input.userAgent,
        lastUsedAt: now,
        idleExpiresAt: new Date(now.getTime() + idleMs),
        expiresAt: new Date(now.getTime() + absoluteMs),
        ...(input.impersonatedBy ? { impersonatedBy: input.impersonatedBy } : {}),
      },
    ]);
    const sid = session!._id.toHexString();
    await this.redis.set(this.cacheKey(sid), input.subjectId, 'PX', absoluteMs);
    const access = await this.tokens.signAccess({
      sub: input.subjectId,
      sid,
      realm: input.realm,
      amr: input.amr,
      ...(input.platformRole ? { prole: input.platformRole } : {}),
    });
    return {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshToken: `${sid}.${secret}`,
      refreshExpiresAt: session!.expiresAt,
      sessionId: sid,
    };
  }

  /**
   * Rotates a refresh token. Presenting an already-rotated token outside the short grace
   * window means the token was copied: the whole session is revoked.
   */
  async refresh(
    refreshToken: string,
    realm: Realm,
    client: { ip?: string; userAgent?: string },
    platformRole?: (subjectId: string) => Promise<string | undefined>,
  ): Promise<IssuedTokens & { subjectId: string }> {
    const [sid, secret] = refreshToken.split('.');
    if (!sid || !secret || !Types.ObjectId.isValid(sid))
      throw AppError.unauthorized('invalid_refresh_token', 'Please sign in again.');
    const session = await this.sessions.findById(sid).lean<SessionDoc>().exec();
    const now = new Date();
    if (!session || session.realm !== realm)
      throw AppError.unauthorized('invalid_refresh_token', 'Please sign in again.');
    if (session.revokedAt)
      throw AppError.unauthorized(
        'session_revoked',
        'This session has ended. Please sign in again.',
      );
    if (session.expiresAt <= now || session.idleExpiresAt <= now) {
      await this.revoke(sid, 'expired');
      throw AppError.unauthorized('session_expired', 'Your session expired. Please sign in again.');
    }

    const presented = sha256(secret);
    if (!safeEqual(presented, session.tokenHash)) {
      const reused = session.previousTokenHashes.some((h) => safeEqual(h, presented));
      if (reused) {
        const inGrace =
          session.rotatedAt &&
          now.getTime() - session.rotatedAt.getTime() < REUSE_GRACE_MS &&
          session.previousTokenHashes.at(-1) === presented;
        if (inGrace)
          throw AppError.conflict(
            'refresh_race',
            'The session was refreshed by another tab. Retry with the latest token.',
          );
        await this.revoke(sid, 'refresh_token_reuse');
        await this.audit.recordSafe({
          action: `${realm === 'platform' ? 'platform.' : ''}auth.refresh_token_reuse`,
          outcome: 'denied',
          actor: {
            type: realm === 'platform' ? 'platform' : 'user',
            id: session.subjectId.toHexString(),
            sessionId: sid,
          },
          metadata: { ip: client.ip },
        });
        this.logger.warn({ sid, realm }, 'Refresh token reuse detected; session revoked');
      }
      throw AppError.unauthorized('invalid_refresh_token', 'Please sign in again.');
    }

    const nextSecret = randomToken(32);
    const { idleMs } = this.ttl(realm);
    const updated = await this.sessions
      .findOneAndUpdate(
        { _id: session._id, tokenHash: session.tokenHash, revokedAt: { $exists: false } },
        {
          $set: {
            tokenHash: sha256(nextSecret),
            rotatedAt: now,
            lastUsedAt: now,
            idleExpiresAt: new Date(Math.min(now.getTime() + idleMs, session.expiresAt.getTime())),
            ...(client.ip ? { ip: client.ip } : {}),
            ...(client.userAgent ? { userAgent: client.userAgent } : {}),
          },
          $inc: { generation: 1 },
          $push: { previousTokenHashes: { $each: [session.tokenHash], $slice: -KEEP_PREVIOUS } },
        },
        { returnDocument: 'after' },
      )
      .lean<SessionDoc>()
      .exec();
    if (!updated)
      throw AppError.conflict(
        'refresh_race',
        'The session was refreshed by another tab. Retry with the latest token.',
      );

    const subjectId = session.subjectId.toHexString();
    const prole = platformRole ? await platformRole(subjectId) : undefined;
    const access = await this.tokens.signAccess({
      sub: subjectId,
      sid,
      realm,
      amr: session.amr,
      ...(prole ? { prole } : {}),
    });
    return {
      subjectId,
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshToken: `${sid}.${nextSecret}`,
      refreshExpiresAt: session.expiresAt,
      sessionId: sid,
    };
  }

  async isActive(sid: string): Promise<boolean> {
    if (await this.redis.exists(this.cacheKey(sid))) return true;
    if (!Types.ObjectId.isValid(sid)) return false;
    const session = await this.sessions
      .findById(sid, { revokedAt: 1, expiresAt: 1, subjectId: 1 })
      .lean<SessionDoc>()
      .exec();
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return false;
    await this.redis.set(
      this.cacheKey(sid),
      session.subjectId.toHexString(),
      'PX',
      session.expiresAt.getTime() - Date.now(),
    );
    return true;
  }

  async get(sid: string): Promise<SessionDoc | null> {
    if (!Types.ObjectId.isValid(sid)) return null;
    return this.sessions.findById(sid).lean<SessionDoc>().exec();
  }

  async revoke(sid: string, reason: string): Promise<void> {
    await this.sessions
      .updateOne(
        { _id: new Types.ObjectId(sid), revokedAt: { $exists: false } },
        { $set: { revokedAt: new Date(), revokeReason: reason } },
      )
      .exec();
    await this.redis.del(this.cacheKey(sid));
  }

  /** Revokes every session of a subject, optionally keeping the current one. */
  async revokeAll(
    subjectId: string,
    realm: Realm,
    reason: string,
    exceptSid?: string,
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      subjectId: new Types.ObjectId(subjectId),
      realm,
      revokedAt: { $exists: false },
    };
    if (exceptSid) filter._id = { $ne: new Types.ObjectId(exceptSid) };
    const active = await this.sessions.find(filter, { _id: 1 }).lean<SessionDoc[]>().exec();
    if (active.length === 0) return 0;
    await this.sessions
      .updateMany(
        { _id: { $in: active.map((s) => s._id) } },
        { $set: { revokedAt: new Date(), revokeReason: reason } },
      )
      .exec();
    await this.redis.del(...active.map((s) => this.cacheKey(s._id.toHexString())));
    return active.length;
  }

  async listActive(subjectId: string, realm: Realm): Promise<SessionDoc[]> {
    return this.sessions
      .find({
        subjectId: new Types.ObjectId(subjectId),
        realm,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
      .sort({ lastUsedAt: -1 })
      .limit(100)
      .lean<SessionDoc[]>()
      .exec();
  }

  async touch(sid: string): Promise<void> {
    const key = `sess-touch:${sid}`;
    // Write lastUsedAt at most once a minute per session.
    if (await this.redis.set(key, '1', 'EX', 60, 'NX')) {
      await this.sessions
        .updateOne({ _id: new Types.ObjectId(sid) }, { $set: { lastUsedAt: new Date() } })
        .exec();
    }
  }
}
