import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { OrgsService } from '../modules/orgs/orgs.service.js';

/**
 * Periodic housekeeping, scheduled as BullMQ repeatable jobs so exactly one worker in the
 * cluster runs each tick.
 */
@Processor(QUEUES.maintenance, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    @InjectQueue(QUEUES.maintenance) private readonly queue: Queue,
    private readonly orgs: OrgsService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'expire-demos',
      { every: 5 * 60_000 },
      { name: 'expire-demos' },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'expire-demos':
        return this.expireDemos();
      default:
        this.logger.warn({ name: job.name }, 'Unknown maintenance job');
        return null;
    }
  }

  /** Suspends demo businesses whose access window has ended. */
  async expireDemos(): Promise<{ suspended: number }> {
    const expired = await this.orgs.findExpiredDemos();
    for (const org of expired) {
      await this.orgs.setStatus(
        org._id.toHexString(),
        'suspended',
        'Demo period ended',
        'system:maintenance',
      );
    }
    if (expired.length)
      this.logger.log({ count: expired.length }, 'Suspended expired demo businesses');
    return { suspended: expired.length };
  }
}
