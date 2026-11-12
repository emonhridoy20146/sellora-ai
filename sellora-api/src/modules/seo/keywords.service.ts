import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { AiWriterService } from '../ai/writer/ai-writer.service.js';
import { CreditsService } from '../billing/credits.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import {
  KeywordDataClient,
  KeywordDataError,
  LOOKUP_MAX_KEYWORDS,
  lookupable,
  normalizeKeyword,
} from './keyword-data.js';
import { KeywordListRepository, KeywordResearchRepository } from './repositories.js';
import type {
  KeywordIdeaDoc,
  KeywordList,
  KeywordListItem,
  KeywordResearch,
  KeywordVolumeCache,
  VolumeState,
} from './schemas.js';
import { containsKeyword } from './seo-score.js';
import { SEO_FEATURES } from './seo-writer.service.js';
import {
  keywordIdeasAnswer,
  keywordIdeasPrompt,
  keywordIdeasSchema,
  type KeywordIntent,
  type KeywordMix,
  type KeywordScript,
} from './writer-tasks.js';

/** Volumes looked up less than this long ago are not paid for again. */
const CACHE_MS = 30 * 86_400_000;
const RESEARCH_KEPT = 100;
const IDEAS_MAX = 50;
export const LISTS_MAX = 30;
export const LIST_KEYWORDS_MAX = 500;
/** Usage history name of a volume lookup. */
export const VOLUME_FEATURE = 'seo_keyword_volumes';

const BENGALI = /[ঀ-৿]/;

/** Which script a keyword is written in. */
export function scriptOf(keyword: string): KeywordScript {
  return BENGALI.test(keyword) ? 'bangla' : 'english';
}

type Doc<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export function toResearchDto(r: Doc<KeywordResearch>) {
  return {
    id: r._id.toHexString(),
    seed: r.seed,
    mix: r.mix,
    volumes: r.volumes,
    ideas: r.ideas.map((i) => ({
      keyword: i.keyword,
      script: i.script,
      intent: i.intent,
      volume: i.volume,
      competition: i.competition,
      cpcUsd: i.cpcUsdMicros === null ? null : i.cpcUsdMicros / 1_000_000,
      trend: i.trend,
    })),
    credits: Math.round((r.aiCredits + r.lookupCredits) * 100) / 100,
    createdAt: r.createdAt.toISOString(),
  };
}

export interface VolumeResult {
  state: VolumeState;
  credits: number;
  byKeyword: Map<string, KeywordVolumeCache>;
}

/**
 * Keyword research (ADR 0032): AI ideas in Bangla, English and Banglish around a seed, with
 * monthly searches from the keyword data provider when it is set up and priced. Volumes
 * the platform already has (30 days) are free; a lookup of new ones costs the business
 * the super-admin's price per lookup. Ideas never get made-up numbers: without data they
 * say so.
 */
@Injectable()
export class KeywordsService {
  private readonly logger = new Logger(KeywordsService.name);

