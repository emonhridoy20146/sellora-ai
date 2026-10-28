import type { Redis } from 'ioredis';
import { AppError } from '../../common/errors/app-error.js';

/** How long an answer is kept for retries with the same Idempotency-Key. */
const RESULT_TTL_S = 86_400;
/** How long a run may take before a retry with the same key may start it again. */
const LOCK_TTL_S = 60;

export interface IdempotentRun<T> {
  redis: Redis;
  /** Keys live under `<scope>:<key>`; the scope names the store or page. */
  scope: string;
  key: string;
  /** A hash of the request; the same key with a different request is refused. */
  fingerprint: string;
  /** Checks that apply to first attempts only (rate limits, bot traps). */
  before?: () => Promise<void>;
  run: () => Promise<T>;
}

/**
 * Runs `run` once per Idempotency-Key: the first answer is kept for a day and returned to
 * retries; a retry while the first attempt is still running is told to wait; the same key
 * with a different request is refused. Used by store checkout and landing page orders.
 */
export async function runIdempotent<T>(o: IdempotentRun<T>): Promise<T> {
  const result = `${o.scope}:${o.key}`;
  const lock = `${result}:lock`;
  const saved = await o.redis.get(result);
  if (saved) return replay<T>(saved, o.fingerprint);
  await o.before?.();
  const locked = await o.redis.set(lock, o.fingerprint, 'EX', LOCK_TTL_S, 'NX');
  if (locked !== 'OK') {
    const again = await o.redis.get(result);
    if (again) return replay<T>(again, o.fingerprint);
    throw AppError.conflict(
      'checkout_in_progress',
      'This order is still being placed. Wait a moment.',
    );
  }
  try {
    const answer = await o.run();
    await o.redis.set(
      result,
      JSON.stringify({ fingerprint: o.fingerprint, result: answer }),
      'EX',
      RESULT_TTL_S,
    );
    return answer;
  } finally {
    await o.redis.del(lock);
  }
}

function replay<T>(saved: string, fingerprint: string): T {
  const parsed = JSON.parse(saved) as { fingerprint: string; result: T };
  if (parsed.fingerprint !== fingerprint)
    throw AppError.unprocessable(
      'idempotency_key_reused',
      'This Idempotency-Key was used for a different order.',
    );
  return parsed.result;
}
