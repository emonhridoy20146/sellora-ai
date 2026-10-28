import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import { AiRepliesService, type ReplyOutcome } from '../modules/ai/agent/ai-replies.service.js';
import { AI_REPLY_JOB, type AiReplyJob } from '../modules/ai/agent/reply-queue.js';

/** Runs AI sales agent replies. Each job answers one conversation. */
@Processor(QUEUES.ai, { concurrency: 8 })
export class AiProcessor extends WorkerHost {
  constructor(private readonly replies: AiRepliesService) {
    super();
  }

  async process(job: Job<AiReplyJob>): Promise<ReplyOutcome | null> {
    if (job.name !== AI_REPLY_JOB) return null;
    // attemptsMade counts earlier failed attempts of this job.
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.replies.handleJob(job.data, { finalAttempt });
  }
}
