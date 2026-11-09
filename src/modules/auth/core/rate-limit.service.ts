import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { AppConfig } from '../../../config/app-config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { REDIS } from '../../../infra/redis/redis.module.js';

interface LimitSpec {
  points: number;
  durationSec: number;
  blockSec?: number;
}

/**
 * Named Redis-backed limiters for abuse-prone endpoints. Limits are per key (IP, email,
 * user) so one attacker cannot lock out everyone, and one victim's account is protected
 * from distributed guessing.
 */
@Injectable()
export class RateLimitService {
  private readonly limiters = new Map<string, RateLimiterRedis>();
  private readonly specs: Record<string, LimitSpec>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: AppConfig,
  ) {
    const auth = config.get('RATE_LIMIT_AUTH_PER_15MIN');
    this.specs = {
      'login:ip': { points: auth * 5, durationSec: 900, blockSec: 900 },
      'login-fail:account': { points: 10, durationSec: 3600, blockSec: 1800 },
      'login-fail:ip': { points: 50, durationSec: 3600, blockSec: 3600 },
      'mfa-fail:subject': { points: 5, durationSec: 900, blockSec: 900 },
      'signup:ip': { points: 10, durationSec: 3600 },
      'forgot:account': { points: 3, durationSec: 3600 },
      'forgot:ip': { points: 20, durationSec: 3600 },
      'verify-resend:account': { points: 3, durationSec: 3600 },
      'invite:org': { points: 50, durationSec: 86400 },
      'refresh:ip': { points: 300, durationSec: 900 },
      'global:ip': { points: config.get('RATE_LIMIT_GLOBAL_PER_MINUTE'), durationSec: 60 },
      'webchat:visitor': { points: 30, durationSec: 60 },
      'webchat:ip': { points: 120, durationSec: 60 },
      'ai:preview': { points: 20, durationSec: 60 },
      // Online store shoppers (keyed on the shopper's address the storefront passes on).
      'checkout:ip': { points: 10, durationSec: 600 },
      'checkout:phone': { points: 5, durationSec: 3600 },
      'track:ip': { points: 30, durationSec: 600 },
      // "Check now" on a custom domain (each check asks DNS servers four questions).
      'domain-check:domain': { points: 6, durationSec: 60 },
      // Landing page visit counts (one beacon per page view at most).
      'landing-visit:ip': { points: 60, durationSec: 60 },
      // Store visit and step counts (ADR 0027): a visit, product views, the cart, the checkout.
      'store-event:ip': { points: 120, durationSec: 60 },
      // Test SMS from Settings › SMS (each one costs money) and the public opt-out page.
      'sms-test:org': { points: 10, durationSec: 3600 },
      'sms-optout:ip': { points: 30, durationSec: 600 },
      // Abandoned carts (ADR 0018): the storefront saves a cart as the shopper types, and the
      // reminder link restores it.
      'cart-capture:ip': { points: 60, durationSec: 600 },
      'cart-restore:ip': { points: 30, durationSec: 600 },
    };
    const multiplier = config.get('RATE_LIMIT_IP_MULTIPLIER');
    for (const [name, spec] of Object.entries(this.specs)) {
      if (name.endsWith(':ip')) spec.points *= multiplier;
    }
  }

  private limiter(name: string): RateLimiterRedis {
    let limiter = this.limiters.get(name);
    if (!limiter) {
      const spec = this.specs[name];
      if (!spec) throw new Error(`Unknown rate limiter ${name}`);
      limiter = new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: `rl:${name}`,
        points: spec.points,
        duration: spec.durationSec,
        blockDuration: spec.blockSec ?? 0,
        useRedisPackage: false,
      });
      this.limiters.set(name, limiter);
    }
    return limiter;
  }

  /** Consumes points; throws 429 with Retry-After when the key is over its limit. */
  async consume(name: string, key: string, points = 1): Promise<void> {
    try {
      await this.limiter(name).consume(key.toLowerCase(), points);
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        throw AppError.tooManyRequests(
          'Too many attempts. Please wait and try again.',
          Math.ceil(err.msBeforeNext / 1000),
        );
      }
      throw err;
    }
  }

  /** Throws if the key is currently blocked, without consuming a point. */
  async assertNotBlocked(name: string, key: string): Promise<void> {
    const res = await this.limiter(name).get(key.toLowerCase());
    const spec = this.specs[name]!;
    if (res && res.consumedPoints > spec.points) {
      throw AppError.tooManyRequests(
        'Too many attempts. Please wait and try again.',
        Math.ceil(res.msBeforeNext / 1000),
      );
    }
  }

  async reset(name: string, key: string): Promise<void> {
    await this.limiter(name).delete(key.toLowerCase());
  }
}
