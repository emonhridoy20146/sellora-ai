import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import {
  MEDIA_FETCH_JOB,
  MetaMedia,
  type MediaJob,
  type MediaOutcome,
} from '../modules/meta/meta-media.js';

/** Copies customers' photos from Messenger, Instagram and WhatsApp into storage. */
@Processor(QUEUES.media, { concurrency: 4 })
export class MediaProcessor extends WorkerHost {
  constructor(private readonly media: MetaMedia) {
    super();
  }

  async process(job: Job<MediaJob>): Promise<MediaOutcome | null> {
    if (job.name !== MEDIA_FETCH_JOB) return null;
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.media.fetch(job.data, { finalAttempt });
  }
}
