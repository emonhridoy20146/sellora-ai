import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../infra/queue/queue.constants.js';
import type { TelegramUpdate } from '../infra/telegram/telegram.client.js';
import { AlertsService } from '../modules/telegram/alerts.service.js';
import { TelegramWatchService } from '../modules/telegram/telegram-watch.service.js';
import { TELEGRAM_JOBS, TelegramService } from '../modules/telegram/telegram.service.js';

/** How often the worker checks for due reports and alert conditions (ADR 0022). */
const SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Owner reports and alerts on Telegram: sends messages (Telegram's own waits are kept by the
 * service), reads updates from the webhook, and runs the 5-minute sweep. Under Telegram's
 * limit of about 30 messages a second.
 */
@Processor(QUEUES.telegram, { concurrency: 4, limiter: { max: 25, duration: 1000 } })
export class TelegramProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramProcessor.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly alerts: AlertsService,
    private readonly watch: TelegramWatchService,
    @InjectQueue(QUEUES.telegram) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      TELEGRAM_JOBS.sweep,
      { every: SWEEP_EVERY_MS },
      { name: TELEGRAM_JOBS.sweep, opts: { attempts: 1 } },
    );
  }

  async process(job: Job<{ messageId?: string; update?: TelegramUpdate }>): Promise<unknown> {
    switch (job.name) {
      case TELEGRAM_JOBS.deliver: {
        const result = await this.telegram.deliver(job.data.messageId!);
        if (result.failed) await this.alerts.deliveryFailed(result.failed);
        return { status: result.status, retryInMs: result.retryInMs ?? null };
      }
      case TELEGRAM_JOBS.update:
        return this.watch.handleUpdate(job.data.update!);
      case TELEGRAM_JOBS.sweep:
        return this.watch.sweep();
      default:
        this.logger.warn({ name: job.name }, 'Unknown telegram job');
        return null;
    }
  }
}
