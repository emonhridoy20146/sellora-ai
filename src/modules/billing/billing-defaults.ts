import type { AiModel, CreditRate } from './credit-schemas.js';
import { UNLIMITED, type PlanLimits } from './feature-modules.js';
import type { Plan } from './schemas.js';

/**
 * First-run seed data. These rows are inserted only when they do not exist yet, so the
 * super-admin's later edits always win. Nothing in the billing logic reads these
 * constants directly: it reads the database.
 */

const limits = (overrides: Partial<PlanLimits>): PlanLimits => ({ ...UNLIMITED, ...overrides });

type SeedPlan = Omit<Plan, 'version' | 'updatedBy'>;

export const DEFAULT_PLANS: SeedPlan[] = [
  {
    code: 'free',
    name: 'Free',
    description: 'Try the inbox and orders with a small shop.',
    modules: ['inbox', 'commerce'],
    limits: limits({
      seats: 1,
      stores: 0,
      customDomains: 0,
      products: 25,
      channels: 1,
      ordersPerMonth: 50,
      conversationsPerMonth: 100,
      landingPages: 0,
      storageMb: 200,
      websitePages: 25,
    }),
    prices: [{ interval: 'month', currency: 'BDT', amountMinor: 0 }],
    includedCreditsPerMonth: 0,
    isPublic: true,
    isActive: true,
    trialEligible: false,
    highlight: false,
    sortOrder: 0,
  },
  {
    code: 'inbox',
    name: 'AI Inbox',
    description: 'All your chats in one inbox with an AI sales agent that replies 24/7.',
    modules: ['inbox', 'ai_agent', 'analytics'],
    limits: limits({
      seats: 3,
      stores: 0,
      customDomains: 0,
      channels: 4,
      landingPages: 0,
      storageMb: 2_000,
      websitePages: 100,
    }),
    prices: [
      { interval: 'month', currency: 'BDT', amountMinor: 149_900 },
      { interval: 'year', currency: 'BDT', amountMinor: 1_499_000 },
    ],
    includedCreditsPerMonth: 300,
    isPublic: true,
    isActive: true,
    trialEligible: true,
    highlight: false,
    sortOrder: 10,
  },
  {
    code: 'commerce',
    name: 'Inbox + Shop',
    description: 'AI inbox plus orders, couriers, fraud check, online store and landing pages.',
    modules: [
      'inbox',
      'ai_agent',
      'analytics',
      'commerce',
      'couriers',
      'fraud',
      'storefront',
      'landing_pages',
      'backups_drive',
    ],
    limits: limits({
      seats: 5,
      stores: 1,
      customDomains: 1,
      landingPages: 10,
      storageMb: 10_000,
      websitePages: 200,
    }),
    prices: [
      { interval: 'month', currency: 'BDT', amountMinor: 299_900 },
      { interval: 'year', currency: 'BDT', amountMinor: 2_999_000 },
    ],
    includedCreditsPerMonth: 600,
    isPublic: true,
    isActive: true,
    trialEligible: true,
    highlight: true,
    sortOrder: 20,
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'Everything in Inbox + Shop, plus ads intelligence, AI SEO and marketing.',
    modules: [
      'inbox',
      'ai_agent',
      'analytics',
      'commerce',
      'couriers',
      'fraud',
      'storefront',
      'landing_pages',
      'backups_drive',
      'ads',
      'seo',
      'marketing',
    ],
    limits: limits({
      seats: 10,
      stores: 3,
      customDomains: 3,
      landingPages: 50,
      storageMb: 30_000,
      websitePages: 500,
    }),
    prices: [
      { interval: 'month', currency: 'BDT', amountMinor: 499_900 },
      { interval: 'year', currency: 'BDT', amountMinor: 4_999_000 },
    ],
    includedCreditsPerMonth: 1_200,
    isPublic: true,
    isActive: true,
    trialEligible: true,
    highlight: false,
    sortOrder: 30,
  },
  {
    code: 'all-in-one',
    name: 'All-in-one',
    description: 'Every module, the API and the highest limits.',
    modules: [
      'inbox',
      'ai_agent',
      'analytics',
      'commerce',
      'couriers',
      'fraud',
      'storefront',
      'landing_pages',
      'backups_drive',
      'ads',
      'seo',
      'marketing',
      'api_access',
    ],
    limits: limits({ seats: 25, stores: 10, storageMb: 100_000 }),
    prices: [
      { interval: 'month', currency: 'BDT', amountMinor: 799_900 },
      { interval: 'year', currency: 'BDT', amountMinor: 7_999_000 },
      { interval: 'lifetime', currency: 'BDT', amountMinor: 19_999_900 },
    ],
    includedCreditsPerMonth: 2_500,
    isPublic: true,
    isActive: true,
    trialEligible: true,
    highlight: false,
    sortOrder: 40,
  },
];

