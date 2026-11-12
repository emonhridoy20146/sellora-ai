import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import type { ModelTier } from '../../billing/credit-schemas.js';
import { CreditsService } from '../../billing/credits.service.js';
import { estimateTokens } from '../agent/chat-text.js';
import { AiProviderError } from '../provider/ai-provider.js';
import { AiProviders } from '../provider/ai-providers.service.js';

export interface WriteRequest<T> {
  /** What the usage history calls it ("seo_product"). */
  feature: string;
  tier: ModelTier;
  system: string;
  prompt: string;
  /** JSON Schema of the answer (the subset structured output accepts: no length bounds). */
  schema: Record<string, unknown>;
  /** Checks the answer and returns it typed; lengths and limits are checked here. */
  parse: ZodType<T>;
  maxOutputTokens: number;
  reference?: { type: string; id: string };
}

export interface WriteResult<T> {
  value: T;
  /** Credits the call cost. */
  credits: number;
}

/**
 * One-shot AI writing with an answer in a fixed JSON shape (ADR 0032): SEO fields, keyword
 * ideas, ad copy. Credits are held before the call and charged by the real token count
 * after it, like the sales agent's turns; a failed call gives the hold back.
 */
@Injectable()
export class AiWriterService {
  private readonly logger = new Logger(AiWriterService.name);

  constructor(
    private readonly credits: CreditsService,
    private readonly providers: AiProviders,
  ) {}

  async write<T>(req: WriteRequest<T>): Promise<WriteResult<T>> {
    const model = await this.credits.modelForTier(req.tier);
    if (!this.providers.configured(model.provider))
      throw AppError.conflict(
        'ai_not_configured',
        'AI writing is not set up on this server yet. Contact support.',
      );
    const provider = this.providers.get(model.provider);
    const requestId = `${req.feature}-${randomUUID()}`;
    await this.credits.reserve({
      requestId,
      feature: req.feature,
      tier: req.tier,
      estimatedInputTokens:
        estimateTokens(req.system) +
        estimateTokens(req.prompt) +
        estimateTokens(JSON.stringify(req.schema)) +
        200,
      maxOutputTokens: req.maxOutputTokens,
      ...(req.reference ? { reference: req.reference } : {}),
    });
    let turn;
    try {
      turn = await provider.turn({
        model: model.model,
        system: req.system,
        messages: [{ role: 'user', text: req.prompt }],
        tools: [],
        maxOutputTokens: req.maxOutputTokens,
        effort: 'low',
        outputSchema: req.schema,
      });
    } catch (err) {
      await this.credits.release(requestId);
      if (err instanceof AiProviderError) {
        this.logger.warn({ kind: err.kind, status: err.status }, 'AI writer call failed');
        throw err.retryable
          ? AppError.conflict('ai_busy', 'The AI is busy right now. Try again in a minute.')
          : AppError.conflict('ai_failed', 'The AI could not write this. Try again later.');
      }
      throw err;
    }
    const usage = await this.credits.settle({
      requestId,
      provider: model.provider,
      model: model.model,
      ...turn.usage,
    });
    if (turn.stopReason === 'refusal')
      throw AppError.unprocessable(
        'ai_refused',
        'The AI would not write this. Change the product text and try again.',
      );
    if (turn.stopReason === 'max_tokens')
      throw AppError.unprocessable(
        'ai_too_long',
        'The answer was too long and got cut off. Try again with less text.',
      );
    let json: unknown;
    try {
      json = JSON.parse(turn.text);
    } catch {
      throw AppError.unprocessable('ai_bad_answer', 'The AI answer could not be read. Try again.');
    }
    const parsed = req.parse.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(
        { feature: req.feature, issues: parsed.error.issues.slice(0, 5) },
        'AI writer answer did not fit',
      );
      throw AppError.unprocessable('ai_bad_answer', 'The AI answer did not fit. Try again.');
    }
    return { value: parsed.data, credits: usage.credits };
  }
}
