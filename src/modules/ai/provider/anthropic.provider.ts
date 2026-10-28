import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config.js';
import {
  AI_FETCH,
  AiProviderError,
  type AiMessage,
  type AiProvider,
  type AiStopReason,
  type AiToolCall,
  type AiTurnRequest,
  type AiTurnResult,
} from './ai-provider.js';

const REQUEST_TIMEOUT_MS = 60_000;

/** Maps the neutral conversation to Messages API turns. */
export function toAnthropicMessages(messages: AiMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.text };
      case 'assistant':
        return { role: 'assistant', content: m.text };
      case 'assistant_raw':
        if (m.provider !== 'anthropic')
          throw new Error(`Cannot replay a ${m.provider} turn to Anthropic`);
        // The response's own content blocks, unchanged (tool_use ids, thinking blocks).
        return { role: 'assistant', content: m.content as Anthropic.ContentBlockParam[] };
      case 'tool_results':
        // Every result of a turn goes back in one user message.
        return {
          role: 'user',
          content: m.results.map((r): Anthropic.ToolResultBlockParam => ({
            type: 'tool_result',
            tool_use_id: r.callId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
    }
  });
}

function stopReason(reason: Anthropic.StopReason | null): AiStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
    case null:
      return 'other';
  }
}

/** Translates the SDK's typed errors; never matches on message text. */
export function toProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AiProviderError('timeout', 'The AI provider did not answer in time');
  if (err instanceof Anthropic.APIConnectionError)
    return new AiProviderError('network', 'Could not reach the AI provider');
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  )
    return new AiProviderError('auth', 'The AI provider rejected the API key', err.status);
  if (err instanceof Anthropic.RateLimitError)
    return new AiProviderError('rate_limited', 'The AI provider is rate limiting us', err.status);
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.UnprocessableEntityError
  )
    return new AiProviderError('bad_request', err.message, err.status);
  if (err instanceof Anthropic.APIError) {
    const raw = (err as { status?: unknown }).status;
    const status = typeof raw === 'number' ? raw : undefined;
    // 529: overloaded; other 5xx: provider-side failure.
    if (status === 529) return new AiProviderError('overloaded', 'The AI provider is busy', status);
    if (status !== undefined && status >= 500)
      return new AiProviderError('server', 'The AI provider had an error', status);
    return new AiProviderError('bad_request', (err as Error).message, status);
  }
  return new AiProviderError('server', err instanceof Error ? err.message : String(err));
}

/**
 * Claude through the official Anthropic SDK. The model id always comes from the AI model
 * catalogue; this class only knows how to talk to the API.
 */
@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  private readonly client?: Anthropic;

  constructor(config: AppConfig, @Optional() @Inject(AI_FETCH) fetchImpl?: typeof fetch) {
    const apiKey = config.get('AI_ANTHROPIC_API_KEY');
    if (apiKey) {
      const baseURL = config.get('AI_ANTHROPIC_BASE_URL');
      this.client = new Anthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        // The SDK retries connection errors, 408, 409, 429 and 5xx with backoff.
        maxRetries: 2,
        timeout: REQUEST_TIMEOUT_MS,
      });
    }
  }

  configured(): boolean {
    return this.client !== undefined;
  }

  async turn(req: AiTurnRequest): Promise<AiTurnResult> {
    if (!this.client)
      throw new AiProviderError('not_configured', 'AI_ANTHROPIC_API_KEY is not set');
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          ...(req.tools.length
            ? {
                tools: req.tools.map((t): Anthropic.Tool => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  strict: true,
                })),
              }
            : {}),
          // Caches the stable prefix (tools, instructions, earlier turns) between turns.
          cache_control: { type: 'ephemeral' },
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
          ...(req.endUserId ? { metadata: { user_id: req.endUserId } } : {}),
        },
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      throw toProviderError(err);
    }

    const toolCalls: AiToolCall[] = [];
    const text: string[] = [];
    for (const block of res.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'tool_use')
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return {
      stopReason: stopReason(res.stop_reason),
      text: text.join('\n').trim(),
      toolCalls,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cachedInputTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteInputTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      replay: { role: 'assistant_raw', provider: 'anthropic', content: res.content },
      model: res.model,
    };
  }
}
