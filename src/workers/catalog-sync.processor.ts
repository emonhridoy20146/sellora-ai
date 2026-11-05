import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { CatalogSyncRunner } from '../modules/catalog-sync/catalog-sync.runner.js';
import {
  CATALOG_SYNC_JOBS,
  type CatalogSyncJob,
} from '../modules/catalog-sync/catalog-sync.service.js';

/** How often the worker looks for sources due a sync (ADR 0023). */
const SWEEP_EVERY_MS = 60_000;

/**
 * Catalog syncs: the minute sweep queues due sources, and each run reads one source. Two at
 * a time per worker, so one large catalog does not hold up every other business.
 */
@Processor(QUEUES.catalogSync, { concurrency: 2 })
export class CatalogSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogSyncProcessor.name);

  constructor(
    private readonly runner: CatalogSyncRunner,
    @InjectQueue(QUEUES.catalogSync) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CATALOG_SYNC_JOBS.sweep,
      { every: SWEEP_EVERY_MS },
      { name: CATALOG_SYNC_JOBS.sweep, opts: { attempts: 1 } },
    );
  }

  async process(job: Job<CatalogSyncJob>): Promise<unknown> {
    switch (job.name) {
      case CATALOG_SYNC_JOBS.run:
        return this.runner.run(job.data.orgId, job.data.runId);
      case CATALOG_SYNC_JOBS.sweep:
        return this.runner.sweep();
      default:
        this.logger.warn({ name: job.name }, 'Unknown catalog sync job');
        return null;
    }
  }
}
