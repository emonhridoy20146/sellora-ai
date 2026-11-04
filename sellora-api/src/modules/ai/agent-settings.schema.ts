import { Schema, type Types } from 'mongoose';
import { tenantSchema, uniquePerTenant } from '../../infra/database/schema-helpers.js';
import { MODEL_TIERS, type ModelTier } from '../billing/credit-schemas.js';

export const AI_TONES = ['friendly', 'professional', 'casual'] as const;
export type AiTone = (typeof AI_TONES)[number];

/** auto: answer in the customer's language (Bangla, Banglish or English). */
export const AI_LANGUAGES = ['auto', 'bn', 'banglish', 'en'] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];

export interface AiFaq {
  question: string;
  answer: string;
}

/**
 * How a business's AI sales agent behaves. One document per business. The agent is off
 * until the business turns it on, because every reply spends AI credits.
 */
export interface AiAgentSettings {
  orgId: Types.ObjectId;
  enabled: boolean;
  /** Name the agent introduces itself with; empty means "<business> assistant". */
  assistantName: string;
  tone: AiTone;
  language: AiLanguage;
  /** Model tier: fast is cheapest per reply, advanced the most capable. */
  tier: ModelTier;
  /** About the business: delivery areas and times, payment, returns, opening hours. */
  businessInfo: string;
  /** Extra rules from the business, e.g. "Always mention free delivery over ৳2,000". */
  instructions: string;
  faqs: AiFaq[];
  /** Whether the agent may place orders itself. */
  takeOrders: boolean;
  /** Orders the agent places start confirmed (stock taken) instead of pending. */
  confirmOrders: boolean;
  /** A customer message containing one of these hands the chat to a person at once. */
  handoverKeywords: string[];
  /** What the customer is told when the chat goes to a person without the AI writing it. */
  handoverMessage: string;
  /** Seconds to wait for more messages before replying, so bursts get one answer. */
  replyDelaySeconds: number;
  /** AI replies per conversation in 24 hours before it hands over (guards against loops). */
  maxRepliesPerDay: number;
  updatedBy?: { type: string; id: string };
}

export const AI_AGENT_DEFAULTS = {
  enabled: false,
  assistantName: '',
  tone: 'friendly',
  language: 'auto',
  tier: 'fast',
  businessInfo: '',
  instructions: '',
  faqs: [],
  takeOrders: true,
  confirmOrders: false,
  handoverKeywords: [],
  handoverMessage: '',
  replyDelaySeconds: 3,
  maxRepliesPerDay: 40,
} as const satisfies Omit<AiAgentSettings, 'orgId' | 'updatedBy'>;

export const AI_LIMITS = {
  assistantName: 60,
  businessInfo: 4_000,
  instructions: 2_000,
  faqs: 50,
  faqQuestion: 200,
  faqAnswer: 1_000,
  handoverKeywords: 30,
  keyword: 60,
  handoverMessage: 500,
  replyDelaySeconds: 30,
  maxRepliesPerDay: 500,
} as const;

export const aiAgentSettingsSchema = tenantSchema<AiAgentSettings>(
  {
    enabled: { type: Boolean, default: AI_AGENT_DEFAULTS.enabled },
    assistantName: { type: String, default: AI_AGENT_DEFAULTS.assistantName },
    tone: { type: String, enum: AI_TONES, default: AI_AGENT_DEFAULTS.tone },
    language: { type: String, enum: AI_LANGUAGES, default: AI_AGENT_DEFAULTS.language },
    tier: { type: String, enum: MODEL_TIERS, default: AI_AGENT_DEFAULTS.tier },
    businessInfo: { type: String, default: AI_AGENT_DEFAULTS.businessInfo },
    instructions: { type: String, default: AI_AGENT_DEFAULTS.instructions },
    faqs: {
      type: [
        new Schema<AiFaq>(
          {
            question: { type: String, required: true },
            answer: { type: String, required: true },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: [],
    },
    takeOrders: { type: Boolean, default: AI_AGENT_DEFAULTS.takeOrders },
    confirmOrders: { type: Boolean, default: AI_AGENT_DEFAULTS.confirmOrders },
    handoverKeywords: { type: [String], default: [] },
    handoverMessage: { type: String, default: AI_AGENT_DEFAULTS.handoverMessage },
    replyDelaySeconds: {
      type: Number,
      default: AI_AGENT_DEFAULTS.replyDelaySeconds,
      min: 0,
      max: AI_LIMITS.replyDelaySeconds,
    },
    maxRepliesPerDay: {
      type: Number,
      default: AI_AGENT_DEFAULTS.maxRepliesPerDay,
      min: 1,
      max: AI_LIMITS.maxRepliesPerDay,
    },
    updatedBy: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }),
  },
  { collection: 'ai_agent_settings' },
);
aiAgentSettingsSchema.path('orgId').index(false);
uniquePerTenant(aiAgentSettingsSchema);
