import type { AiProviderName } from '../provider/ai-provider.js';

/**
 * Speech-to-text, provider-neutral (ADR 0025). Voice notes are sent to whichever provider
 * the catalogue's speech-to-text model names; each adapter maps this to its own API.
 */
export interface TranscribeRequest {
  /** The catalogue's model name (data, never code). */
  model: string;
  audio: Buffer;
  /** The saved file's real type, e.g. audio/ogg. */
  contentType: string;
  /** ISO-639-1 hint ("bn", "en"); left out to let the service detect it. */
  language?: string;
  /** Words the speaker is likely to use (business and product names), to spell them right. */
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  /** The language the service heard, when it says. */
  language?: string;
  /** The audio length the service measured, when it says. */
  durationMs?: number;
}

export interface Transcriber {
  readonly name: AiProviderName;
  /** True when the provider has credentials and can be called. */
  configured(): boolean;
  /** Throws AiProviderError. */
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
}

/** Injection token for the speech-to-text adapters this deployment has. */
export const TRANSCRIBERS = Symbol('TRANSCRIBERS');
