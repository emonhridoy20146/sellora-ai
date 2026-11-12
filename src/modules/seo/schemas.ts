import { Schema, type Types } from 'mongoose';
import {
  platformSchema,
  tenantSchema,
  uniquePerTenant,
} from '../../infra/database/schema-helpers.js';
import {
  CONTENT_KINDS,
  CONTENT_TONES,
  KEYWORD_INTENTS,
  KEYWORD_MIXES,
  KEYWORD_SCRIPTS,
  TRANSLATE_TO,
  WRITER_LANGUAGES,
  type ContentKind,
  type ContentTone,
  type KeywordIntent,
  type KeywordMix,
  type KeywordScript,
  type TranslateTo,
  type WriterLanguage,
} from './writer-tasks.js';

const strict = { _id: false, strict: 'throw' } as const;

const monthlySchema = new Schema(
  {
    year: { type: Number, required: true },
    month: { type: Number, required: true },
    volume: Number,
  },
  strict,
);

/**
 * Search volumes the platform already paid for (ADR 0032), shared by every business: public
 * numbers about a phrase, nothing about who looked it up. Kept 30 days.
 */
export interface KeywordVolumeCache {
  keyword: string;
  locationCode: number;
  volume: number | null;
  competition: 'low' | 'medium' | 'high' | null;
  competitionIndex: number | null;
  cpcUsdMicros: number | null;
  monthly: { year: number; month: number; volume: number }[];
  fetchedAt: Date;
}

export const keywordVolumeSchema = platformSchema<KeywordVolumeCache>(
  {
    keyword: { type: String, required: true },
    locationCode: { type: Number, required: true },
    volume: { type: Number, default: null },
    competition: { type: String, enum: ['low', 'medium', 'high', null], default: null },
    competitionIndex: { type: Number, default: null },
    cpcUsdMicros: { type: Number, default: null },
    monthly: { type: [monthlySchema], default: [] },
    fetchedAt: { type: Date, required: true },
  },
  { collection: 'keyword_volumes' },
);
keywordVolumeSchema.index({ keyword: 1, locationCode: 1 }, { unique: true });
keywordVolumeSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 30 * 86_400 });

/** Why a research has volumes or not. */
export const VOLUME_STATES = [
  'yes',
  'not_set_up',
  'not_priced',
  'no_credit',
  'failed',
  'off',
] as const;
export type VolumeState = (typeof VOLUME_STATES)[number];

export interface KeywordIdeaDoc {
  keyword: string;
  script: KeywordScript;
  intent: KeywordIntent;
  /** Monthly searches; null: no data (the provider has none, or volumes were not looked up). */
  volume: number | null;
  competition: 'low' | 'medium' | 'high' | null;
  cpcUsdMicros: number | null;
  /** Searches of the last 12 months, oldest first; empty without data. */
  trend: number[];
}

const ideaSchema = new Schema<KeywordIdeaDoc>(
  {
    keyword: { type: String, required: true },
    script: { type: String, enum: KEYWORD_SCRIPTS, required: true },
    intent: { type: String, enum: KEYWORD_INTENTS, required: true },
    volume: { type: Number, default: null },
    competition: { type: String, enum: ['low', 'medium', 'high', null], default: null },
    cpcUsdMicros: { type: Number, default: null },
    trend: { type: [Number], default: [] },
  },
  strict,
);

/** One keyword research: AI ideas around a seed, with volumes when they could be had. */
export interface KeywordResearch {
  orgId: Types.ObjectId;
  seed: string;
  mix: KeywordMix;
  ideas: KeywordIdeaDoc[];
  volumes: VolumeState;
  /** Credits for the AI ideas and for the volume lookup. */
  aiCredits: number;
  lookupCredits: number;
  createdBy: Types.ObjectId;
}

