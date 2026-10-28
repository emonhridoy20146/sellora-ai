import type { TokenUsage } from '../../billing/credit-math.js';
import type { AiModel } from '../../billing/credit-schemas.js';

/**
 * Provider-neutral shapes the AI features work with. Each provider maps them to its own
 * API, so business logic never depends on one vendor's request format.
 */

export type AiProviderName = AiModel['provider'];

export interface AiToolSpec {
  name: string;
  /** When to call the tool, written for the model. */
  description: string;
  /**
   * JSON Schema of the input object. Kept to the subset every provider's strict mode
   * accepts: no numeric or length bounds (those are checked by the tool's own validator).
   */
  inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  /** Parsed JSON input as the model sent it. Not validated: tools validate it themselves. */
  input: unknown;
}

export interface AiToolResult {
  callId: string;
  /** JSON text returned to the model. */
  content: string;
  isError?: boolean;
}

export type AiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  /** A provider's own assistant turn, sent back unchanged so tool calls keep their ids. */
  | { role: 'assistant_raw'; provider: AiProviderName; content: unknown }
  | { role: 'tool_results'; results: AiToolResult[] };

export type AiEffort = 'low' | 'medium' | 'high';

export interface AiTurnRequest {
  /** Provider model id from the AI model catalogue. */
  model: string;
  system: string;
  messages: AiMessage[];
  tools: AiToolSpec[];
  maxOutputTokens: number;
  effort?: AiEffort;
  /** Opaque id of the end user for the provider's abuse monitoring. Never personal data. */
  endUserId?: string;
  signal?: AbortSignal;
}

export type AiStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface AiTurnResult {
  stopReason: AiStopReason;
  /** The turn's text blocks joined. */
  text: string;
  toolCalls: AiToolCall[];
  usage: TokenUsage;
  /** The assistant turn to send back with the tool results. */
  replay: AiMessage;
  /** The model that answered, as the provider reports it. */
  model: string;
}

export interface AiProvider {
  readonly name: AiProviderName;
  /** True when the provider has credentials and can be called. */
  configured(): boolean;
  /** One model turn. Throws AiProviderError. */
  turn(request: AiTurnRequest): Promise<AiTurnResult>;
}

export type AiProviderErrorKind =
  | 'not_configured'
  | 'auth'
  | 'bad_request'
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'server';

const RETRYABLE: ReadonlySet<AiProviderErrorKind> = new Set([
  'rate_limited',
  'overloaded',
  'timeout',
  'network',
  'server',
]);

/** A provider call failed. `retryable` errors may succeed if the job runs again later. */
export class AiProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: AiProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Injection token for the providers the app can call. */
export const AI_PROVIDERS = Symbol('AI_PROVIDERS');

/** Injection token for the fetch providers use, so tests can play the provider's part. */
export const AI_FETCH = Symbol('AI_FETCH');
