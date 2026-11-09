import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import {
  PLATFORM_ALERT,
  PLATFORM_SIGNAL,
  type PlatformAlertEvent,
  type PlatformSignalEvent,
} from '../../../common/alerts/platform-alert.js';
import { RequestContext, type Actor } from '../../../common/context/request-context.js';
import { AppError } from '../../../common/errors/app-error.js';
import { audioLengthMs, formatClock } from '../../../common/media/audio-length.js';
import { AppConfig } from '../../../config/app-config.js';
import { CreditsService } from '../../billing/credits.service.js';
import { EntitlementsService } from '../../billing/entitlements.service.js';
import { ProductsService } from '../../commerce/products.service.js';
import { FilesService } from '../../files/files.service.js';
import { MessagingService } from '../../inbox/messaging.service.js';
import { MessageRepository } from '../../inbox/repositories.js';
import { attachmentKind } from '../../inbox/schemas.js';
import type { TranscribeJob } from '../../inbox/voice-note-queue.js';
import { OrgsService } from '../../orgs/orgs.service.js';
import { AiAgentSettingsService } from '../agent-settings.service.js';
import { AiProviderError } from '../provider/ai-provider.js';
import { TRANSCRIBERS, type Transcriber } from '../transcription/transcriber.js';

const ACTOR: Actor = { type: 'system', id: 'voice-notes' };
export const VOICE_NOTE_FEATURE = 'voice_note_transcription';
/** Speech-to-text services take files up to 25 MB. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Longest transcript kept: about 10 minutes of fast speech. */
const MAX_TEXT_CHARS = 8_000;
/** When a recording's length cannot be read, it is assumed to be 24 kbps (voice codecs run 12–32). */
const ASSUMED_BYTES_PER_SECOND = 3_000;
/** Product names sent to the service so it spells them right. */
const VOCABULARY_PRODUCTS = 15;
const VOCABULARY_CHARS = 400;

export const NOT_SET_UP = 'Voice-to-text is not set up on this Sellora server yet.';

type LanguageHint = 'bn' | 'en' | undefined;

export type TranscribeOutcome =
  | { status: 'done'; credits: number; chars: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

/** ISO-639-1 hint for the service from the agent's language setting; auto and Banglish detect. */
export function languageHint(language: string | undefined): LanguageHint {
  return language === 'bn' ? 'bn' : language === 'en' ? 'en' : undefined;
}

/** One line of text, trimmed to what is kept. */
export function cleanTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
}

/**
 * Turns customers' voice notes into text (ADR 0025): checks the business may and wants to,
 * holds the credits, sends the saved recording to the catalogue's speech-to-text model,
 * charges by the recording's length and stores the words on the message. The inbox shows
 * them live and the AI agent answers them like typed text.
 */
@Injectable()
export class VoiceNotesService {
  private readonly logger = new Logger(VoiceNotesService.name);
  private readonly byName: Map<string, Transcriber>;

  constructor(
    private readonly messages: MessageRepository,
    private readonly messaging: MessagingService,
    private readonly files: FilesService,
    private readonly credits: CreditsService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: AiAgentSettingsService,
    private readonly orgs: OrgsService,
    private readonly products: ProductsService,
    private readonly config: AppConfig,
    private readonly events: EventEmitter2,
    @Inject(TRANSCRIBERS) transcribers: Transcriber[],
  ) {
    this.byName = new Map(transcribers.map((t) => [t.name, t]));
  }

  /**
   * For the AI agent settings screen: whether this server can turn voice notes into text,
   * what a minute costs, and the longest recording it will read.
   */
  async status() {
    const [model, perMinute] = await Promise.all([
      this.credits.transcriptionModel(),
      this.credits.quoteAudioMinute(),
    ]);
    const transcriber = model ? this.byName.get(model.provider) : undefined;
    return {
      available: Boolean(model && transcriber?.configured() && perMinute),
      perMinute,
      maxSeconds: this.config.get('VOICE_NOTE_MAX_SECONDS'),
    };
  }

  /** Runs one queued transcription (worker). Retryable failures are thrown back to the queue. */
  transcribe(job: TranscribeJob, opts: { finalAttempt: boolean }): Promise<TranscribeOutcome> {
    return RequestContext.withTenant(job.orgId, () => this.run(job, opts.finalAttempt), ACTOR);
  }

