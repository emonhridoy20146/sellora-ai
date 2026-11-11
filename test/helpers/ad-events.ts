import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { RequestContext } from '../../src/common/context/request-context.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { AdEventsService, type AdJob } from '../../src/modules/ad-tracking/ad-events.service.js';
import type { TestApp } from './test-app.js';

export const adQueue = (t: TestApp) => t.app.get<Queue<AdJob>>(getQueueToken(QUEUES.adEvents));

/**
 * Plays the worker for ad events: sends every queued job as the processor would (one attempt,
 * or the last one when `final`), and removes it. Returns what each send came to.
 */
export async function drainAdEvents(
  t: TestApp,
  opts: { final?: boolean } = {},
): Promise<{ job: AdJob; result: string }[]> {
  // Order events go out in the background after the order is saved; let them be queued.
  await new Promise((r) => setTimeout(r, 150));
  const events = t.app.get(AdEventsService);
  const out: { job: AdJob; result: string }[] = [];
  for (const job of await adQueue(t).getJobs(['waiting', 'delayed', 'prioritized'])) {
    let result: string;
    try {
      result = await RequestContext.withTenant(
        job.data.orgId,
        () => events.deliver(job.data, opts.final ?? true),
        { type: 'system', id: 'test' },
      );
    } catch (err) {
      result = `threw: ${(err as Error).message}`;
    }
    out.push({ job: job.data, result });
    await job.remove();
  }
  return out;
}
