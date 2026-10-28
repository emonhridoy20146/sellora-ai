import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUES } from '../../../infra/queue/queue.constants.js';
import { REDIS } from '../../../infra/redis/redis.module.js';

export interface AiReplyJob {
  orgId: string;
  conversationId: string;
  /** The customer message that scheduled this job. */
  messageId: string;
  /** Times this job was put back because another reply was still running. */
  busy?: number;
}

export const AI_REPLY_JOB = 'reply';
/** Attempts per job; a provider outage is retried with backoff before the chat goes to a person. */
export const AI_REPLY_ATTEMPTS = 3;
/** How long to wait for a running reply before giving up (40 × 3 s = 2 minutes). */
const MAX_BUSY_REQUEUES = 40;
const BUSY_DELAY_MS = 3_000;
const LOCK_TTL_MS = 3 * 60_000;

const latestKey = (conversationId: string) => `ai:latest:${conversationId}`;
const lockKey = (conversationId: string) => `ai:lock:${conversationId}`;

// Deletes the lock only if this run still holds it.
const UNLOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Debounced AI replies. Every customer message schedules a delayed job and becomes the
 * conversation's latest message; when a job runs, it replies only if its message is still
 * the latest, so a burst of messages gets one answer. A per-conversation lock keeps two
 * replies from running at once.
 */
@Injectable()
export class AiReplyQueue {
  constructor(
    @InjectQueue(QUEUES.ai) private readonly queue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async schedule(job: Omit<AiReplyJob, 'busy'>, delayMs: number): Promise<void> {
    await this.redis.set(latestKey(job.conversationId), job.messageId, 'EX', 6 * 3600);
    await this.queue.add(AI_REPLY_JOB, job, {
      // BullMQ ids cannot contain ':'; one job per customer message.
      jobId: `reply-${job.messageId}`,
      delay: Math.max(0, delayMs),
      attempts: AI_REPLY_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600, count: 2_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  /** Puts the job back for a few seconds while another reply in the conversation runs. */
  async requeueBusy(job: AiReplyJob): Promise<boolean> {
    const busy = (job.busy ?? 0) + 1;
    if (busy > MAX_BUSY_REQUEUES) return false;
    await this.queue.add(
      AI_REPLY_JOB,
      { ...job, busy },
      {
        jobId: `reply-${job.messageId}-b${busy}`,
        delay: BUSY_DELAY_MS,
        attempts: AI_REPLY_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 2_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
    return true;
  }

  async isLatest(conversationId: string, messageId: string): Promise<boolean> {
    const latest = await this.redis.get(latestKey(conversationId));
    // No marker (expired or Redis flushed): let the job run; it checks the thread itself.
    return latest === null || latest === messageId;
  }

  async lock(conversationId: string, token: string): Promise<boolean> {
    return (await this.redis.set(lockKey(conversationId), token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  }

  async unlock(conversationId: string, token: string): Promise<void> {
    await this.redis.eval(UNLOCK, 1, lockKey(conversationId), token);
  }
}
