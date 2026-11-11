import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { RequestContext } from '../common/context/request-context.js';
import { QUEUES } from '../infra/queue/queue.constants.js';
import {
  AD_SEND_JOB,
  AdEventsService,
  type AdJob,
} from '../modules/ad-tracking/ad-events.service.js';

/** Sends the server copies of shopper events and order purchases to the ad platforms. */
@Processor(QUEUES.adEvents, { concurrency: 8 })
export class AdEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(AdEventsProcessor.name);

  constructor(private readonly events: AdEventsService) {
    super();
  }

  async process(job: Job<AdJob>): Promise<unknown> {
    if (job.name !== AD_SEND_JOB) {
      this.logger.warn({ name: job.name }, 'Unknown ad event job');
      return null;
    }
    // The last attempt logs a failure instead of throwing it back for another try.
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const status = await RequestContext.withTenant(
      job.data.orgId,
      () => this.events.deliver(job.data, final),
      { type: 'system', id: 'ad-tracking' },
    );
    return { status };
  }
}
