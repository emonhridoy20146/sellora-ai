/**
 * Plays Meta's Conversions API, TikTok's Events API and GA4's Measurement Protocol for ad
 * tracking tests (ADR 0030). It answers the documented endpoints with the documented response
 * shapes, refuses what those documents say is refused (an unknown token, an event older than
 * seven days, a website event without a user agent, personal details not hashed), and records
 * every call. This proves our side of each contract as documented; it does not prove the real
 * platforms behave so.
 */

export interface AdCall {
  platform: 'meta' | 'tiktok' | 'ga4';
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const META_ACTION_SOURCES = [
  'email',
  'website',
  'app',
  'phone_call',
  'chat',
  'physical_store',
  'system_generated',
  'business_messaging',
  'other',
];

export class FakeAdPlatforms {
  readonly calls: AdCall[] = [];
  /** Fake keys only: obviously not real. */
  readonly meta = {
    pixelId: '123456789012345',
    pixelName: 'Kumartuli Crafts Pixel',
    token: 'test-meta-capi-token-not-real-0001',
    testCode: 'TEST12345',
  };
  readonly tiktok = {
    pixelCode: 'CTESTPIXEL0000000001',
    token: 'test-tiktok-events-token-not-real-01',
    testCode: 'TEST67890',
  };
  readonly ga4 = { measurementId: 'G-TEST123456', secret: 'test-ga4-secret-not-real' };
  /** The next Meta event call answers a server error (a fault worth trying again). */
  failNextMeta = false;

  /** A fetch whose failures reject, as the real one's do. */
  readonly fetch: typeof fetch = (input, init) =>
    new Promise<Response>((resolve) => resolve(this.answer(input, init)));

