import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { MetaInbound, type InboundOutcome } from '../modules/meta/meta-inbound.service.js';
import { META_WEBHOOK_JOB, type MetaWebhookJob } from '../modules/meta/meta-webhook.service.js';

/**
 * Handles verified webhook deliveries. One at a time, so a customer's messages are stored
 * in the order Meta sent them.
 */
@Processor(QUEUES.webhooks, { concurrency: 1 })
export class WebhooksProcessor extends WorkerHost {
  constructor(private readonly meta: MetaInbound) {
    super();
  }

  async process(job: Job<MetaWebhookJob>): Promise<InboundOutcome[] | null> {
    if (job.name !== META_WEBHOOK_JOB) return null;
    return this.meta.handleWebhook(job.data.body);
  }
}
