import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { AiRepliesService, type ReplyOutcome } from '../modules/ai/agent/ai-replies.service.js';
import { AI_REPLY_JOB, type AiReplyJob } from '../modules/ai/agent/reply-queue.js';
import {
  VoiceNotesService,
  type TranscribeOutcome,
} from '../modules/ai/voice-notes/voice-notes.service.js';
import { TRANSCRIBE_JOB, type TranscribeJob } from '../modules/inbox/voice-note-queue.js';

/**
 * Runs AI sales agent replies (each job answers one conversation) and turns customers'
 * voice notes into text (ADR 0025).
 */
@Processor(QUEUES.ai, { concurrency: 8 })
export class AiProcessor extends WorkerHost {
  constructor(
    private readonly replies: AiRepliesService,
    private readonly voiceNotes: VoiceNotesService,
  ) {
    super();
  }

  async process(
    job: Job<AiReplyJob> | Job<TranscribeJob>,
  ): Promise<ReplyOutcome | TranscribeOutcome | null> {
    // attemptsMade counts earlier failed attempts of this job.
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (job.name === AI_REPLY_JOB)
      return this.replies.handleJob((job as Job<AiReplyJob>).data, { finalAttempt });
    if (job.name === TRANSCRIBE_JOB)
      return this.voiceNotes.transcribe((job as Job<TranscribeJob>).data, { finalAttempt });
    return null;
  }
}
