import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { BACKUP_JOBS, BackupsService } from '../modules/backups/backups.service.js';
import { MerchantBackupsService } from '../modules/backups/merchant-backups.service.js';

/** How often the worker checks whether the nightly backup is due (ADR 0020). */
const SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Backups: the nightly sweep, backups asked for by a super-admin or a business, test restores,
 * restores of one business, "Download your data" ZIPs and Google Drive copies. Two at a time,
 * so a long nightly backup does not hold up a restore; the run, restore, export and Drive
 * locks keep two of the same kind apart.
 */
@Processor(QUEUES.backups, { concurrency: 2, lockDuration: 120_000 })
export class BackupsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupsProcessor.name);

  constructor(
    private readonly backups: BackupsService,
    private readonly merchant: MerchantBackupsService,
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

  async process(
    job: Job<{ runId?: string; restoreId?: string; exportId?: string; orgId?: string }>,
  ): Promise<unknown> {
    switch (job.name) {
      case BACKUP_JOBS.sweep: {
        const result = await this.backups.sweep();
        // The business's own parts never hold up the platform's sweep.
        const expired = await this.merchant.expireExports().catch((err: unknown) => {
          this.logger.error({ err }, 'Removing old downloads failed');
          return 0;
        });
        const copied = await this.merchant.driveSweep().catch((err: unknown) => {
          this.logger.error({ err }, 'Google Drive sweep failed');
          return 0;
        });
        return { result, expired, copied };
      }
      case BACKUP_JOBS.export:
        return this.merchant.runExport(job.data.exportId!);
      case BACKUP_JOBS.driveCopy:
        return this.merchant.runDriveCopy(job.data.orgId!);
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
