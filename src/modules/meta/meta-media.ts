import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { RequestContext, type Actor } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { FilesService } from '../files/files.service.js';
import { ChannelsService, type ChannelDoc } from '../inbox/channels.service.js';
import { MessagingService } from '../inbox/messaging.service.js';
import { MessageRepository } from '../inbox/repositories.js';
import { MetaGraph, MetaGraphError, MetaMediaError } from './meta-graph.js';

/** Save the customer's photos on one message. */
export interface MediaJob {
  orgId: string;
  messageId: string;
}

export const MEDIA_FETCH_JOB = 'fetch';
/** Meta outages are retried with backoff (about 2.5 minutes in all) before giving up. */
export const MEDIA_ATTEMPTS = 5;
/** WhatsApp attachments are stored as `wa:<media id>` until they are fetched. */
export const WHATSAPP_MEDIA_PREFIX = 'wa:';

const ACTOR: Actor = { type: 'system', id: 'meta-media' };
const MB = 1024 * 1024;

@Injectable()
export class MetaMediaQueue {
  constructor(@InjectQueue(QUEUES.media) private readonly queue: Queue<MediaJob>) {}

  async enqueue(orgId: string, messageId: string): Promise<void> {
    await this.queue.add(
      MEDIA_FETCH_JOB,
      { orgId, messageId },
      {
        // BullMQ ids cannot contain ':'; one job per message.
        jobId: `media-${messageId}`,
        attempts: MEDIA_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 5_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
  }
}

export type MediaOutcome =
  | { status: 'done'; saved: number; failed: number }
  | { status: 'skipped'; reason: 'message_missing' | 'nothing_pending' };

interface WhatsAppMediaInfo {
  url?: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number;
}

/**
 * Copies customers' photos from Meta into the business's own storage. Meta's CDN links
 * expire and WhatsApp media needs the channel's token, so the inbox and the AI agent only
 * ever use the saved copy. Each attachment ends `ready` or `failed` with a reason staff can
 * understand; retrying stops as soon as it cannot help.
 */
@Injectable()
export class MetaMedia {
  private readonly logger = new Logger(MetaMedia.name);

  constructor(
    private readonly graph: MetaGraph,
    private readonly channels: ChannelsService,
    private readonly messaging: MessagingService,
    private readonly messages: MessageRepository,
    private readonly files: FilesService,
    private readonly config: AppConfig,
  ) {}

  private maxBytes(): number {
    return this.config.get('CHAT_MEDIA_MAX_MB') * MB;
  }

  fetch(job: MediaJob, opts: { finalAttempt: boolean }): Promise<MediaOutcome> {
    return RequestContext.withTenant(job.orgId, () => this.fetchMessage(job, opts), ACTOR);
  }

  private async fetchMessage(
    job: MediaJob,
    opts: { finalAttempt: boolean },
  ): Promise<MediaOutcome> {
    if (!Types.ObjectId.isValid(job.messageId))
      return { status: 'skipped', reason: 'message_missing' };
    const message = await this.messages.findById(job.messageId);
    if (!message) return { status: 'skipped', reason: 'message_missing' };
    const pending = message.attachments
      .map((a, index) => ({ a, index }))
      .filter(({ a }) => a.status === 'pending' && a.source);
    if (!pending.length) return { status: 'skipped', reason: 'nothing_pending' };
    const channel = await this.channels.find(message.channelId.toHexString());

    let saved = 0;
    let failed = 0;
    let retry: Error | null = null;
    for (const { a, index } of pending) {
      try {
        const bytes = await this.download(channel, a.source!);
        const file = await this.files.saveBytes({
          purpose: 'chat_media',
          bytes,
          filename: `photo-${message._id.toHexString()}-${index + 1}`,
          usedBy: { type: 'message', id: message._id.toHexString() },
        });
        await this.messaging.settleAttachment(message._id, index, {
          status: 'ready',
          fileId: file._id,
          contentType: file.contentType,
          size: file.size,
        });
        saved += 1;
      } catch (err) {
        const reason = this.permanentReason(err);
        if (reason === null && !opts.finalAttempt) {
          retry = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        this.logger.warn(
          { err, messageId: job.messageId, index },
          'A customer photo could not be saved',
        );
        await this.messaging.settleAttachment(message._id, index, {
          status: 'failed',
          error: reason ?? 'Not saved: the download from Meta kept failing.',
        });
        failed += 1;
      }
    }
    // Saved photos stay saved; the queue retries the rest.
    if (retry) throw retry;
    return { status: 'done', saved, failed };
  }

  private async download(channel: ChannelDoc | null, source: string): Promise<Buffer> {
    const maxBytes = this.maxBytes();
    if (!source.startsWith(WHATSAPP_MEDIA_PREFIX))
      return (await this.graph.download(source, { maxBytes })).bytes;

    // WhatsApp: ask for a short-lived download link, then fetch it with the same token.
    if (!channel?.meta) throw new MetaMediaError('unavailable', 'The WhatsApp channel was removed');
    const token = this.channels.metaToken(channel);
    const info = await this.graph.get<WhatsAppMediaInfo>(
      source.slice(WHATSAPP_MEDIA_PREFIX.length),
      token,
    );
    if (!info.url) throw new MetaMediaError('unavailable', 'WhatsApp returned no download link');
    if (typeof info.file_size === 'number' && info.file_size > maxBytes)
      throw new MetaMediaError('too_large', 'The file is too large');
    const { bytes } = await this.graph.download(info.url, { token, maxBytes });
    if (info.sha256 && createHash('sha256').update(bytes).digest('hex') !== info.sha256)
      throw new MetaGraphError('transient', 'The downloaded file does not match its checksum');
    return bytes;
  }

  /** What to tell staff when trying again cannot help, or null when it might. */
  private permanentReason(err: unknown): string | null {
    const mb = this.config.get('CHAT_MEDIA_MAX_MB');
    if (err instanceof MetaMediaError)
      switch (err.reason) {
        case 'too_large':
          return `Not saved: larger than ${mb} MB.`;
        case 'unavailable':
          return 'Not saved: Meta no longer has this photo.';
        case 'host_not_allowed':
          return 'Not saved: the link did not come from Meta.';
      }
    if (err instanceof MetaGraphError) {
      if (err.kind === 'auth') return 'Not saved: Meta refused access. Reconnect the channel.';
      // Unknown or expired media ids answer with a parameter error.
      if (err.kind === 'bad_request' || err.kind === 'not_configured')
        return 'Not saved: Meta no longer has this photo.';
      return null;
    }
    if (err instanceof AppError) {
      if (err.code === 'plan_limit_reached') return 'Not saved: the plan’s storage is full.';
      if (err.code === 'file_too_large') return `Not saved: larger than ${mb} MB.`;
      if (err.code === 'unsupported_file_type')
        return 'Not saved: not a photo type Sellora can show.';
    }
    return null;
  }
}
