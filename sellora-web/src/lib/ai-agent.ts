import type { AiAgentSettings, AiLanguage, AiTone, ModelTier } from '@/lib/api/types';

/** The API's limits (sellora-api AI_LIMITS), checked here first so mistakes show inline. */
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

export const TONE_OPTIONS: { value: AiTone; label: string }[] = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'professional', label: 'Professional' },
  { value: 'casual', label: 'Casual' },
];

export const LANGUAGE_OPTIONS: { value: AiLanguage; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Same as the customer',
    hint: 'Bangla, Banglish or English, as they write',
  },
  { value: 'bn', label: 'Bangla', hint: 'Always replies in Bangla script' },
  { value: 'banglish', label: 'Banglish', hint: 'Bangla in English letters' },
  { value: 'en', label: 'English', hint: 'Always replies in English' },
];

export const TIER_OPTIONS: { value: ModelTier; label: string; hint: string }[] = [
  { value: 'fast', label: 'Fast', hint: 'Quick answers at the lowest cost. Right for most shops.' },
  { value: 'standard', label: 'Standard', hint: 'Better at long chats and tricky questions.' },
  { value: 'advanced', label: 'Advanced', hint: 'The most capable, for complex products.' },
];

/** Who may change what: behaviour needs ai.settings.manage, knowledge ai.knowledge.manage. */
export const BEHAVIOUR_KEYS = [
  'enabled',
  'assistantName',
  'tone',
  'language',
  'tier',
  'takeOrders',
  'confirmOrders',
  'transcribeVoiceNotes',
  'handoverKeywords',
  'handoverMessage',
  'replyDelaySeconds',
  'maxRepliesPerDay',
] as const;
export const KNOWLEDGE_KEYS = ['businessInfo', 'instructions', 'faqs'] as const;

type EditableKey = (typeof BEHAVIOUR_KEYS)[number] | (typeof KNOWLEDGE_KEYS)[number];
export type AgentPatch = Partial<Pick<AiAgentSettings, EditableKey>>;

/** The form's state: numbers stay as typed until saved. */
export interface AgentDraft {
  enabled: boolean;
  assistantName: string;
  tone: AiTone;
  language: AiLanguage;
  tier: ModelTier;
  businessInfo: string;
  instructions: string;
  faqs: { question: string; answer: string }[];
  takeOrders: boolean;
  confirmOrders: boolean;
  transcribeVoiceNotes: boolean;
  handoverKeywords: string[];
  handoverMessage: string;
  replyDelaySeconds: string;
  maxRepliesPerDay: string;
}

export function toDraft(s: AiAgentSettings): AgentDraft {
  return {
    enabled: s.enabled,
    assistantName: s.assistantName,
    tone: s.tone,
    language: s.language,
    tier: s.tier,
    businessInfo: s.businessInfo,
    instructions: s.instructions,
    faqs: s.faqs.map((f) => ({ ...f })),
    takeOrders: s.takeOrders,
    confirmOrders: s.confirmOrders,
    transcribeVoiceNotes: s.transcribeVoiceNotes,
    handoverKeywords: [...s.handoverKeywords],
    handoverMessage: s.handoverMessage,
    replyDelaySeconds: String(s.replyDelaySeconds),
    maxRepliesPerDay: String(s.maxRepliesPerDay),
  };
}

function wholeNumber(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** Field errors by form field id; empty when the draft can be saved. */
export function validateDraft(d: AgentDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.assistantName.trim().length > AI_LIMITS.assistantName)
    errors.assistantName = `Up to ${AI_LIMITS.assistantName} characters.`;
  if (d.businessInfo.trim().length > AI_LIMITS.businessInfo)
    errors.businessInfo = `Up to ${AI_LIMITS.businessInfo} characters.`;
  if (d.instructions.trim().length > AI_LIMITS.instructions)
    errors.instructions = `Up to ${AI_LIMITS.instructions} characters.`;
  if (d.faqs.length > AI_LIMITS.faqs) errors.faqs = `Up to ${AI_LIMITS.faqs} questions.`;
  d.faqs.forEach((f, i) => {
    if (!f.question.trim()) errors[`faq-${i}-q`] = 'Write the question';
    else if (f.question.trim().length > AI_LIMITS.faqQuestion)
      errors[`faq-${i}-q`] = `Up to ${AI_LIMITS.faqQuestion} characters.`;
    if (!f.answer.trim()) errors[`faq-${i}-a`] = 'Write the answer';
    else if (f.answer.trim().length > AI_LIMITS.faqAnswer)
      errors[`faq-${i}-a`] = `Up to ${AI_LIMITS.faqAnswer} characters.`;
  });
  if (d.handoverKeywords.length > AI_LIMITS.handoverKeywords)
    errors.handoverKeywords = `Up to ${AI_LIMITS.handoverKeywords} phrases.`;
  if (d.handoverMessage.trim().length > AI_LIMITS.handoverMessage)
    errors.handoverMessage = `Up to ${AI_LIMITS.handoverMessage} characters.`;
  if (wholeNumber(d.replyDelaySeconds, 0, AI_LIMITS.replyDelaySeconds) === null)
    errors.replyDelaySeconds = `A whole number from 0 to ${AI_LIMITS.replyDelaySeconds}.`;
  if (wholeNumber(d.maxRepliesPerDay, 1, AI_LIMITS.maxRepliesPerDay) === null)
    errors.maxRepliesPerDay = `A whole number from 1 to ${AI_LIMITS.maxRepliesPerDay}.`;
  return errors;
}

