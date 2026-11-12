/**
 * Plays DataForSEO's Google Ads search volume endpoint (live) for tests, in the documented
 * request and response shape. Volumes come from `volumes`; a keyword it does not know has
 * no data (null), like a real phrase nobody searches.
 */
export const KEYWORDS_TEST = {
  url: 'https://keywords.test',
  login: 'test-login@example.com',
  password: 'test-keyword-password',
};

export const keywordsEnv = {
  KEYWORDS_DATAFORSEO_LOGIN: KEYWORDS_TEST.login,
  KEYWORDS_DATAFORSEO_PASSWORD: KEYWORDS_TEST.password,
  KEYWORDS_DATAFORSEO_URL: KEYWORDS_TEST.url,
};

export class FakeKeywords {
  readonly calls: { keywords: string[]; locationCode: number; languageCode?: string }[] = [];
  readonly volumes = new Map<string, number>();
  /** USD billed per request. */
  cost = 0.075;
  /** The next call answers with this instead. */
  failNext: { status: number; body: unknown } | null = null;

  reset(): void {
    this.calls.length = 0;
    this.failNext = null;
  }

  readonly fetch = ((input: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(this.answer(input, init))) as typeof fetch;

  private answer(input: string | URL | Request, init: RequestInit): Response {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url !== `${KEYWORDS_TEST.url}/v3/keywords_data/google_ads/search_volume/live`)
      return json(404, { status_code: 40400, status_message: 'Not Found.' });
    const auth = new Headers(init.headers).get('authorization') ?? '';
    const expected = `Basic ${Buffer.from(`${KEYWORDS_TEST.login}:${KEYWORDS_TEST.password}`).toString('base64')}`;
    if (auth !== expected)
      return json(401, { status_code: 40100, status_message: 'You are not authorized.' });
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return json(f.status, f.body);
    }
    const [task] = JSON.parse(typeof init.body === 'string' ? init.body : '[]') as {
      keywords: string[];
      location_code: number;
      language_code?: string;
    }[];
    this.calls.push({
      keywords: task!.keywords,
      locationCode: task!.location_code,
      ...(task!.language_code ? { languageCode: task!.language_code } : {}),
    });
    const result = task!.keywords.map((keyword) => {
      const v = this.volumes.get(keyword);
      return {
        keyword,
        spell: null,
        location_code: task!.location_code,
        language_code: null,
        search_partners: false,
        competition: v === undefined ? null : v > 1000 ? 'HIGH' : v > 100 ? 'MEDIUM' : 'LOW',
        competition_index: v === undefined ? null : Math.min(100, Math.round(v / 50)),
        search_volume: v ?? null,
        low_top_of_page_bid: v === undefined ? null : 0.02,
        high_top_of_page_bid: v === undefined ? null : 0.11,
        cpc: v === undefined ? null : 0.05,
        monthly_searches:
          v === undefined
            ? null
            : Array.from({ length: 12 }, (_, i) => ({
                year: 2026,
                month: 12 - i,
                search_volume: Math.round(v * (0.8 + i / 30)),
              })),
      };
    });
    return json(200, {
      version: '0.1.20251101',
      status_code: 20000,
      status_message: 'Ok.',
      time: '0.4 sec.',
      cost: this.cost,
      tasks_count: 1,
      tasks_error: 0,
      tasks: [
        {
          id: `task-${this.calls.length}`,
          status_code: 20000,
          status_message: 'Ok.',
          time: '0.3 sec.',
          cost: this.cost,
          result_count: result.length,
          path: ['v3', 'keywords_data', 'google_ads', 'search_volume', 'live'],
          data: { api: 'keywords_data', function: 'search_volume', se: 'google_ads' },
          result,
        },
      ],
    });
  }
}
