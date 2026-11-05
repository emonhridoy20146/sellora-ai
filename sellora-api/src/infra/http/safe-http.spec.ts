import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/app-config.js';
import { isPublicAddress, SafeHttp, SafeHttpError } from './safe-http.js';

const dns = vi.hoisted(() => ({
  answers: new Map<string, { address: string; family: number }[]>(),
}));
vi.mock('node:dns/promises', () => ({
  lookup: (host: string) => {
    const a = dns.answers.get(host);
    return a ? Promise.resolve(a) : Promise.reject(new Error('ENOTFOUND'));
  },
}));

const configWith = (allowPrivate: boolean) =>
  ({
    get: (key: string) =>
      key === 'SYNC_ALLOW_PRIVATE_NETWORK'
        ? allowPrivate
        : key === 'SYNC_HTTP_TIMEOUT_MS'
          ? 5_000
          : undefined,
  }) as unknown as AppConfig;

const strict = new SafeHttp(configWith(false));
const local = new SafeHttp(configWith(true));

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SafeHttpError) return err.reason;
    throw err;
  }
  return 'ok';
}

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['2606:4700:4700::1111', true],
    ['::ffff:8.8.8.8', true],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['::', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:10.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['64:ff9b::a00:1', false],
    ['shop.example.com', false],
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe('SafeHttp.parseUrl (production rules)', () => {
  it('accepts an https address on the standard port', () => {
    expect(strict.parseUrl('https://nakshi.myshopify.com/admin').hostname).toBe(
      'nakshi.myshopify.com',
    );
    expect(strict.parseUrl('https://shop.example.com:443/x').port).toBe('');
  });

  it.each([
    ['not a url', 'bad_url'],
    ['ftp://shop.example.com/file', 'bad_url'],
    ['http://shop.example.com/', 'bad_url'],
    ['https://shop.example.com:8443/', 'bad_url'],
    ['https://admin:secret@shop.example.com/', 'bad_url'],
    ['https://localhost/', 'blocked_address'],
    ['https://api.localhost/', 'blocked_address'],
    ['https://intranet/', 'blocked_address'],
    ['https://192.168.0.10/', 'blocked_address'],
    ['https://169.254.169.254/latest/meta-data', 'blocked_address'],
    ['https://[::1]/', 'blocked_address'],
    ['https://[::ffff:127.0.0.1]/', 'blocked_address'],
  ])('refuses %s (%s)', (url, expected) => {
    expect(() => strict.parseUrl(url)).toThrowError(
      expect.objectContaining({ reason: expected }) as Error,
    );
  });

  it('allows a local address only when the private network is allowed (tests, development)', () => {
    expect(local.parseUrl('http://127.0.0.1:4090/x').port).toBe('4090');
    expect(() => local.parseUrl('file:///etc/passwd')).toThrowError(SafeHttpError);
  });
});

describe('SafeHttp.request: the address actually connected to is checked', () => {
  beforeEach(() => dns.answers.clear());

  it('refuses a name that resolves to a private address', async () => {
    dns.answers.set('shop.example.com', [{ address: '10.0.0.5', family: 4 }]);
    expect(await reason(strict.request('https://shop.example.com/', { maxBytes: 1000 }))).toBe(
      'blocked_address',
    );
  });

  it('refuses when any of the answers is private (no picking the public one)', async () => {
    dns.answers.set('mixed.example.com', [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    expect(await reason(strict.request('https://mixed.example.com/', { maxBytes: 1000 }))).toBe(
      'blocked_address',
    );
  });

  it('says when a name cannot be found', async () => {
    expect(await reason(strict.request('https://nowhere.example.com/', { maxBytes: 1000 }))).toBe(
      'dns',
    );
  });
});

describe('SafeHttp.request against a local server', () => {
  let a: Server;
  let b: Server;
  let baseA = '';
  let baseB = '';
  const seen: {
    path: string;
    method: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[] = [];

  const handler =
    (name: 'a' | 'b') =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const path = req.url ?? '/';
      seen.push({
        path: `${name}${path}`,
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (path === '/to-other') {
        res.writeHead(302, { location: `${baseB}/landed` });
        return void res.end();
      }
      if (path === '/to-same') {
        res.writeHead(301, { location: '/landed' });
        return void res.end();
      }
      if (path === '/see-other') {
        res.writeHead(303, { location: '/landed' });
        return void res.end();
      }
      if (path === '/loop') {
        res.writeHead(302, { location: '/loop' });
        return void res.end();
      }
      if (path === '/big-declared') {
        res.writeHead(200, { 'content-length': '5000' });
        return void res.end('x'.repeat(5000));
      }
      if (path === '/big-streamed') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        for (let i = 0; i < 10; i++) res.write('y'.repeat(500));
        return void res.end();
      }
      if (path === '/gzip') {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
        return void res.end(gzipSync(JSON.stringify({ hello: 'ঢাকা' })));
      }
      if (path === '/slow') return; // never answers
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${name} ok`);
    };

  beforeAll(async () => {
    a = createServer((req, res) => void handler('a')(req, res));
    b = createServer((req, res) => void handler('b')(req, res));
    await Promise.all(
      [a, b].map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))),
    );
    baseA = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
    baseB = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    a.closeAllConnections();
    await Promise.all([a, b].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  const secrets = {
    authorization: 'Basic c2VjcmV0',
    'x-shopify-access-token': 'shpat_secret',
    accept: 'application/json',
  };

  it('drops credentials when a redirect leaves the first origin, keeps harmless headers', async () => {
    const res = await local.request(`${baseA}/to-other`, { headers: secrets, maxBytes: 1000 });
    expect(res.text()).toBe('b ok');
    expect(res.url).toBe(`${baseB}/landed`);
    const landed = seen.find((s) => s.path === 'b/landed')!;
    expect(landed.headers.authorization).toBeUndefined();
    expect(landed.headers['x-shopify-access-token']).toBeUndefined();
    expect(landed.headers.accept).toBe('application/json');
    expect(landed.headers['user-agent']).toBe('Sellora-Sync/1.0');
  });

  it('keeps credentials on a redirect within the same origin', async () => {
    await local.request(`${baseA}/to-same`, { headers: secrets, maxBytes: 1000 });
    const landed = seen.find((s) => s.path === 'a/landed')!;
    expect(landed.headers.authorization).toBe('Basic c2VjcmV0');
    expect(landed.headers['x-shopify-access-token']).toBe('shpat_secret');
  });

  it('turns a POST into a GET without a body after a 303', async () => {
    await local.request(`${baseA}/see-other`, {
      method: 'POST',
      body: '{"q":1}',
      headers: { 'content-type': 'application/json' },
      maxBytes: 1000,
    });
    expect(seen.map((s) => [s.path, s.method, s.body])).toEqual([
      ['a/see-other', 'POST', '{"q":1}'],
      ['a/landed', 'GET', ''],
    ]);
  });

  it('stops after too many redirects', async () => {
    expect(await reason(local.request(`${baseA}/loop`, { maxBytes: 1000, maxRedirects: 3 }))).toBe(
      'too_many_redirects',
    );
    expect(seen).toHaveLength(4);
  });

  it('refuses an answer larger than allowed, declared or streamed', async () => {
    expect(await reason(local.request(`${baseA}/big-declared`, { maxBytes: 1000 }))).toBe(
      'too_large',
    );
    expect(await reason(local.request(`${baseA}/big-streamed`, { maxBytes: 1000 }))).toBe(
      'too_large',
    );
  });

  it('decodes a gzip answer', async () => {
    const res = await local.request(`${baseA}/gzip`, { maxBytes: 1000 });
    expect(res.json()).toEqual({ hello: 'ঢাকা' });
  });

  it('gives up on an address that does not answer in time', async () => {
    const started = Date.now();
    expect(await reason(local.request(`${baseA}/slow`, { maxBytes: 1000, timeoutMs: 300 }))).toBe(
      'timeout',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('says when nothing listens at the address', async () => {
    expect(await reason(local.request('http://127.0.0.1:1/', { maxBytes: 1000 }))).toBe('network');
  });
});
