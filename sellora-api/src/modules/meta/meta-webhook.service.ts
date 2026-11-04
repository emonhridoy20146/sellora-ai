import { createHmac, timingSafeEqual } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { parseMetaWebhook } from './meta-events.js';

export const META_WEBHOOK_JOB = 'meta';

export interface MetaWebhookJob {
  /** The verified webhook body, parsed again by the worker. */
  body: unknown;
}

const notConfigured = () =>
  new AppError(
    'meta_not_configured',
    503,
    'Messenger, Instagram and WhatsApp are not set up on this platform.',
  );

/**
 * Meta's webhook endpoint logic: the subscription handshake, signature checks, and handing
 * verified deliveries to the worker so Meta gets its 200 at once.
 */
@Injectable()
export class MetaWebhookService {
  constructor(
    private readonly config: AppConfig,
    @InjectQueue(QUEUES.webhooks) private readonly queue: Queue<MetaWebhookJob>,
  ) {}

  /** Answers Meta's GET handshake with the challenge when the verify token matches. */
  verify(mode: unknown, token: unknown, challenge: unknown): string {
    const expected = this.config.get('META_WEBHOOK_VERIFY_TOKEN');
    if (!expected) throw notConfigured();
    if (
      mode !== 'subscribe' ||
      typeof token !== 'string' ||
      typeof challenge !== 'string' ||
      !safeEqual(token, expected)
    )
      throw AppError.forbidden('webhook_verification_failed', 'The verify token does not match.');
    return challenge;
  }

  /**
   * Checks X-Hub-Signature-256 (HMAC-SHA256 of the exact bytes received, keyed with the app
   * secret) and queues the delivery. Deliveries with nothing this app handles are accepted
   * and dropped, so Meta does not retry them.
   */
  async receive(
    raw: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ events: number }> {
    const secret = this.config.get('META_APP_SECRET');
    if (!secret) throw notConfigured();
    if (!raw?.length) throw AppError.badRequest('empty_body', 'The webhook body is empty.');
    const match = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? '');
    const expected = createHmac('sha256', secret).update(raw).digest();
    if (!match || !timingSafeEqual(Buffer.from(match[1]!, 'hex'), expected))
      throw AppError.unauthorized('invalid_signature', 'The webhook signature is not valid.');

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw AppError.badRequest('invalid_json', 'The webhook body is not JSON.');
    }
    const events = parseMetaWebhook(body).length;
    if (events > 0)
      await this.queue.add(
        META_WEBHOOK_JOB,
        { body },
        {
          attempts: 8,
          backoff: { type: 'exponential', delay: 3_000 },
          // Customer messages are stored in the database; the queue keeps no copy once done.
          removeOnComplete: true,
          removeOnFail: { age: 3 * 24 * 3600 },
        },
      );
    return { events };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