  private answer(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Response {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    const query = Object.fromEntries(url.searchParams.entries());
    if (url.host === 'graph.facebook.com')
      return this.metaAnswer(url, method, query, headers, body);
    if (url.host === 'business-api.tiktok.com')
      return this.tiktokAnswer(url, method, query, headers, body);
    if (url.host === 'www.google-analytics.com')
      return this.ga4Answer(url, method, query, headers, body);
    throw new TypeError(`fetch failed: unexpected host ${url.host}`);
  }

  of(platform: AdCall['platform']): AdCall[] {
    return this.calls.filter((c) => c.platform === platform);
  }

  /** The events sent to a platform (Meta `data[]`, TikTok `data[]`, GA4 `events[]`). */
  events(platform: AdCall['platform']): Record<string, unknown>[] {
    return this.of(platform)
      .filter((c) => c.method === 'POST' && !c.path.startsWith('/debug'))
      .flatMap(
        (c) =>
          ((platform === 'ga4' ? c.body?.events : c.body?.data) ?? []) as Record<string, unknown>[],
      );
  }

  reset(): void {
    this.calls.length = 0;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private metaError(status: number, code: number, message: string): Response {
    return this.json(status, {
      error: { message, type: 'OAuthException', code, fbtrace_id: 'AbCdEf123' },
    });
  }

  private metaAnswer(
    url: URL,
    method: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: Record<string, unknown> | null,
  ): Response {
    this.calls.push({ platform: 'meta', method, path: url.pathname, query, headers, body });
    const m = /^\/v\d+\.\d+\/(\d+)(\/events)?$/.exec(url.pathname);
    if (!m) return this.metaError(400, 100, 'Unknown path components');
    if (query.access_token !== this.meta.token)
      return this.metaError(400, 190, 'Invalid OAuth access token - Cannot parse access token');
    if (m[1] !== this.meta.pixelId)
      return this.metaError(400, 100, `Object with ID '${m[1]}' does not exist`);
    if (!m[2] && method === 'GET') return this.json(200, { id: m[1], name: this.meta.pixelName });
    if (this.failNextMeta) {
      this.failNextMeta = false;
      return this.metaError(500, 2, 'An unexpected error has occurred. Please retry.');
    }
    const data = (body?.data ?? []) as Record<string, unknown>[];
    if (!Array.isArray(data) || !data.length || data.length > 1000)
      return this.metaError(400, 100, 'The parameter data is required');
    const now = Date.now() / 1000;
    for (const e of data) {
      const user = (e.user_data ?? {}) as Record<string, unknown>;
      if (typeof e.event_name !== 'string' || typeof e.event_time !== 'number')
        return this.metaError(400, 100, 'Invalid parameter: event_name and event_time');
      if (e.event_time < now - 7 * 24 * 3600 || e.event_time > now + 60)
        return this.metaError(400, 100, 'event_time is too far in the past or the future');
      if (!META_ACTION_SOURCES.includes(String(e.action_source)))
        return this.metaError(400, 100, 'Invalid action_source');
      if (e.action_source === 'website' && typeof user.client_user_agent !== 'string')
        return this.metaError(400, 100, 'client_user_agent is required for website events');
      for (const k of ['em', 'ph', 'fn', 'ln', 'ct', 'country', 'external_id'])
        if (
          user[k] !== undefined &&
          !(Array.isArray(user[k]) && (user[k] as unknown[]).every((v) => HEX64.test(String(v))))
        )
          return this.metaError(400, 100, `user_data.${k} must be hashed`);
    }
    return this.json(200, { events_received: data.length, messages: [], fbtrace_id: 'AbCdEf123' });
  }

  private tiktokAnswer(
    url: URL,
    method: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: Record<string, unknown> | null,
  ): Response {
    this.calls.push({ platform: 'tiktok', method, path: url.pathname, query, headers, body });
    const ok = (extra: Record<string, unknown> = {}) =>
      this.json(200, { code: 0, message: 'OK', request_id: 'req-1', data: {}, ...extra });
    const no = (code: number, message: string) =>
      this.json(200, { code, message, request_id: 'req-1', data: {} });
    if (url.pathname !== '/open_api/v1.3/event/track/' || method !== 'POST')
      return this.json(404, { code: 40400, message: 'Not found' });
    if (headers['access-token'] !== this.tiktok.token)
      return no(40001, 'Access token is invalid or has expired');
    if (body?.event_source !== 'web' || body.event_source_id !== this.tiktok.pixelCode)
      return no(40002, 'event_source_id is invalid');
    const data = (body.data ?? []) as Record<string, unknown>[];
    if (!Array.isArray(data) || !data.length) return no(40002, 'data is required');
    for (const e of data) {
      const user = (e.user ?? {}) as Record<string, unknown>;
      if (typeof e.event !== 'string' || typeof e.event_time !== 'number')
        return no(40002, 'event and event_time are required');
      for (const k of ['email', 'phone', 'external_id'])
        if (user[k] !== undefined && !(typeof user[k] === 'string' && HEX64.test(user[k])))
          return no(40002, `user.${k} must be SHA-256 hashed`);
    }
    return ok();
  }

  private ga4Answer(
    url: URL,
    method: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: Record<string, unknown> | null,
  ): Response {
    this.calls.push({ platform: 'ga4', method, path: url.pathname, query, headers, body });
    const problems: { description: string; fieldPath: string; validationCode: string }[] = [];
    if (query.measurement_id !== this.ga4.measurementId)
      problems.push({
        description: 'Unable to find the measurement_id.',
        fieldPath: 'measurement_id',
        validationCode: 'VALUE_INVALID',
      });
    if (typeof body?.client_id !== 'string' || !body.client_id)
      problems.push({
        description: 'Measurement requires a client_id.',
        fieldPath: 'client_id',
        validationCode: 'VALUE_REQUIRED',
      });
    const events = (body?.events ?? []) as Record<string, unknown>[];
    if (!Array.isArray(events) || !events.length || events.length > 25)
      problems.push({
        description: 'Measurement requires 1 to 25 events.',
        fieldPath: 'events',
        validationCode: 'VALUE_INVALID',
      });
    if (url.pathname === '/debug/mp/collect')
      return this.json(200, { validationMessages: problems });
    // The real collect endpoint takes anything (even a wrong secret) and answers 204.
    return new Response(null, { status: 204 });
  }
}
