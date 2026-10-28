import { Injectable } from '@nestjs/common';
import type { ModelTier } from '../../billing/credit-schemas.js';
import { CreditsService } from '../../billing/credits.service.js';
import { AiProviders } from '../provider/ai-providers.service.js';
import type {
  AiEffort,
  AiMessage,
  AiToolResult,
  AiToolSpec,
  AiTurnResult,
} from '../provider/ai-provider.js';
import { AgentTools, type HandoverReason, type ToolRunContext } from './agent-tools.js';
import { imageTokens } from './agent-images.js';
import { estimateTokens } from './chat-text.js';

/** Model turns per reply: enough to search, check a product, quote and answer. */
export const MAX_STEPS = 6;
/** Room for brief reasoning, tool input and a chat-sized answer. */
export const MAX_OUTPUT_TOKENS = 2_048;
/** Chat replies need speed more than deep reasoning. */
const EFFORT: AiEffort = 'low';

export interface AgentRunInput {
  /** Credit usage is reported per feature to the merchant. */
  feature: 'ai_agent_reply' | 'ai_agent_preview';
  tier: ModelTier;
  system: string;
  messages: AiMessage[];
  tools: AiToolSpec[];
  toolContext: ToolRunContext;
  /** Unique per run; each model turn is metered as `${runId}-${step}`. */
  runId: string;
  reference: { type: string; id: string };
  endUserId?: string;
}

export interface AgentRunResult {
  /**
   * reply: the model answered. refusal: the provider declined to answer. incomplete: it ran
   * out of turns or output room before answering.
   */
  kind: 'reply' | 'refusal' | 'incomplete';
  text: string;
  credits: number;
  steps: number;
  handover?: { reason: HandoverReason; summary: string };
  orders: { id: string; number: string; preview: boolean }[];
  toolCalls: { name: string; ok: boolean }[];
}

/** Text by its length; photos by their pixel area, never by the size of their bytes. */
export function estimateMessageTokens(messages: AiMessage[]): number {
  let tokens = estimateTokens(
    JSON.stringify(messages, (k, v: unknown) => (k === 'images' ? undefined : v)),
  );
  for (const m of messages)
    if (m.role === 'user') for (const img of m.images ?? []) tokens += imageTokens(img);
  return tokens;
}

/**
 * Runs the agent's tool loop. Each model turn reserves its worst-case credits before the
 * call, so a business can never spend more than its wallet holds, and is settled with
 * the real token count straight after.
 */
@Injectable()
export class AgentRunner {
  constructor(
    private readonly credits: CreditsService,
    private readonly providers: AiProviders,
    private readonly tools: AgentTools,
  ) {}

  /** The catalogue model replies use for a tier (throws when none is enabled). */
  modelFor(tier: ModelTier) {
    return this.credits.modelForTier(tier);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const model = await this.credits.modelForTier(input.tier);
    const provider = this.providers.get(model.provider);
    const messages = [...input.messages];
    const toolsSize = estimateTokens(JSON.stringify(input.tools));
    const systemSize = estimateTokens(input.system);
    const out: AgentRunResult = {
      kind: 'incomplete',
      text: '',
      credits: 0,
      steps: 0,
      orders: [],
      toolCalls: [],
    };
    let lastText = '';

    for (let step = 0; step < MAX_STEPS; step++) {
      const requestId = `${input.runId}-${step}`;
      await this.credits.reserve({
        requestId,
        feature: input.feature,
        tier: input.tier,
        estimatedInputTokens: systemSize + toolsSize + estimateMessageTokens(messages) + 200,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        reference: input.reference,
      });
      let turn: AiTurnResult;
      try {
        turn = await provider.turn({
          model: model.model,
          system: input.system,
          messages,
          tools: input.tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          effort: EFFORT,
          ...(input.endUserId ? { endUserId: input.endUserId } : {}),
        });
      } catch (err) {
        await this.credits.release(requestId);
        throw err;
      }
      // Billed against the catalogue entry that was asked for, whatever alias the provider reports.
      const usage = await this.credits.settle({
        requestId,
        provider: model.provider,
        model: model.model,
        ...turn.usage,
      });
      out.credits = Math.round((out.credits + usage.credits) * 100) / 100;
      out.steps = step + 1;
      if (turn.text) lastText = turn.text;

      if (turn.stopReason === 'refusal') return { ...out, kind: 'refusal', text: '' };
      if (turn.toolCalls.length === 0) {
        const text = turn.text || lastText;
        return { ...out, kind: text ? 'reply' : 'incomplete', text };
      }
      // A tool call cut off by the output limit may carry truncated input: never run it.
      if (turn.stopReason === 'max_tokens') return { ...out, kind: 'incomplete', text: '' };

      const results: AiToolResult[] = [];
      for (const call of turn.toolCalls) {
        const outcome = await this.tools.execute(call, input.toolContext);
        results.push({
          callId: call.id,
          content: JSON.stringify(outcome.result),
          ...(outcome.isError ? { isError: true } : {}),
        });
        out.toolCalls.push({ name: call.name, ok: !outcome.isError });
        if (outcome.handover) out.handover = outcome.handover;
        if (outcome.order) out.orders.push(outcome.order);
      }
      messages.push(turn.replay, { role: 'tool_results', results });
    }
    return { ...out, kind: 'incomplete', text: lastText };
  }
}
