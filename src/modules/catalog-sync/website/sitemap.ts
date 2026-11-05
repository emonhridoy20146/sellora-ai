import { gunzipSync } from 'node:zlib';
import { decodeEntities } from '../../../common/text/html-text.js';

/**
 * XML sitemaps (sitemaps.org): a `urlset` lists pages, a `sitemapindex` lists more sitemaps.
 * Read with a small pattern reader: sitemaps are flat and machine-written, and only `loc` and
 * `lastmod` matter here.
 */

export interface SitemapEntry {
  loc: string;
  /** Milliseconds since 1970, when the entry has a readable `lastmod`. */
  lastmod: number | null;
}

export interface Sitemap {
  kind: 'urlset' | 'index';
  entries: SitemapEntry[];
}

/** One sitemap file may be this big once unpacked (the protocol's limit is 50 MB). */
export const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;

/** The file's text, unpacking a `.gz` sitemap (sent as a file, not as content-encoding). */
export function sitemapText(bytes: Buffer): string {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    return gunzipSync(bytes, { maxOutputLength: SITEMAP_MAX_BYTES }).toString('utf8');
  return bytes.toString('utf8');
}

function field(block: string, name: string): string | null {
  const m = new RegExp(
    `<(?:[a-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`,
    'i',
  ).exec(block);
  if (!m) return null;
  const value = m[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
  return decodeEntities(value);
}

/** Parses a sitemap; null when the text is not one. */
export function parseSitemap(text: string): Sitemap | null {
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  const isIndex = /<(?:[a-z0-9]+:)?sitemapindex\b/i.test(body);
  if (!isIndex && !/<(?:[a-z0-9]+:)?urlset\b/i.test(body)) return null;
  const tag = isIndex ? 'sitemap' : 'url';
  const entries: SitemapEntry[] = [];
  const re = new RegExp(
    `<(?:[a-z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${tag}>`,
    'gi',
  );
  for (const m of body.matchAll(re)) {
    const loc = field(m[1]!, 'loc');
    if (!loc) continue;
    const raw = field(m[1]!, 'lastmod');
    const at = raw ? Date.parse(raw) : NaN;
    entries.push({ loc, lastmod: Number.isFinite(at) ? at : null });
  }
  return { kind: isIndex ? 'index' : 'urlset', entries };
}