  private async run(job: TranscribeJob, finalAttempt: boolean): Promise<TranscribeOutcome> {
    if (!Types.ObjectId.isValid(job.messageId))
      return { status: 'skipped', reason: 'message_missing' };
    const message = await this.messages.findById(job.messageId);
    const a = message?.attachments[job.index];
    if (!message || !a) return { status: 'skipped', reason: 'message_missing' };
    if (
      attachmentKind(a) !== 'audio' ||
      a.status !== 'ready' ||
      !a.fileId ||
      a.transcript?.status !== 'pending'
    )
      return { status: 'skipped', reason: 'not_waiting' };

    const end = async (status: 'skipped' | 'failed', reason: string) => {
      await this.messaging.finishTranscript(message._id, job.index, { status, error: reason });
      return { status, reason } as const;
    };

    // Whether this business may and wants to.
    const org = await this.orgs.get(job.orgId);
    if (org.status !== 'active')
      return end('skipped', 'Not turned into text: the account is paused.');
    if (!(await this.entitlements.hasModule(job.orgId, 'ai_agent')))
      return end('skipped', 'Voice notes are turned into text on plans with the AI sales agent.');
    const settings = await this.settings.find();
    if (settings?.transcribeVoiceNotes === false)
      return end('skipped', 'Turning voice notes into text is off in the AI agent settings.');

    // Whether this server can.
    const model = await this.credits.transcriptionModel();
    const transcriber = model ? this.byName.get(model.provider) : undefined;
    if (!model || !transcriber?.configured()) {
      this.alertNotSetUp(model ? `${model.provider} has no API key` : 'no model in the catalogue');
      return end('skipped', NOT_SET_UP);
    }

    // The recording.
    let bytes: Buffer | null = null;
    let contentType = a.contentType ?? 'audio/ogg';
    try {
      const file = await this.files.get(a.fileId.toHexString());
      contentType = file.contentType;
      bytes = await this.files.readBytes(file, MAX_UPLOAD_BYTES);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
    if (!bytes) return end('failed', 'The recording is too large or no longer stored.');
    const measured = a.durationMs ?? (await audioLengthMs(bytes, contentType));
    const audioMs = measured ?? Math.ceil((bytes.length / ASSUMED_BYTES_PER_SECOND) * 1000);
    const maxMs = this.config.get('VOICE_NOTE_MAX_SECONDS') * 1000;
    if (audioMs > maxMs)
      return end('skipped', `Longer than ${formatClock(maxMs)}, so it was not turned into text.`);

    // One run at a time; each is metered under its own id.
    const tries = a.transcript.tries ?? 0;
    if (!(await this.messaging.startTranscript(message._id, job.index, tries)))
      return { status: 'skipped', reason: 'not_waiting' };
    const requestId = `vn-${job.messageId}-${job.index}-${tries + 1}`;
    try {
      await this.credits.reserveAudio({
        requestId,
        feature: VOICE_NOTE_FEATURE,
        audioMs,
        reference: { type: 'message', id: job.messageId },
      });
    } catch (err) {
      if (err instanceof AppError && err.status === HttpStatus.PAYMENT_REQUIRED)
        return end('skipped', 'Not turned into text: the AI credit balance is used up.');
      if (
        err instanceof AppError &&
        (err.code === 'voice_notes_not_priced' || err.code === 'credit_rate_missing')
      ) {
        this.alertNotSetUp('the credit price list has no voice note price');
        return end('skipped', NOT_SET_UP);
      }
      throw err;
    }

    const hint = languageHint(settings?.language);
    let result: Awaited<ReturnType<Transcriber['transcribe']>>;
    try {
      result = await transcriber.transcribe({
        model: model.model,
        audio: bytes,
        contentType,
        ...(hint ? { language: hint } : {}),
        prompt: await this.vocabulary(org.name),
      });
    } catch (err) {
      await this.credits.release(requestId);
      this.report(err, model.provider);
      if (err instanceof AiProviderError && err.retryable && !finalAttempt) throw err;
      this.logger.warn({ err, messageId: job.messageId }, 'A voice note could not be transcribed');
      return end('failed', this.failureReason(err));
    }

    const usage = await this.credits.settleAudio({
      requestId,
      provider: model.provider,
      model: model.model,
      // A length the file did not give is taken from the service when it reports one.
      audioMs: measured ?? result.durationMs ?? audioMs,
    });
    const text = cleanTranscript(result.text);
    await this.messaging.finishTranscript(message._id, job.index, {
      status: 'done',
      text,
      ...(result.language ? { language: result.language } : {}),
      credits: usage.credits,
    });
    return { status: 'done', credits: usage.credits, chars: text.length };
  }

  /** The business's name and best-selling products, so the service spells them right. */
  private async vocabulary(businessName: string): Promise<string> {
    const { products } = await this.products.topActive(VOCABULARY_PRODUCTS);
    let out = businessName.trim();
    for (const p of products) {
      const next = out ? `${out}, ${p.name.trim()}` : p.name.trim();
      if (next.length > VOCABULARY_CHARS) break;
      out = next;
    }
    return out;
  }

  private failureReason(err: unknown): string {
    if (err instanceof AiProviderError && (err.kind === 'not_configured' || err.kind === 'auth'))
      return 'Voice-to-text is not available right now. Try again later.';
    if (err instanceof AiProviderError && err.kind === 'bad_request')
      return 'The voice-to-text service could not read this recording.';
    return 'Voice-to-text kept failing. Try again in a few minutes.';
  }

  /** Tells the platform's owners once per alert window; never throws. */
  private alertNotSetUp(why: string): void {
    try {
      const alert: PlatformAlertEvent = {
        topic: 'ai',
        key: 'voice-notes-not-set-up',
        level: 'warning',
        title: 'Voice notes are not being turned into text',
        lines: [`Reason: ${why}.`, 'Customers’ voice notes are kept and playable as audio.'],
        groupForMs: 24 * 3600_000,
      };
      this.events.emit(PLATFORM_ALERT, alert);
    } catch {
      // Alerts never break a voice note.
    }
  }

  private report(err: unknown, provider: string): void {
    if (!(err instanceof AiProviderError)) return;
    try {
      if (err.kind === 'auth' || err.kind === 'not_configured') {
        const alert: PlatformAlertEvent = {
          topic: 'ai',
          key: `stt-provider-${err.kind}-${provider}`,
          level: 'critical',
          title: `The ${provider} speech-to-text service refused Sellora's key`,
          lines: [err.message, 'Voice notes stay audio only until this is fixed.'],
        };
        this.events.emit(PLATFORM_ALERT, alert);
      } else {
        const signal: PlatformSignalEvent = {
          kind: 'ai_error',
          detail: `${provider} speech-to-text: ${err.kind}${err.status ? ` (${err.status})` : ''}`,
        };
        this.events.emit(PLATFORM_SIGNAL, signal);
      }
    } catch {
      // Alerts never break a voice note.
    }
  }
}
