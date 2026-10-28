import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { AI_AGENT_DEFAULTS, type AiAgentSettings } from './agent-settings.schema.js';

export type AiAgentSettingsDoc = WithId<AiAgentSettings>;

@Injectable()
export class AiAgentSettingsRepository extends TenantScopedRepository<AiAgentSettings> {
  constructor(@InjectModel('AiAgentSettings') model: Model<AiAgentSettings>) {
    super(model);
  }
}

/** Fields that change how the agent behaves and what it costs. */
export const BEHAVIOUR_FIELDS = [
  'enabled',
  'assistantName',
  'tone',
  'language',
  'tier',
  'takeOrders',
  'confirmOrders',
  'handoverKeywords',
  'handoverMessage',
  'replyDelaySeconds',
  'maxRepliesPerDay',
] as const;

/** Fields that describe the business to the agent. */
export const KNOWLEDGE_FIELDS = ['businessInfo', 'instructions', 'faqs'] as const;

type BehaviourField = (typeof BEHAVIOUR_FIELDS)[number];
type KnowledgeField = (typeof KNOWLEDGE_FIELDS)[number];
export type AgentSettingsPatch = Partial<Pick<AiAgentSettings, BehaviourField | KnowledgeField>>;

export function toAgentSettingsDto(s: AiAgentSettingsDoc) {
  return {
    enabled: s.enabled,
    assistantName: s.assistantName,
    tone: s.tone,
    language: s.language,
    tier: s.tier,
    businessInfo: s.businessInfo,
    instructions: s.instructions,
    faqs: s.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    takeOrders: s.takeOrders,
    confirmOrders: s.confirmOrders,
    handoverKeywords: s.handoverKeywords,
    handoverMessage: s.handoverMessage,
    replyDelaySeconds: s.replyDelaySeconds,
    maxRepliesPerDay: s.maxRepliesPerDay,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export type AgentSettingsDto = ReturnType<typeof toAgentSettingsDto>;

/** The AI sales agent's settings, one document per business, created with defaults on first read. */
@Injectable()
export class AiAgentSettingsService {
  constructor(
    private readonly repo: AiAgentSettingsRepository,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<AiAgentSettingsDoc> {
    const existing = await this.repo.findOne({});
    if (existing) return existing;
    try {
      return await this.repo.create({ ...AI_AGENT_DEFAULTS, faqs: [], handoverKeywords: [] });
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.repo.findOne({}))!;
      throw err;
    }
  }

  /** The settings when they exist, without creating them (event listeners). */
  async find(): Promise<AiAgentSettingsDoc | null> {
    return this.repo.findOne({});
  }

  private static can(permission: string): boolean {
    const p = RequestContext.tenant()!.permissions;
    return p.has('*') || p.has(permission);
  }

  /**
   * Behaviour needs ai.settings.manage; what the agent knows about the business needs
   * ai.knowledge.manage, so a manager can keep answers current without touching costs.
   */
  async update(patch: AgentSettingsPatch): Promise<AiAgentSettingsDoc> {
    const keys = Object.keys(patch) as (keyof AgentSettingsPatch)[];
    const missing: string[] = [];
    if (
      keys.some((k) => (BEHAVIOUR_FIELDS as readonly string[]).includes(k)) &&
      !AiAgentSettingsService.can('ai.settings.manage')
    )
      missing.push('ai.settings.manage');
    if (
      keys.some((k) => (KNOWLEDGE_FIELDS as readonly string[]).includes(k)) &&
      !AiAgentSettingsService.can('ai.knowledge.manage')
    )
      missing.push('ai.knowledge.manage');
    if (missing.length)
      throw new AppError('missing_permission', 403, 'Your role does not allow this change.', {
        required: missing,
      });

    const before = await this.get();
    if (!keys.length) return before;
    const actor = RequestContext.actor();
    const after = await this.repo.findOneAndUpdate(
      { _id: before._id },
      { $set: { ...patch, updatedBy: { type: actor.type, id: actor.id } } },
    );
    if (!after) throw AppError.notFound('ai_agent_settings');

    const changed = keys.filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k as keyof AiAgentSettingsDoc]),
    );
    if (changed.length) {
      const brief = (s: AiAgentSettingsDoc) =>
        Object.fromEntries(
          changed.map((k) => {
            const v = s[k];
            // Long texts are recorded by size; the settings document holds the text itself.
            if (typeof v === 'string' && v.length > 200) return [k, `${v.length} characters`];
            if (k === 'faqs') return [k, `${s.faqs.length} questions`];
            return [k, v];
          }),
        );
      await this.audit.record({
        action:
          'enabled' in patch && before.enabled !== after.enabled
            ? after.enabled
              ? 'ai.agent.enabled'
              : 'ai.agent.disabled'
            : 'ai.agent.updated',
        orgId: RequestContext.tenant()!.orgId,
        target: { type: 'ai_agent', id: after._id.toHexString(), label: 'AI sales agent' },
        metadata: { changed, before: brief(before), after: brief(after) },
      });
    }
    return after;
  }
}
