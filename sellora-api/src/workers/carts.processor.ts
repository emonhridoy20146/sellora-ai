import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { CartsService } from '../modules/carts/carts.service.js';

export const CARTS_SWEEP_JOB = 'sweep';
/** How often the worker looks for cart reminders that are due. */
const SWEEP_EVERY_MS = 60_000;

/** Sends abandoned cart reminders when they are due (ADR 0018). */
@Processor(QUEUES.carts, { concurrency: 1 })
export class CartsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CartsProcessor.name);

  constructor(
    private readonly carts: CartsService,
    @InjectQueue(QUEUES.carts) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CARTS_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: CARTS_SWEEP_JOB },
    );
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== CARTS_SWEEP_JOB) {
      this.logger.warn({ name: job.name }, 'Unknown carts job');
      return null;
    }
    return this.carts.sweep();
  }
}
