import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { BillingJobsService } from '../modules/billing/billing-jobs.service.js';
import { FilesService } from '../modules/files/files.service.js';
import { OrgsService } from '../modules/orgs/orgs.service.js';
import { StoreDomainsService } from '../modules/stores/store-domains.service.js';

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
    private readonly billing: BillingJobsService,
    private readonly files: FilesService,
    private readonly domains: StoreDomainsService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const schedules: [string, number][] = [
      ['expire-demos', 5 * 60_000],
      ['billing-renewals', 10 * 60_000],
      ['credit-grants', 10 * 60_000],
      ['release-ai-reservations', 15 * 60_000],
      ['storage-sweep', 15 * 60_000],
      ['store-domains', 5 * 60_000],
    ];
    for (const [name, every] of schedules) {
      await this.queue.upsertJobScheduler(name, { every }, { name });
    }
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'expire-demos':
        return this.expireDemos();
      case 'billing-renewals':
        return this.billing.runRenewals();
      case 'credit-grants':
        return this.billing.runCreditGrants();
      case 'release-ai-reservations':
        return this.billing.releaseStaleReservations();
      case 'storage-sweep':
        return this.files.sweep();
      case 'store-domains':
        return this.domains.runDueChecks();
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
