import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { AutomationsService } from '../modules/campaigns/automations.service.js';
import { CampaignsService } from '../modules/campaigns/campaigns.service.js';

export const CAMPAIGNS_SWEEP_JOB = 'sweep';
/** How often the worker starts scheduled campaigns, sends batches and automation texts. */
const SWEEP_EVERY_MS = 30_000;

/** SMS campaigns and automations (ADR 0019): one sweep every 30 seconds. */
@Processor(QUEUES.campaigns, { concurrency: 1 })
export class CampaignsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignsProcessor.name);

  constructor(
    private readonly campaigns: CampaignsService,
    private readonly automations: AutomationsService,
    @InjectQueue(QUEUES.campaigns) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CAMPAIGNS_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: CAMPAIGNS_SWEEP_JOB },
    );
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== CAMPAIGNS_SWEEP_JOB) {
      this.logger.warn({ name: job.name }, 'Unknown campaigns job');
      return null;
    }
    const now = new Date();
    const campaigns = await this.campaigns.sweep(now);
    const planned = await this.automations.planWinBack(now);
    const automations = await this.automations.sendDue(now);
    return { campaigns, planned, automations };
  }
}
