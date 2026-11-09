import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config.js';
import { AI_FETCH, AiProviderError } from '../provider/ai-provider.js';
import type { TranscribeRequest, TranscribeResult, Transcriber } from './transcriber.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 120_000;
/** The file name tells the service the format; it accepts these extensions. */
const UPLOAD_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
};

/** Maps an HTTP status from the service to an error kind; never matches on message text. */
export function errorForStatus(status: number, detail: string): AiProviderError {
  const message = `Speech-to-text answered ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) return new AiProviderError('auth', message, status);
  if (status === 408) return new AiProviderError('timeout', message, status);
  if (status === 429) return new AiProviderError('rate_limited', message, status);
  if (status === 503 || status === 529) return new AiProviderError('overloaded', message, status);
  if (status >= 500) return new AiProviderError('server', message, status);
  return new AiProviderError('bad_request', message, status);
}

function errorDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const error = (body as { error?: unknown }).error;
  const message =
    typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : error;
  return typeof message === 'string' ? message.slice(0, 300) : '';
}

/**
 * OpenAI's speech-to-text API, `POST /audio/transcriptions`, and any service that speaks
 * the same protocol (set AI_OPENAI_BASE_URL, e.g. a Groq or self-hosted Whisper server).
 * Configured by AI_OPENAI_API_KEY; the model comes from the catalogue.
 */
@Injectable()
export class OpenAiTranscriber implements Transcriber {
  readonly name = 'openai' as const;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(config: AppConfig, @Optional() @Inject(AI_FETCH) fetchImpl?: typeof fetch) {
    this.apiKey = config.get('AI_OPENAI_API_KEY') || undefined;
    this.baseUrl = (config.get('AI_OPENAI_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  configured(): boolean {
    return this.apiKey !== undefined;
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.apiKey) throw new AiProviderError('not_configured', 'AI_OPENAI_API_KEY is not set');
    const ext = UPLOAD_EXT[req.contentType] ?? 'ogg';
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(req.audio)], { type: req.contentType }),
      `voice-note.${ext}`,
    );
    form.append('model', req.model);
    form.append('response_format', 'json');
    if (req.language) form.append('language', req.language);
    if (req.prompt) form.append('prompt', req.prompt);

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new AiProviderError('timeout', 'Speech-to-text did not answer in time');
      throw new AiProviderError('network', 'Could not reach the speech-to-text service');
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw errorForStatus(res.status, errorDetail(body));
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string')
      throw new AiProviderError('server', 'Speech-to-text answered without text', res.status);
    const language = (body as { language?: unknown }).language;
    const duration = (body as { duration?: unknown }).duration;
    return {
      text,
      ...(typeof language === 'string' && language ? { language: language.slice(0, 40) } : {}),
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? { durationMs: Math.round(duration * 1000) }
        : {}),
    };
  }
}