  constructor(
    private readonly writer: AiWriterService,
    private readonly client: KeywordDataClient,
    private readonly credits: CreditsService,
    private readonly limits: RateLimitService,
    private readonly research: KeywordResearchRepository,
    private readonly lists: KeywordListRepository,
    private readonly products: ProductRepository,
    @InjectModel('KeywordVolumeCache') private readonly cache: Model<KeywordVolumeCache>,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  /** What the research page needs to say before anything is spent. */
  async setup() {
    const quote = this.client.configured ? await this.credits.quoteKeywordLookup() : null;
    return {
      volumes: !this.client.configured ? 'not_set_up' : quote ? 'ready' : 'not_priced',
      lookup: quote,
      maxKeywordsPerLookup: LOOKUP_MAX_KEYWORDS,
    };
  }

  async run(input: { seed: string; mix: KeywordMix; volumes: boolean; about?: string }) {
    await this.limits.consume('keyword-research:org', this.orgId());
    const seed = input.seed.trim();
    const { system, prompt } = keywordIdeasPrompt({
      seed,
      mix: input.mix,
      about: input.about?.trim() || null,
    });
    const { value, credits: aiCredits } = await this.writer.write({
      feature: SEO_FEATURES.keywords,
      tier: 'standard',
      system,
      prompt,
      schema: keywordIdeasSchema,
      parse: keywordIdeasAnswer,
      maxOutputTokens: 2_500,
    });
    const seedIdea = { keyword: seed, script: scriptOf(seed), intent: 'buy' as KeywordIntent };
    const raw = [seedIdea, ...value.ideas]
      .filter(
        (i, n, all) =>
          all.findIndex((x) => normalizeKeyword(x.keyword) === normalizeKeyword(i.keyword)) === n,
      )
      .slice(0, IDEAS_MAX);
    let volumes: VolumeResult = { state: 'off', credits: 0, byKeyword: new Map() };
    if (input.volumes) volumes = await this.lookup(raw.map((i) => i.keyword));
    const ideas: KeywordIdeaDoc[] = raw.map((i) => {
      const v = volumes.byKeyword.get(normalizeKeyword(i.keyword));
      return {
        keyword: i.keyword,
        script: i.script,
        intent: i.intent,
        volume: v?.volume ?? null,
        competition: v?.competition ?? null,
        cpcUsdMicros: v?.cpcUsdMicros ?? null,
        trend: v?.monthly.map((m) => m.volume) ?? [],
      };
    });
    // Known volumes first, biggest first; the rest keep the AI's order.
    ideas.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
    const doc = await this.research.create({
      seed,
      mix: input.mix,
      ideas,
      volumes: volumes.state,
      aiCredits,
      lookupCredits: volumes.credits,
      createdBy: new Types.ObjectId(RequestContext.actor().id),
    });
    const old = await this.research.find(
      {},
      { sort: { createdAt: -1 }, skip: RESEARCH_KEPT, projection: { _id: 1 } },
    );
    if (old.length) await this.research.deleteMany({ _id: { $in: old.map((d) => d._id) } });
    return toResearchDto(doc);
  }

  async history() {
    const items = await this.research.find({}, { sort: { createdAt: -1 }, limit: 30 });
    return { items: items.map(toResearchDto) };
  }

  async get(id: string) {
    const r = await this.research.findById(id);
    if (!r) throw AppError.notFound('keyword_research');
    return toResearchDto(r);
  }

  /**
   * Monthly searches for up to 100 keywords: the ones the platform has are free, the rest
   * go to the provider in one lookup the business pays for. Never throws for the provider:
   * the state says why there are no numbers.
   */
  async lookup(keywords: string[]): Promise<VolumeResult> {
    const wanted = [...new Set(keywords.map(normalizeKeyword))]
      .filter(lookupable)
      .slice(0, LOOKUP_MAX_KEYWORDS);
    const locationCode = this.client.locationCode;
    const cached = wanted.length
      ? await this.cache
          .find({
            keyword: { $in: wanted },
            locationCode,
            fetchedAt: { $gte: new Date(Date.now() - CACHE_MS) },
          })
          .lean<KeywordVolumeCache[]>()
          .exec()
      : [];
    const byKeyword = new Map(cached.map((c) => [c.keyword, c]));
    const missing = wanted.filter((k) => !byKeyword.has(k));
    const result = (state: VolumeState, credits = 0): VolumeResult => ({
      state,
      credits,
      byKeyword,
    });
    if (!missing.length) return result(wanted.length ? 'yes' : 'off');
    if (!this.client.configured) return result('not_set_up');
    if (!(await this.credits.quoteKeywordLookup())) return result('not_priced');
    const requestId = `keyword-lookup-${randomUUID()}`;
    try {
      await this.credits.reserveKeywordLookup({ requestId, feature: VOLUME_FEATURE });
    } catch (err) {
      if (err instanceof AppError && err.code === 'insufficient_balance')
        return result('no_credit');
      if (err instanceof AppError && err.code === 'keywords_not_priced')
        return result('not_priced');
      throw err;
    }
    try {
      await this.limits.consume('keyword-volumes:platform', 'all');
    } catch (err) {
      await this.credits.release(requestId);
      throw err;
    }
    let found;
    try {
      found = await this.client.volumes(missing);
    } catch (err) {
      await this.credits.release(requestId);
      if (err instanceof KeywordDataError) {
        this.logger.warn({ kind: err.kind, err: err.message }, 'Keyword volume lookup failed');
        return result('failed');
      }
      throw err;
    }
    const usage = await this.credits.settleKeywordLookup({
      requestId,
      provider: this.client.provider,
      costUsdMicros: found.costUsdMicros,
    });
    const fetchedAt = new Date();
    if (found.items.length)
      await this.cache.bulkWrite(
        found.items.map((i) => ({
          updateOne: {
            filter: { keyword: i.keyword, locationCode },
            update: {
              $set: {
                volume: i.volume,
                competition: i.competition,
                competitionIndex: i.competitionIndex,
                cpcUsdMicros: i.cpcUsdMicros,
                monthly: i.monthly,
                fetchedAt,
              },
            },
            upsert: true,
          },
        })),
      );
    for (const i of found.items) byKeyword.set(i.keyword, { ...i, locationCode, fetchedAt });
    return result('yes', usage.credits);
  }

  // ---------------------------------------------------------------- lists

  private listDto(l: Doc<KeywordList>, coverage?: Map<string, { id: string; name: string }[]>) {
    return {
      id: l._id.toHexString(),
      name: l.name,
      count: l.keywords.length,
      keywords: l.keywords.map((k) => ({
        keyword: k.keyword,
        volume: k.volume,
        competition: k.competition,
        script: k.script ?? scriptOf(k.keyword),
        intent: k.intent ?? null,
        addedAt: k.addedAt.toISOString(),
        ...(coverage ? { targetedBy: coverage.get(normalizeKeyword(k.keyword)) ?? [] } : {}),
      })),
      updatedAt: l.updatedAt.toISOString(),
    };
  }

  async allLists() {
    const lists = await this.lists.find({}, { sort: { name: 1 } });
    return {
      items: lists.map((l) => {
        const { keywords: _k, ...rest } = this.listDto(l);
        return rest;
      }),
      max: LISTS_MAX,
    };
  }

  private async list(id: string): Promise<Doc<KeywordList>> {
    const l = await this.lists.findById(id);
    if (!l) throw AppError.notFound('keyword_list');
    return l;
  }

  /**
   * A list with, for each keyword, the active products that target it (the keyword is one
   * of their target keywords, or in their search title or name). Keywords no product targets
   * are the gaps to write for.
   */
  async listDetail(id: string) {
    const l = await this.list(id);
    const products = await this.products.find(
      { status: 'active' },
      { projection: { name: 1, 'seo.title': 1, 'seo.keywords': 1 }, limit: 5000 },
    );
    const coverage = new Map<string, { id: string; name: string }[]>();
    for (const k of l.keywords) {
      const key = normalizeKeyword(k.keyword);
      const hits = products.filter(
        (p) =>
          (p.seo?.keywords ?? []).some((x) => normalizeKeyword(x) === key) ||
          containsKeyword(p.seo?.title ?? '', k.keyword) ||
          containsKeyword(p.name, k.keyword),
      );
      coverage.set(
        key,
        hits.slice(0, 5).map((p) => ({ id: p._id.toHexString(), name: p.name })),
      );
    }
    const dto = this.listDto(l, coverage);
    return { ...dto, gaps: dto.keywords.filter((k) => !k.targetedBy?.length).length };
  }

  async createList(name: string) {
    if ((await this.lists.count()) >= LISTS_MAX)
      throw AppError.conflict('keyword_list_limit', `A business can keep ${LISTS_MAX} lists.`);
    if (await this.lists.exists({ name }))
      throw AppError.conflict('keyword_list_exists', 'A list with this name already exists.');
    return this.listDto(await this.lists.create({ name, keywords: [] }));
  }

  async renameList(id: string, name: string) {
    const l = await this.list(id);
    if (name !== l.name && (await this.lists.exists({ name })))
      throw AppError.conflict('keyword_list_exists', 'A list with this name already exists.');
    await this.lists.updateOne({ _id: l._id }, { $set: { name } });
    return this.listDetail(id);
  }

  async removeList(id: string): Promise<void> {
    if (!(await this.lists.deleteOne({ _id: new Types.ObjectId(id) })))
      throw AppError.notFound('keyword_list');
  }

  async addKeywords(
    id: string,
    keywords: {
      keyword: string;
      volume?: number | null;
      competition?: KeywordListItem['competition'];
      script?: KeywordScript;
      intent?: KeywordIntent;
    }[],
  ) {
    const l = await this.list(id);
    const have = new Set(l.keywords.map((k) => normalizeKeyword(k.keyword)));
    const now = new Date();
    const added: KeywordListItem[] = [];
    for (const k of keywords) {
      const key = normalizeKeyword(k.keyword);
      if (!key || have.has(key)) continue;
      have.add(key);
      added.push({
        keyword: k.keyword.trim(),
        volume: k.volume ?? null,
        competition: k.competition ?? null,
        script: k.script ?? scriptOf(k.keyword),
        ...(k.intent ? { intent: k.intent } : {}),
        addedAt: now,
      });
    }
    if (l.keywords.length + added.length > LIST_KEYWORDS_MAX)
      throw AppError.conflict(
        'keyword_list_full',
        `A list holds up to ${LIST_KEYWORDS_MAX} keywords. Remove some or start another list.`,
      );
    if (added.length)
      await this.lists.updateOne({ _id: l._id }, { $push: { keywords: { $each: added } } });
    return this.listDetail(id);
  }

  async removeKeywords(id: string, keywords: string[]) {
    const l = await this.list(id);
    const drop = new Set(keywords.map(normalizeKeyword));
    await this.lists.updateOne(
      { _id: l._id },
      { $set: { keywords: l.keywords.filter((k) => !drop.has(normalizeKeyword(k.keyword))) } },
    );
    return this.listDetail(id);
  }

  /** Looks up volumes for the list's keywords that have none (one lookup, up to 100). */
  async refreshVolumes(id: string) {
    const l = await this.list(id);
    const without = l.keywords.filter((k) => k.volume === null).map((k) => k.keyword);
    if (!without.length) return { ...(await this.listDetail(id)), volumes: 'yes', credits: 0 };
    const v = await this.lookup(without);
    if (v.byKeyword.size) {
      const fresh = await this.list(id);
      await this.lists.updateOne(
        { _id: fresh._id },
        {
          $set: {
            keywords: fresh.keywords.map((k) => {
              const found = v.byKeyword.get(normalizeKeyword(k.keyword));
              return found && k.volume === null
                ? { ...k, volume: found.volume, competition: found.competition }
                : k;
            }),
          },
        },
      );
    }
    return { ...(await this.listDetail(id)), volumes: v.state, credits: v.credits };
  }
}
