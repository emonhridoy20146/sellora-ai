import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { OUTBOX_SEND_JOB, type OutboxJob } from '../modules/inbox/outbox.js';
import { MetaSender, type SendOutcome } from '../modules/meta/meta-sender.service.js';

const ORDER_WAIT_MS = 2_000;

/** Delivers messages on Messenger, Instagram and WhatsApp. */
@Processor(QUEUES.outbox, { concurrency: 8 })
export class OutboxProcessor extends WorkerHost {
  constructor(private readonly sender: MetaSender) {
    super();
  }

  async process(job: Job<OutboxJob>, token?: string): Promise<SendOutcome | null> {
    if (job.name !== OUTBOX_SEND_JOB) return null;
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const outcome = await this.sender.send(job.data, { finalAttempt });
    if (outcome.status === 'wait' && token) {
      // An earlier message of the conversation goes first; this one waits without using an attempt.
      await job.updateData({ ...job.data, waits: (job.data.waits ?? 0) + 1 });
      await job.moveToDelayed(Date.now() + ORDER_WAIT_MS, token);
      throw new DelayedError();
    }
    return outcome;
  }
}
