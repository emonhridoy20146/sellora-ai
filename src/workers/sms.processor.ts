import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { RequestContext } from '../common/context/request-context.js';
import { QUEUES } from '../infra/queue/queue.constants.js';
import {
  SMS_SEND_JOB,
  SMS_SWEEP_JOB,
  SmsService,
  type SmsJob,
} from '../modules/sms/sms.service.js';

/** How often the worker looks for messages a crash left half sent. */
const SWEEP_EVERY_MS = 5 * 60_000;

/** Sends queued SMS, one job per message, and settles messages a crash interrupted. */
@Processor(QUEUES.sms, { concurrency: 8 })
export class SmsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(
    private readonly sms: SmsService,
    @InjectQueue(QUEUES.sms) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SMS_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: SMS_SWEEP_JOB },
    );
  }

  async process(job: Job<SmsJob>): Promise<unknown> {
    if (job.name === SMS_SWEEP_JOB) return { swept: await this.sms.sweepStuck() };
    if (job.name !== SMS_SEND_JOB) {
      this.logger.warn({ name: job.name }, 'Unknown SMS job');
      return null;
    }
    const { orgId, messageId } = job.data;
    // The last attempt fails the message instead of leaving it queued for ever.
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const m = await RequestContext.withTenant(orgId, () => this.sms.send(messageId, { final }), {
      type: 'system',
      id: 'sms',
    });
    return { status: m?.status ?? 'skipped' };
  }
}
