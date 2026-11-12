import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import {
  SEO_JOBS,
  SearchConsoleService,
  type SeoJob,
} from '../modules/seo/search-console.service.js';
import { SeoAuditService } from '../modules/seo/seo-audit.service.js';

/** How often the worker looks for Search Console data due a daily sync. */
const SWEEP_EVERY_MS = 60 * 60_000;

/**
 * The SEO studio's background work (ADR 0032): Search Console setup (verify, add the site,
 * submit the sitemap), daily search data, and bulk AI suggestions, one product at a time.
 */
@Processor(QUEUES.seo, { concurrency: 2 })
export class SeoProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeoProcessor.name);

  constructor(
    private readonly console: SearchConsoleService,
    private readonly audit: SeoAuditService,
    @InjectQueue(QUEUES.seo) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SEO_JOBS.sweep,
      { every: SWEEP_EVERY_MS },
      { name: SEO_JOBS.sweep, opts: { attempts: 1 } },
    );
  }

  async process(job: Job<SeoJob>): Promise<unknown> {
    switch (job.name) {
      case SEO_JOBS.setup:
        return this.console.setup(job.data.orgId);
      case SEO_JOBS.sync:
        return this.console.sync(job.data.orgId);
      case SEO_JOBS.sweep:
        return this.console.sweep();
      case SEO_JOBS.bulk:
        return this.audit.processBulk(job.data.orgId, job.data.runId!);
      default:
        this.logger.warn({ name: job.name }, 'Unknown SEO job');
        return null;
    }
  }
}
