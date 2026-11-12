import type { Redis } from 'ioredis';
import { RequestContext } from '../../common/context/request-context.js';
import { sha256 } from '../../common/crypto/tokens.js';
import type { RateLimitService } from '../auth/core/rate-limit.service.js';
import { COUPON_TRY_WINDOW_S, normalizeCode } from './coupon-rules.js';

/**
 * Stops shoppers guessing codes: each new code a shopper's address tries in a business uses
 * one of the `coupon-check:ip` points (20 per 10 minutes); asking about the same code again
 * (the checkout prices the cart again when the delivery area changes) costs nothing.
 */
export async function guardCouponTry(
  redis: Redis,
  limits: RateLimitService,
  orgId: string,
  code: string,
): Promise<void> {
  const ip = RequestContext.current()?.ip;
  if (!ip) return;
  const key = `cpn:try:${orgId}:${sha256(ip).slice(0, 24)}`;
  const added = await redis.sadd(key, normalizeCode(code).slice(0, 40));
  await redis.expire(key, COUPON_TRY_WINDOW_S);
  if (added) await limits.consume('coupon-check:ip', ip);
}
