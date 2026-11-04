import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { BACKUP_JOBS, BackupsService } from '../modules/backups/backups.service.js';

/** How often the worker checks whether the nightly backup is due (ADR 0020). */
const SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Backups: the nightly sweep, backups asked for by a super-admin, test restores and restores
 * of one business. Two at a time, so a long nightly backup does not hold up a restore; the
 * run and restore locks keep two of the same kind apart.
 */
@Processor(QUEUES.backups, { concurrency: 2, lockDuration: 120_000 })
export class BackupsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupsProcessor.name);

  constructor(
    private readonly backups: BackupsService,
    @InjectQueue(QUEUES.backups) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      BACKUP_JOBS.sweep,
      { every: SWEEP_EVERY_MS },
      { name: BACKUP_JOBS.sweep, opts: { attempts: 1 } },
    );
  }

  async process(job: Job<{ runId?: string; restoreId?: string }>): Promise<unknown> {
    switch (job.name) {
      case BACKUP_JOBS.sweep:
        return this.backups.sweep();
      case BACKUP_JOBS.write:
        return this.backups.runQueued(job.data.runId!);
      case BACKUP_JOBS.testRestore:
        return this.backups.testRestore(job.data.runId!);
      case BACKUP_JOBS.restore:
        return this.backups.runRestore(job.data.restoreId!);
      default:
        this.logger.warn({ name: job.name }, 'Unknown backups job');
        return null;
    }
  }
}
