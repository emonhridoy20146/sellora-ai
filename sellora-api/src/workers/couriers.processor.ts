import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { RequestContext } from '../common/context/request-context.js';
import { QUEUES } from '../infra/queue/queue.constants.js';
import {
  COURIER_CHECK_JOB,
  COURIER_DUE_JOB,
  COURIER_SEND_JOB,
  ParcelsService,
  type CourierJob,
} from '../modules/couriers/parcels.service.js';

/** How often the worker looks for parcels whose status should be checked again. */
const DUE_EVERY_MS = 5 * 60_000;

/** Bulk courier bookings and parcel status checks (from webhooks and the schedule). */
@Processor(QUEUES.couriers, { concurrency: 4 })
export class CouriersProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CouriersProcessor.name);

  constructor(
    private readonly parcels: ParcelsService,
    @InjectQueue(QUEUES.couriers) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      COURIER_DUE_JOB,
      { every: DUE_EVERY_MS },
      { name: COURIER_DUE_JOB },
    );
  }

  async process(job: Job<CourierJob>): Promise<unknown> {
    if (job.name === COURIER_DUE_JOB) return { queued: await this.parcels.queueDueChecks() };
    const { orgId, parcelId, source } = job.data;
    const run = <T>(fn: () => Promise<T>) =>
      RequestContext.withTenant(orgId, fn, { type: 'system', id: 'couriers' });
    switch (job.name) {
      case COURIER_SEND_JOB: {
        const p = await run(() => this.parcels.send(parcelId));
        return { status: p.status };
      }
      case COURIER_CHECK_JOB: {
        const p = await run(() => this.parcels.check(parcelId, source ?? 'poll'));
        return { status: p.status };
      }
      default:
        this.logger.warn({ name: job.name }, 'Unknown couriers job');
        return null;
    }
  }
}