/** Folds a typed handover phrase the way the API stores it. */
export function normalizeKeyword(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

/** Adds phrases (comma or line separated) once each, keeping the limit and length. */
export function addKeywords(list: string[], input: string): string[] {
  const next = [...list];
  for (const raw of input.split(/[,\n]/)) {
    const k = normalizeKeyword(raw);
    if (k && k.length <= AI_LIMITS.keyword && !next.includes(k)) next.push(k);
  }
  return next.slice(0, AI_LIMITS.handoverKeywords);
}

/** The draft as the API takes it (assumes validateDraft passed). */
export function draftValues(d: AgentDraft): Required<AgentPatch> {
  return {
    enabled: d.enabled,
    assistantName: d.assistantName.trim(),
    tone: d.tone,
    language: d.language,
    tier: d.tier,
    businessInfo: d.businessInfo.trim(),
    instructions: d.instructions.trim(),
    faqs: d.faqs.map((f) => ({ question: f.question.trim(), answer: f.answer.trim() })),
    takeOrders: d.takeOrders,
    confirmOrders: d.confirmOrders,
    transcribeVoiceNotes: d.transcribeVoiceNotes,
    handoverKeywords: d.handoverKeywords,
    handoverMessage: d.handoverMessage.trim(),
    replyDelaySeconds: Number(d.replyDelaySeconds.trim()),
    maxRepliesPerDay: Number(d.maxRepliesPerDay.trim()),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Only the fields that changed and that this member may change. Unchanged fields are left
 * out, so a manager editing the FAQ never trips the behaviour permission.
 */
export function changedFields(
  saved: AiAgentSettings,
  draft: AgentDraft,
  can: { behaviour: boolean; knowledge: boolean },
): AgentPatch {
  const values = draftValues(draft);
  const patch: Record<string, unknown> = {};
  const keys: EditableKey[] = [
    ...(can.behaviour ? BEHAVIOUR_KEYS : []),
    ...(can.knowledge ? KNOWLEDGE_KEYS : []),
  ];
  for (const key of keys) if (!same(values[key], saved[key])) patch[key] = values[key];
  return patch as AgentPatch;
}

/** The settings the test chat tries before they are saved. */
export function previewDraft(d: AgentDraft) {
  const v = draftValues(d);
  return {
    assistantName: v.assistantName,
    tone: v.tone,
    language: v.language,
    tier: v.tier,
    businessInfo: v.businessInfo,
    instructions: v.instructions,
    // Half-written questions would be rejected; the test uses the finished ones.
    faqs: v.faqs.filter((f) => f.question && f.answer),
    takeOrders: v.takeOrders,
  };
}

/** How many typical replies the wallet pays for at the chosen tier. */
export function repliesLeft(
  availableMinor: number,
  perReplyMinor: number | undefined,
): number | null {
  if (!perReplyMinor || perReplyMinor <= 0) return null;
  return Math.max(0, Math.floor(availableMinor / perReplyMinor));
}

/** Names of the tools the agent used, in words, for the test chat. */
export const TOOL_LABEL: Record<string, string> = {
  search_products: 'searched products',
  search_website: 'read the website',
  get_product: 'checked a product',
  quote_order: 'priced an order',
  create_order: 'placed a test order',
  get_my_orders: 'looked up orders',
  save_customer_details: 'saved customer details',
  handover_to_human: 'handed over to the team',
};

export const HANDOVER_LABEL: Record<string, string> = {
  customer_request: 'the customer asked for a person',
  complaint: 'a complaint',
  order_problem: 'a problem with an order',
  discount_request: 'a discount request',
  cannot_answer: 'a question it could not answer',
  other: 'another reason',
};
