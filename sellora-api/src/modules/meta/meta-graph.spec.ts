import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.js';
import { classifyGraphError, MetaGraph, MetaGraphError, MetaMediaError } from './meta-graph.js';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as AppConfig;

/** A fetch stand-in; the cast keeps the tests free of the full fetch signature. */
const fakeFetch = (fn: (url: string, init: RequestInit) => Response): typeof fetch =>
  ((url: string, init: RequestInit) => {
    try {
      return Promise.resolve(fn(url, init));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }) as unknown as typeof fetch;

const env = {
  META_APP_ID: '1234567890',
  META_APP_SECRET: 'app-secret-for-tests',
  META_GRAPH_VERSION: 'v23.0',
  META_GRAPH_BASE_URL: 'http://graph.test',
};

describe('classifyGraphError', () => {
  const kind = (status: number, error: Record<string, unknown>) =>
    classifyGraphError(status, { error }).kind;

  it('sorts Meta errors by code, never by message text', () => {
    expect(kind(400, { code: 190, type: 'OAuthException', message: 'expired' })).toBe('auth');
    expect(kind(403, { code: 200, message: 'permission' })).toBe('auth');
    expect(kind(400, { code: 10, error_subcode: 2018278, message: 'window' })).toBe(
      'outside_window',
    );
    expect(kind(400, { code: 131047, message: 'Re-engagement message' })).toBe('outside_window');
    expect(kind(400, { code: 4, message: 'app limit' })).toBe('rate_limited');
    // Meta calls nearly everything an OAuthException; the code decides.
    expect(kind(400, { code: 613, type: 'OAuthException', message: 'rate' })).toBe('rate_limited');
    expect(kind(400, { code: 100, type: 'OAuthException', message: 'param' })).toBe('bad_request');
    expect(kind(400, { code: 613, message: 'calls' })).toBe('rate_limited');
    expect(kind(400, { code: 131056, message: 'pair rate' })).toBe('rate_limited');
    expect(kind(400, { code: 2, message: 'temporary' })).toBe('transient');
    expect(kind(400, { code: 100, is_transient: true, message: 'x' })).toBe('transient');
    expect(kind(503, {})).toBe('transient');
    expect(kind(400, { code: 100, message: 'Invalid parameter' })).toBe('bad_request');
  });

  it('marks only rate limits, outages and network trouble as worth retrying', () => {
    expect(new MetaGraphError('rate_limited', 'x').retryable).toBe(true);
    expect(new MetaGraphError('transient', 'x').retryable).toBe(true);
    expect(new MetaGraphError('network', 'x').retryable).toBe(true);
    expect(new MetaGraphError('auth', 'x').retryable).toBe(false);
    expect(new MetaGraphError('outside_window', 'x').retryable).toBe(false);
    expect(new MetaGraphError('bad_request', 'x').retryable).toBe(false);
  });
});

describe('MetaGraph', () => {
  it('sends the token as a bearer header with appsecret_proof, on the configured version', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const graph = new MetaGraph(
      config(env),
      fakeFetch((url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ message_id: 'm_1' }), { status: 200 });
      }),
    );
    const res = await graph.post<{ message_id: string }>('123/messages', 'PAGE_TOKEN', { a: 1 });
    expect(res.message_id).toBe('m_1');
    const url = new URL(seen[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('http://graph.test/v23.0/123/messages');
    expect(url.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', env.META_APP_SECRET).update('PAGE_TOKEN').digest('hex'),
    );
    expect(url.searchParams.has('access_token')).toBe(false);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer PAGE_TOKEN');
    expect(seen[0]!.init.body).toBe('{"a":1}');
  });

  it('turns error responses and network failures into classified errors', async () => {
    const failing = new MetaGraph(
      config(env),
      fakeFetch(
        () =>
          new Response(JSON.stringify({ error: { code: 190, message: 'Session expired' } }), {
            status: 400,
          }),
      ),
    );
    await expect(failing.get('me', 'T')).rejects.toMatchObject({ kind: 'auth', code: 190 });

    const offline = new MetaGraph(
      config(env),
      fakeFetch(() => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(offline.get('me', 'T')).rejects.toMatchObject({ kind: 'network' });
  });

  it('exchanges a login code for a long-lived token', async () => {
    const urls: string[] = [];
    const graph = new MetaGraph(
      config(env),
      fakeFetch((url) => {
        urls.push(url);
        const grant = new URL(url).searchParams.get('grant_type');
        return new Response(
          JSON.stringify({ access_token: grant === 'fb_exchange_token' ? 'LONG' : 'SHORT' }),
        );
      }),
    );
    expect(await graph.userTokenFromCode('CODE', 'https://app.test/app/connect/meta')).toBe('LONG');
    expect(new URL(urls[0]!).searchParams.get('redirect_uri')).toBe(
      'https://app.test/app/connect/meta',
    );
    expect(new URL(urls[1]!).searchParams.get('fb_exchange_token')).toBe('SHORT');
  });

  it('reports that it is not set up without an app id and secret', async () => {
    const graph = new MetaGraph(
      config({ META_GRAPH_VERSION: 'v23.0' }),
      fakeFetch(() => {
        throw new Error('must not be called');
      }),
    );
    expect(graph.configured()).toBe(false);
    expect(() => graph.appId()).toThrow(MetaGraphError);
    await expect(graph.get('me', 'T')).rejects.toMatchObject({ kind: 'not_configured' });
  });
});

describe('MetaGraph.download', () => {
  const CDN = 'https://scontent.xx.fbcdn.net/v/t1.15752-9/photo.jpg?_nc_oc=abc';
  const graphWith = (fn: (url: string, init: RequestInit) => Response) =>
    new MetaGraph(config(env), fakeFetch(fn));
  const bytes = (n: number) => new Response(new Uint8Array(n), { status: 200 });

  it('accepts only Meta’s media hosts over https, and the configured Graph API origin', () => {
    const graph = graphWith(() => bytes(1));
    expect(graph.isMediaUrl(CDN)).toBe(true);
    expect(
      graph.isMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'),
    ).toBe(true);
    expect(graph.isMediaUrl('https://scontent-sin6-1.cdninstagram.com/v/a.jpg')).toBe(true);
    expect(graph.isMediaUrl('http://graph.test/__media/1')).toBe(true);
    expect(graph.isMediaUrl('http://scontent.xx.fbcdn.net/photo.jpg')).toBe(false);
    expect(graph.isMediaUrl('https://fbcdn.net.evil.example/photo.jpg')).toBe(false);
    expect(graph.isMediaUrl('https://evilfbcdn.net/photo.jpg')).toBe(false);
    expect(graph.isMediaUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(graph.isMediaUrl('not a url')).toBe(false);
  });

  it('refuses other hosts without fetching them', async () => {
    let calls = 0;
    const graph = graphWith(() => {
      calls += 1;
      return bytes(1);
    });
    await expect(
      graph.download('https://example.com/a.jpg', { maxBytes: 100 }),
    ).rejects.toMatchObject({ reason: 'host_not_allowed' });
    expect(calls).toBe(0);
  });

  it('follows redirects only while they stay on Meta, and sends the token to the first link only', async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const graph = graphWith((url, init) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
      if (url === CDN)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://video.xx.fbcdn.net/final.jpg' },
        });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg; charset=binary' },
      });
    });
    const out = await graph.download(CDN, { token: 'TOKEN', maxBytes: 100 });
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.contentType).toBe('image/jpeg');
    expect(seen).toEqual([
      { url: CDN, auth: 'Bearer TOKEN' },
      { url: 'https://video.xx.fbcdn.net/final.jpg', auth: undefined },
    ]);

    const away = graphWith(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: 'http://10.0.0.5/internal' },
        }),
    );
    await expect(away.download(CDN, { maxBytes: 100 })).rejects.toMatchObject({
      reason: 'host_not_allowed',
    });
    const loop = graphWith(() => new Response(null, { status: 302, headers: { location: CDN } }));
    await expect(loop.download(CDN, { maxBytes: 100 })).rejects.toBeInstanceOf(MetaMediaError);
  });

  it('stops at the size limit, whether declared or streamed', async () => {
    const declared = graphWith(
      () => new Response(new Uint8Array(10), { headers: { 'content-length': '5000' } }),
    );
    await expect(declared.download(CDN, { maxBytes: 1000 })).rejects.toMatchObject({
      reason: 'too_large',
    });
    // No content-length: counted while reading.
    const streamed = graphWith(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(400));
              c.close();
            },
          }),
        ),
    );
    await expect(streamed.download(CDN, { maxBytes: 1000 })).rejects.toMatchObject({
      reason: 'too_large',
    });
    expect(
      (await graphWith(() => bytes(1000)).download(CDN, { maxBytes: 1000 })).bytes,
    ).toHaveLength(1000);
  });

  it('tells a gone file from a refusal, a rate limit and an outage', async () => {
    const status = (code: number) => graphWith(() => new Response('x', { status: code }));
    await expect(status(403).download(CDN, { maxBytes: 9 })).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(status(404).download(CDN, { maxBytes: 9 })).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(status(401).download(CDN, { maxBytes: 9 })).rejects.toMatchObject({
      kind: 'auth',
    });
    await expect(status(429).download(CDN, { maxBytes: 9 })).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    await expect(status(502).download(CDN, { maxBytes: 9 })).rejects.toMatchObject({
      kind: 'transient',
    });
    const offline = graphWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(offline.download(CDN, { maxBytes: 9 })).rejects.toMatchObject({
      kind: 'network',
    });
  });
});
