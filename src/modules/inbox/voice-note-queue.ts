import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUES } from '../../infra/queue/queue.constants.js';

/** Turn one voice note into text (ADR 0025). */
export interface TranscribeJob {
  orgId: string;
  messageId: string;
  /** The attachment's position on the message. */
  index: number;
}

export const TRANSCRIBE_JOB = 'transcribe';
/** A speech-to-text outage is retried with backoff (about 35 seconds in all) before giving up. */
export const TRANSCRIBE_ATTEMPTS = 3;

/**
 * Queues voice notes for transcription. The jobs run with the AI replies (the AI queue's
 * worker), so the inbox module needs no AI code to ask for one.
 */
@Injectable()
export class VoiceNoteQueue {
  constructor(@InjectQueue(QUEUES.ai) private readonly queue: Queue<TranscribeJob>) {}

  /** `run` tells runs of the same voice note apart: "auto" first, then one per retry. */
  async enqueue(job: TranscribeJob, run: string): Promise<void> {
    await this.queue.add(TRANSCRIBE_JOB, job, {
      // BullMQ ids cannot contain ':'.
      jobId: `transcribe-${job.messageId}-${job.index}-${run}`,
      attempts: TRANSCRIBE_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600, count: 5_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }
}