export const FREE_PLAN_CODE = 'free';
export const DEFAULT_TRIAL_PLAN_CODE = 'all-in-one';

/**
 * Real provider prices in micro-USD per million tokens, taken from Anthropic's published
 * price list (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, cache reads $0.20; Haiku 5.5
 * $0.10/$0.50 up to 100K prompt tokens and $0.50/$2.50 above). Haiku's cache-read price is
 * not published in our source, so it is seeded at the full input price, which can only
 * overstate cost, never understate it. The super-admin keeps these current.
 */
export const DEFAULT_AI_MODELS: AiModel[] = [
  {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    tier: 'fast',
    inputUsdMicrosPerMTok: 100_000,
    outputUsdMicrosPerMTok: 500_000,
    cachedInputUsdMicrosPerMTok: 100_000,
    cacheWriteUsdMicrosPerMTok: 125_000,
    longContext: {
      thresholdTokens: 100_000,
      inputUsdMicrosPerMTok: 500_000,
      outputUsdMicrosPerMTok: 2_500_000,
    },
    contextWindow: 1_000_000,
    imageInput: true,
    enabled: true,
    isDefaultForTier: true,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    tier: 'standard',
    inputUsdMicrosPerMTok: 2_000_000,
    outputUsdMicrosPerMTok: 10_000_000,
    cachedInputUsdMicrosPerMTok: 200_000,
    cacheWriteUsdMicrosPerMTok: 2_500_000,
    contextWindow: 1_000_000,
    imageInput: true,
    enabled: true,
    isDefaultForTier: true,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    tier: 'advanced',
    inputUsdMicrosPerMTok: 4_000_000,
    outputUsdMicrosPerMTok: 20_000_000,
    cachedInputUsdMicrosPerMTok: 200_000,
    cacheWriteUsdMicrosPerMTok: 5_000_000,
    contextWindow: 1_000_000,
    imageInput: true,
    enabled: true,
    isDefaultForTier: true,
  },
  /**
   * Speech-to-text for customers' voice notes (ADR 0025), through OpenAI's transcription
   * API (or any service that speaks it, set by AI_OPENAI_BASE_URL). $0.003 a minute is the
   * published price as summarised in November 2026; confirm it on OpenAI's price page. Its
   * tier is not used. Without AI_OPENAI_API_KEY voice notes stay audio only.
   */
  {
    provider: 'openai',
    model: 'gpt-4o-mini-transcribe',
    label: 'GPT-4o mini Transcribe',
    purpose: 'transcription',
    tier: 'fast',
    inputUsdMicrosPerMTok: 0,
    outputUsdMicrosPerMTok: 0,
    cachedInputUsdMicrosPerMTok: 0,
    contextWindow: 16_000,
    imageInput: false,
    audioUsdMicrosPerMinute: 3_000,
    enabled: true,
    isDefaultForTier: true,
  },
];

/**
 * Starting price list: 1 credit = ৳0.10. Per 1,000 tokens a fast reply costs 2 credits in
 * and 10 out, standard 6/30, advanced 10/50. A minute of voice note turned into text costs
 * 15 credits (৳1.50), charged by the second. The super-admin publishes new versions.
 */
export const DEFAULT_CREDIT_RATE: Omit<CreditRate, 'effectiveFrom' | 'createdBy'> = {
  version: 1,
  currency: 'BDT',
  creditPriceMinor: 10,
  tiers: [
    { tier: 'fast', inputCreditsPer1k: 2, outputCreditsPer1k: 10 },
    { tier: 'standard', inputCreditsPer1k: 6, outputCreditsPer1k: 30 },
    { tier: 'advanced', inputCreditsPer1k: 10, outputCreditsPer1k: 50 },
  ],
  minimumCreditsPerRequest: 1,
  transcriptionCreditsPerMinute: 15,
  keywordLookupCredits: 150,
  usdRateScaled: 1_220_000,
  note: 'Initial price list',
};