export const keywordResearchSchema = tenantSchema<KeywordResearch>(
  {
    seed: { type: String, required: true, maxlength: 80 },
    mix: { type: String, enum: KEYWORD_MIXES, required: true },
    ideas: { type: [ideaSchema], default: [] },
    volumes: { type: String, enum: VOLUME_STATES, required: true },
    aiCredits: { type: Number, default: 0 },
    lookupCredits: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { collection: 'keyword_research' },
);
keywordResearchSchema.index({ orgId: 1, createdAt: -1 });

export interface KeywordListItem {
  keyword: string;
  volume: number | null;
  competition: 'low' | 'medium' | 'high' | null;
  script?: KeywordScript;
  intent?: KeywordIntent;
  addedAt: Date;
}

/** A business's own list of keywords to target ("Eid panjabi", "Skin care"). */
export interface KeywordList {
  orgId: Types.ObjectId;
  name: string;
  keywords: KeywordListItem[];
}

export const keywordListSchema = tenantSchema<KeywordList>(
  {
    name: { type: String, required: true, maxlength: 60 },
    keywords: {
      type: [
        new Schema<KeywordListItem>(
          {
            keyword: { type: String, required: true },
            volume: { type: Number, default: null },
            competition: { type: String, enum: ['low', 'medium', 'high', null], default: null },
            script: { type: String, enum: KEYWORD_SCRIPTS },
            intent: { type: String, enum: KEYWORD_INTENTS },
            addedAt: { type: Date, required: true },
          },
          strict,
        ),
      ],
      default: [],
    },
  },
  { collection: 'keyword_lists' },
);
keywordListSchema.index({ orgId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------- Search Console

export const SC_STEPS = ['verify', 'add_site', 'sitemap', 'done'] as const;
export type ScStep = (typeof SC_STEPS)[number];

/** The business's Google account for Search Console (one per business). */
export interface SeoGoogle {
  orgId: Types.ObjectId;
  status: 'connected' | 'revoked';
  email: string;
  refreshTokenEnc: string;
  scopes: string[];
  storeId: Types.ObjectId;
  /** The URL-prefix property: the store's main address with a trailing slash. */
  siteUrl: string;
  /** Setup goes verify → add_site → sitemap → done; `setupError` says why it stopped. */
  step: ScStep;
  setupError?: string;
  setupAttempts: number;
  verifiedAt?: Date;
  sitemapSubmittedAt?: Date;
  lastSyncAt?: Date;
  lastSyncError?: string;
  nextSyncAt?: Date;
  /** Search data covers this period (YYYY-MM-DD, inclusive). */
  rowsFrom?: string;
  rowsTo?: string;
  connectedBy: { id: string; label?: string };
  connectedAt: Date;
}

export const seoGoogleSchema = uniquePerTenant(
  tenantSchema<SeoGoogle>(
    {
      status: { type: String, enum: ['connected', 'revoked'], required: true },
      email: { type: String, default: '' },
      refreshTokenEnc: { type: String, required: true },
      scopes: { type: [String], default: [] },
      storeId: { type: Schema.Types.ObjectId, required: true },
      siteUrl: { type: String, required: true },
      step: { type: String, enum: SC_STEPS, required: true },
      setupError: String,
      setupAttempts: { type: Number, default: 0 },
      verifiedAt: Date,
      sitemapSubmittedAt: Date,
      lastSyncAt: Date,
      lastSyncError: String,
      nextSyncAt: Date,
      rowsFrom: String,
      rowsTo: String,
      connectedBy: {
        type: new Schema({ id: { type: String, required: true }, label: String }, strict),
        required: true,
      },
      connectedAt: { type: Date, required: true },
    },
    { collection: 'seo_google' },
  ),
);
seoGoogleSchema.index({ status: 1, nextSyncAt: 1 });

/** Google search totals for the site on one day. */
export interface SearchConsoleDay {
  orgId: Types.ObjectId;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export const searchConsoleDaySchema = tenantSchema<SearchConsoleDay>(
  {
    date: { type: String, required: true },
    clicks: { type: Number, required: true },
    impressions: { type: Number, required: true },
    ctr: { type: Number, required: true },
    position: { type: Number, required: true },
  },
  { collection: 'search_console_days' },
);
searchConsoleDaySchema.index({ orgId: 1, date: 1 }, { unique: true });

/** One search phrase on one page over the last 28 days (replaced at each sync). */
export interface SearchConsoleRow {
  orgId: Types.ObjectId;
  syncId: string;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export const searchConsoleRowSchema = tenantSchema<SearchConsoleRow>(
  {
    syncId: { type: String, required: true },
    query: { type: String, required: true },
    page: { type: String, required: true },
    clicks: { type: Number, required: true },
    impressions: { type: Number, required: true },
    ctr: { type: Number, required: true },
    position: { type: Number, required: true },
  },
  { collection: 'search_console_rows' },
);
searchConsoleRowSchema.index({ orgId: 1, syncId: 1, impressions: -1 });

// ---------------------------------------------------------------- bulk optimiser

export const BULK_STATES = ['queued', 'running', 'done', 'cancelled'] as const;
export const BULK_ITEM_STATES = ['waiting', 'written', 'applied', 'failed', 'skipped'] as const;
export type BulkItemState = (typeof BULK_ITEM_STATES)[number];

export interface SeoSuggestion {
  focusKeyword: string;
  keywords: string[];
  seoTitle: string;
  slug: string;
  metaDescription: string;
  description: string;
  tags: string[];
  imageAlts: string[];
  faq: { question: string; answer: string }[];
}

const suggestionSchema = new Schema<SeoSuggestion>(
  {
    focusKeyword: String,
    keywords: [String],
    seoTitle: String,
    slug: String,
    metaDescription: String,
    description: String,
    tags: [String],
    imageAlts: [String],
    faq: [new Schema({ question: String, answer: String }, strict)],
  },
  strict,
);

export interface SeoBulkItem {
  productId: Types.ObjectId;
  name: string;
  scoreBefore: number;
  status: BulkItemState;
  suggestion?: SeoSuggestion;
  scoreAfter?: number;
  error?: string;
  credits: number;
}

/** "Fix with AI" for many products: suggestions written one by one, applied after review. */
export interface SeoBulkRun {
  orgId: Types.ObjectId;
  status: (typeof BULK_STATES)[number];
  language: WriterLanguage;
  items: SeoBulkItem[];
  credits: number;
  createdBy: Types.ObjectId;
  finishedAt?: Date;
}

export const seoBulkRunSchema = tenantSchema<SeoBulkRun>(
  {
    status: { type: String, enum: BULK_STATES, required: true },
    language: { type: String, enum: WRITER_LANGUAGES, required: true },
    items: {
      type: [
        new Schema<SeoBulkItem>(
          {
            productId: { type: Schema.Types.ObjectId, required: true },
            name: { type: String, required: true },
            scoreBefore: { type: Number, required: true },
            status: { type: String, enum: BULK_ITEM_STATES, required: true },
            suggestion: suggestionSchema,
            scoreAfter: Number,
            error: String,
            credits: { type: Number, default: 0 },
          },
          strict,
        ),
      ],
      default: [],
    },
    credits: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    finishedAt: Date,
  },
  { collection: 'seo_bulk_runs' },
);
seoBulkRunSchema.index({ orgId: 1, createdAt: -1 });
seoBulkRunSchema.index({ status: 1, createdAt: 1 });

// ---------------------------------------------------------------- content studio

export interface ContentDraft {
  orgId: Types.ObjectId;
  kind: ContentKind;
  productId?: Types.ObjectId;
  productName?: string;
  language: WriterLanguage;
  tone: ContentTone;
  translateTo?: TranslateTo;
  notes: string;
  /** The start of the text it was written from. */
  source: string;
  variants: { headline: string; text: string; hashtags: string[] }[];
  credits: number;
  createdBy: Types.ObjectId;
}

export const contentDraftSchema = tenantSchema<ContentDraft>(
  {
    kind: { type: String, enum: CONTENT_KINDS, required: true },
    productId: Schema.Types.ObjectId,
    productName: String,
    language: { type: String, enum: WRITER_LANGUAGES, required: true },
    tone: { type: String, enum: CONTENT_TONES, required: true },
    translateTo: { type: String, enum: TRANSLATE_TO },
    notes: { type: String, default: '' },
    source: { type: String, default: '' },
    variants: {
      type: [
        new Schema(
          { headline: { type: String, default: '' }, text: String, hashtags: [String] },
          strict,
        ),
      ],
      default: [],
    },
    credits: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { collection: 'content_drafts' },
);
contentDraftSchema.index({ orgId: 1, createdAt: -1 });
