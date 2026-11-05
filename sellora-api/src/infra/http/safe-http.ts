import { Injectable } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { AppConfig } from '../../config/app-config.js';

/**
 * Requests to addresses a merchant typed in: their shop's API, a sheet, product photos
 * (ADR 0023). Only http(s) on the default ports, never a private or local address (checked
 * on the address actually connected to, so a DNS answer cannot change between the check and
 * the connection), at most 5 redirects, each checked again, and capped in size and time.
 * Headers that carry credentials are dropped when a redirect leaves the first origin.
 */

export type SafeHttpErrorReason =
  | 'bad_url'
  | 'blocked_address'
  | 'dns'
  | 'network'
  | 'timeout'
  | 'too_large'
  | 'too_many_redirects';

export class SafeHttpError extends Error {
  constructor(
    readonly reason: SafeHttpErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'SafeHttpError';
  }
}

export interface SafeRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  maxBytes: number;
  /** Defaults to SYNC_HTTP_TIMEOUT_MS. Covers the whole request, redirects included. */
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
  /** The address that answered, after redirects. */
  url: string;
  text(): string;
  json<T = unknown>(): T;
}

/** Headers that may follow a redirect to another origin. */
const PORTABLE_HEADERS = new Set(['accept', 'accept-language', 'user-agent']);
const USER_AGENT = 'Sellora-Sync/1.0';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** Whether an IP address is on the public internet (not private, local, reserved or mapped). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms: judge the IPv4 address.
  const mapped = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (/^::ffff:/.test(lower)) return false;
  return !blocked.check(lower, 'ipv6');
}

function decoded(res: IncomingMessage): NodeJS.ReadableStream {
  switch ((res.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

function flatHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

@Injectable()
export class SafeHttp {
  constructor(private readonly config: AppConfig) {}

  private get allowPrivate(): boolean {
    return this.config.get('SYNC_ALLOW_PRIVATE_NETWORK');
  }

  /** Checks a URL a merchant typed before it is saved. Throws SafeHttpError('bad_url'). */
  parseUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SafeHttpError('bad_url', 'This is not a web address.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new SafeHttpError('bad_url', 'Only http and https addresses can be used.');
    if (url.username || url.password)
      throw new SafeHttpError('bad_url', 'Addresses with a user name or password are not allowed.');
    if (!this.allowPrivate) {
      if (url.protocol !== 'https:') throw new SafeHttpError('bad_url', 'Use an https:// address.');
      if (url.port && url.port !== '443')
        throw new SafeHttpError('bad_url', 'Only the standard https port can be used.');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && !isPublicAddress(host))
        throw new SafeHttpError('blocked_address', 'This address is not on the public internet.');
      if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.'))
        throw new SafeHttpError('blocked_address', 'This address is not on the public internet.');
    }
    return url;
  }

  /** Resolves the host and returns the one address to connect to, or throws. */
  private async resolve(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
    const host = hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host);
    let answers: { address: string; family: number }[];
    if (literal) answers = [{ address: host, family: literal }];
    else {
      try {
        answers = await dnsLookup(host, { all: true, verbatim: true });
      } catch {
        throw new SafeHttpError('dns', `${host} could not be found.`);
      }
    }
    if (!answers.length) throw new SafeHttpError('dns', `${host} could not be found.`);
    if (!this.allowPrivate && answers.some((a) => !isPublicAddress(a.address)))
      throw new SafeHttpError('blocked_address', `${host} is not on the public internet.`);
    const first = answers[0]!;
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
  }

  async request(rawUrl: string, req: SafeRequest): Promise<SafeResponse> {
    const timeoutMs = req.timeoutMs ?? this.config.get('SYNC_HTTP_TIMEOUT_MS');
    const deadline = Date.now() + timeoutMs;
    const maxRedirects = req.maxRedirects ?? 5;
    let url = this.parseUrl(rawUrl);
    const firstOrigin = url.origin;
    let method = req.method ?? 'GET';
    let body = req.body;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        'accept-encoding': 'gzip, deflate, br',
      };
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        const key = k.toLowerCase();
        if (url.origin === firstOrigin || PORTABLE_HEADERS.has(key)) headers[key] = v;
      }
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const res = await this.once(url, { method, headers, body }, req.maxBytes, deadline);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= maxRedirects)
          throw new SafeHttpError('too_many_redirects', 'The address redirected too many times.');
        url = this.parseUrl(new URL(res.headers.location, url).toString());
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      return res;
    }
  }

  private async once(
    url: URL,
    opts: { method: string; headers: Record<string, string>; body?: string },
    maxBytes: number,
    deadline: number,
  ): Promise<SafeResponse> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeHttpError('timeout', 'The address took too long to answer.');
    const target = await this.resolve(url.hostname);
    const pinned: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all)
        (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
          { address: target.address, family: target.family },
        ]);
      else cb(null, target.address, target.family);
    };
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise<SafeResponse>((resolve, reject) => {
      let settled = false;
      const fail = (err: SafeHttpError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.destroy();
        reject(err);
      };
      const request = lib.request(
        url,
        { method: opts.method, headers: opts.headers, lookup: pinned, agent: false },
        (res) => {
          // The socket's peer is the address we checked; refuse anything else.
          const peer = res.socket.remoteAddress;
          if (!this.allowPrivate && peer && !isPublicAddress(peer)) {
            fail(
              new SafeHttpError('blocked_address', 'The address is not on the public internet.'),
            );
            return;
          }
          const declared = Number(res.headers['content-length'] ?? NaN);
          if (Number.isFinite(declared) && declared > maxBytes) {
            fail(new SafeHttpError('too_large', 'The answer is larger than allowed.'));
            return;
          }
          const status = res.statusCode ?? 0;
          const headers = flatHeaders(res);
          if (status >= 300 && status < 400 && headers.location) {
            res.resume();
            settled = true;
            clearTimeout(timer);
            resolve(response(status, headers, Buffer.alloc(0), url));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const stream = decoded(res);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              fail(new SafeHttpError('too_large', 'The answer is larger than allowed.'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(response(status, headers, Buffer.concat(chunks), url));
          });
          stream.on('error', () =>
            fail(new SafeHttpError('network', 'The answer could not be read.')),
          );
        },
      );
      const timer = setTimeout(
        () => fail(new SafeHttpError('timeout', 'The address took too long to answer.')),
        remaining,
      );
      request.on('error', (err: NodeJS.ErrnoException) =>
        fail(
          new SafeHttpError(
            'network',
            err.code === 'ECONNREFUSED'
              ? `${url.host} refused the connection.`
              : `${url.host} could not be reached (${err.code ?? err.message}).`,
          ),
        ),
      );
      if (opts.body !== undefined) request.write(opts.body);
      request.end();
    });
  }
}

function response(
  status: number,
  headers: Record<string, string>,
  bytes: Buffer,
  url: URL,
): SafeResponse {
  return {
    status,
    headers,
    bytes,
    url: url.toString(),
    text: () => bytes.toString('utf8'),
    json: <T>() => JSON.parse(bytes.toString('utf8')) as T,
  };
}
