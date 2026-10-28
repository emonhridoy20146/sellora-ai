import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUES } from '../../infra/queue/queue.constants.js';

/** One message to deliver on Messenger, Instagram or WhatsApp. */
export interface OutboxJob {
  orgId: string;
  messageId: string;
  /** Times the job waited for an earlier message in the same conversation. */
  waits?: number;
}

export const OUTBOX_SEND_JOB = 'send';
/** Rate limits and Meta outages are retried with backoff (about 10 minutes in all). */
export const OUTBOX_ATTEMPTS = 6;

/**
 * Queues messages for the worker, which sends them through the Graph API. Sending never
 * happens inside an HTTP request, so a slow or failing Meta never blocks the inbox.
 */
@Injectable()
export class OutboxQueue {
  constructor(@InjectQueue(QUEUES.outbox) private readonly queue: Queue<OutboxJob>) {}

  async enqueue(orgId: string, messageId: string, opts: { retry?: boolean } = {}): Promise<void> {
    await this.queue.add(
      OUTBOX_SEND_JOB,
      { orgId, messageId },
      {
        // BullMQ ids cannot contain ':'. A manual retry needs a fresh id: the first job is kept
        // for a while after it finished.
        jobId: opts.retry ? `send-${messageId}-${Date.now().toString(36)}` : `send-${messageId}`,
        attempts: OUTBOX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600, count: 5_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
  }
}
