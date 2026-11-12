import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

/** Injection token for the fetch the keyword data client uses, so tests can play its part. */
export const KEYWORD_FETCH = Symbol('KEYWORD_FETCH');

/** At most this many keywords go into one lookup (the provider takes up to 1,000). */
export const LOOKUP_MAX_KEYWORDS = 100;

export interface KeywordVolume {
  /** As sent (normalised: lower case, single spaces). */
  keyword: string;
  /** Average monthly searches; null when the provider has no data for it. */
  volume: number | null;
  competition: 'low' | 'medium' | 'high' | null;
  /** 0–100. */
  competitionIndex: number | null;
  /** Cost per click advertisers paid, in US dollar micros; null when unknown. */
  cpcUsdMicros: number | null;
  /** The last 12 months, oldest first. */
  monthly: { year: number; month: number; volume: number }[];
}

export interface VolumeLookup {
  items: KeywordVolume[];
  /** What the provider billed for the request, in US dollar micros. */
  costUsdMicros: number;
}

export type KeywordDataErrorKind = 'not_configured' | 'auth' | 'rate_limited' | 'failed';

export class KeywordDataError extends Error {
  constructor(
    readonly kind: KeywordDataErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'KeywordDataError';
  }
}

/**
 * Keywords Google Ads accepts: at most 80 characters and 10 words, without the symbols it
 * refuses. Others are left out of a lookup (they show without volumes).
 */
export function lookupable(keyword: string): boolean {
  const k = keyword.trim();
  return (
    k.length > 0 &&
    k.length <= 80 &&
    k.split(/\s+/).length <= 10 &&
    !/[!@%,*=(){}<>[\];|\\^~`]/.test(k)
  );
}

/** Lower case, single spaces: how volumes are cached and matched. */
export function normalizeKeyword(keyword: string): string {
  return keyword.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Monthly search volumes from DataForSEO's Google Ads data (ADR 0032), in the country set
 * by KEYWORDS_LOCATION_CODE and all languages, so Bangla, English and Banglish searches all
 * count. One request is billed per call whatever the number of keywords in it.
 */
@Injectable()
export class KeywordDataClient {
  constructor(
    private readonly config: AppConfig,
    @Inject(KEYWORD_FETCH) private readonly fetch: typeof globalThis.fetch,
  ) {}

  get provider(): string {
    return 'dataforseo';
  }

  get configured(): boolean {
    return Boolean(this.config.get('KEYWORDS_DATAFORSEO_LOGIN'));
  }

  get locationCode(): number {
    return this.config.get('KEYWORDS_LOCATION_CODE');
  }

  async volumes(keywords: string[]): Promise<VolumeLookup> {
    if (!this.configured)
      throw new KeywordDataError('not_configured', 'Keyword data is not set up');
    const list = [...new Set(keywords.map(normalizeKeyword))].filter(lookupable);
    if (!list.length) return { items: [], costUsdMicros: 0 };
    if (list.length > LOOKUP_MAX_KEYWORDS)
      throw new Error(`At most ${LOOKUP_MAX_KEYWORDS} keywords per lookup`);
    const auth = Buffer.from(
      `${this.config.get('KEYWORDS_DATAFORSEO_LOGIN')}:${this.config.get('KEYWORDS_DATAFORSEO_PASSWORD')}`,
    ).toString('base64');
    let res: Response;
    try {
      res = await this.fetch(
        `${this.config.get('KEYWORDS_DATAFORSEO_URL').replace(/\/+$/, '')}/v3/keywords_data/google_ads/search_volume/live`,
        {
          method: 'POST',
          headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
          body: JSON.stringify([{ keywords: list, location_code: this.locationCode }]),
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch {
      throw new KeywordDataError('failed', 'The keyword data service could not be reached');
    }
    const json = (await res.json().catch(() => null)) as DfsResponse | null;
    if (res.status === 401 || json?.status_code === 40100)
      throw new KeywordDataError('auth', 'The keyword data service refused the login');
    if (res.status === 429 || json?.status_code === 40202)
      throw new KeywordDataError('rate_limited', 'The keyword data service is busy');
    if (!res.ok || !json || json.status_code !== 20000)
      throw new KeywordDataError(
        'failed',
        `The keyword data service answered ${json?.status_code ?? res.status}${json?.status_message ? `: ${json.status_message}` : ''}`,
      );
    const task = json.tasks?.[0];
    if (!task || task.status_code !== 20000)
      throw new KeywordDataError(
        'failed',
        `The keyword lookup failed (${task?.status_code ?? 'no task'}${task?.status_message ? `: ${task.status_message}` : ''})`,
      );
    const byKeyword = new Map(
      (task.result ?? []).map((r) => [normalizeKeyword(r.keyword ?? ''), r] as const),
    );
    const items = list.map((keyword): KeywordVolume => {
      const r = byKeyword.get(keyword);
      const monthly = (r?.monthly_searches ?? [])
        .filter((m) => typeof m.search_volume === 'number')
        .map((m) => ({ year: m.year, month: m.month, volume: m.search_volume! }))
        .sort((a, b) => a.year - b.year || a.month - b.month)
        .slice(-12);
      const comp = r?.competition?.toLowerCase();
      return {
        keyword,
        volume: typeof r?.search_volume === 'number' ? r.search_volume : null,
        competition: comp === 'low' || comp === 'medium' || comp === 'high' ? comp : null,
        competitionIndex: typeof r?.competition_index === 'number' ? r.competition_index : null,
        cpcUsdMicros: typeof r?.cpc === 'number' ? Math.round(r.cpc * 1_000_000) : null,
        monthly,
      };
    });
    const cost = typeof json.cost === 'number' ? json.cost : (task.cost ?? 0);
    return { items, costUsdMicros: Math.round(cost * 1_000_000) };
  }
}

interface DfsResponse {
  status_code: number;
  status_message?: string;
  cost?: number;
  tasks?: {
    status_code: number;
    status_message?: string;
    cost?: number;
    result?: {
      keyword?: string;
      competition?: string | null;
      competition_index?: number | null;
      search_volume?: number | null;
      cpc?: number | null;
      monthly_searches?: { year: number; month: number; search_volume: number | null }[] | null;
    }[];
  }[];
}
