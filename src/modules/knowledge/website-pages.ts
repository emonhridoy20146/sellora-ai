import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Schema, Types, type AnyBulkWriteOperation, type Model } from 'mongoose';
import { tenantSchema, type WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';

/**
 * Pages of a business's own website kept for the AI sales agent (ADR 0024): title,
 * description and main text, found by a language-neutral text search.
 */

export interface WebsitePage {
  orgId: Types.ObjectId;
  sourceId: Types.ObjectId;
  /** Path and query on the site. */
  key: string;
  url: string;
  title: string;
  description: string;
  text: string;
  words: number;
  lang?: string;
  /** Of title, description and text: a new hash is a changed page. */
  hash: string;
  /** The crawl that last read the page. */
  runId: Types.ObjectId;
  crawledAt: Date;
  changedAt: Date;
}

export type WebsitePageDoc = WithId<WebsitePage>;

export const websitePageSchema = tenantSchema<WebsitePage>(
  {
    sourceId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    url: { type: String, required: true },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    text: { type: String, default: '' },
    words: { type: Number, default: 0 },
    lang: String,
    hash: { type: String, required: true },
    runId: { type: Schema.Types.ObjectId, required: true },
    crawledAt: { type: Date, required: true },
    changedAt: { type: Date, required: true },
  },
  { collection: 'website_pages' },
);
websitePageSchema.index({ orgId: 1, sourceId: 1, key: 1 }, { unique: true });
// Language "none": no stemming or stop words, so Bangla, Banglish and English words match as
// written. The orgId prefix keeps every search inside one business.
websitePageSchema.index(
  { orgId: 1, title: 'text', description: 'text', text: 'text' },
  {
    name: 'website_pages_text',
    default_language: 'none',
    language_override: 'textSearchLanguage',
    weights: { title: 8, description: 4, text: 1 },
  },
);

export interface PageInput {
  key: string;
  url: string;
  title: string;
  description: string;
  text: string;
  words: number;
  lang: string | null;
}

export interface PageSaveCounts {
  added: number;
  changed: number;
  unchanged: number;
}

export interface PageHit {
  url: string;
  title: string;
  passages: string;
}

/** Characters of matching text a search returns per page. */
export const PASSAGE_CHARS = 900;

export const pageHash = (p: Pick<PageInput, 'title' | 'description' | 'text'>): string =>
  createHash('sha256')
    .update(JSON.stringify([p.title, p.description, p.text]))
    .digest('base64url')
    .slice(0, 32);

/** The words of a search, lower-cased, without punctuation; at most 8. */
export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s\u00a0।,.;:!?()[\]{}"'“”‘’/\\|+*-]+/u)
        .filter((w) => w.length >= 2 && /[\p{L}\p{N}]/u.test(w)),
    ),
  ].slice(0, 8);
}

/**
 * The lines of a page that match the search best, in page order, up to `max` characters,
 * with "…" where lines were left out. The page's first lines when nothing matches.
 */
export function passages(text: string, terms: string[], max = PASSAGE_CHARS): string {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return '';
  const scored = lines.map((line, i) => {
    const lower = line.toLowerCase();
    return { i, line, score: terms.filter((t) => lower.includes(t)).length };
  });
  const picked = new Set<number>();
  let used = 0;
  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const take = (i: number) => {
    const len = Math.min(lines[i]!.length, max) + 2;
    if (picked.has(i) || used + len > max) return false;
    picked.add(i);
    used += len;
    return true;
  };
  for (const s of ranked) {
    take(s.i);
    // A heading's answer is usually the next line.
    if (isHeading(s.line) && s.i + 1 < lines.length) take(s.i + 1);
    if (used >= max) break;
  }
  if (!picked.size) for (let i = 0; i < lines.length && take(i); i++);
  if (!picked.size) return lines[0]!.slice(0, max);
  const order = [...picked].sort((a, b) => a - b);
  let out = '';
  order.forEach((i, n) => {
    if (n > 0) out += order[n - 1] === i - 1 ? '\n' : '\n…\n';
    out += lines[i]!.slice(0, max);
  });
  const tail = order[order.length - 1]! < lines.length - 1 ? '\n…' : '';
  return (order[0]! > 0 ? '…\n' : '') + out + tail;
}

/** A short line that does not end a sentence: "Returns", "ফেরত নীতি", "Delivery charges". */
const isHeading = (line: string): boolean =>
  line.length <= 60 && !/[.!?।:;,]$/u.test(line.trim()) && line.split(/\s+/).length <= 8;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class WebsitePageRepository extends TenantScopedRepository<WebsitePage> {
  constructor(@InjectModel('WebsitePage') model: Model<WebsitePage>) {
    super(model);
  }

  /** Upserts pages in one round trip. */
  async upsertMany(ops: { key: string; sourceId: Types.ObjectId; set: Partial<WebsitePage> }[]) {
    if (!ops.length) return;
    const orgId = this.orgId();
    const writes: AnyBulkWriteOperation<WebsitePage>[] = ops.map((o) => ({
      updateOne: {
        filter: { orgId, sourceId: o.sourceId, key: o.key },
        update: { $set: o.set },
        upsert: true,
      },
    }));
    await this.model.bulkWrite(writes, { ordered: false });
  }

  /** Text search with the score, best first. */
  async textSearch(query: string, limit: number) {
    return this.model
      .find(this.scope({ $text: { $search: query } }), {
        score: { $meta: 'textScore' },
        url: 1,
        title: 1,
        text: 1,
      })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean<(WebsitePageDoc & { score: number })[]>()
      .exec();
  }
}

/** Saving, removing and searching a business's website pages. */
@Injectable()
export class WebsitePagesService {
  constructor(private readonly pages: WebsitePageRepository) {}

  /** Saves what a crawl read; counts new and changed pages by their hash. */
  async save(
    sourceId: Types.ObjectId,
    runId: Types.ObjectId,
    input: PageInput[],
    at = new Date(),
  ): Promise<PageSaveCounts> {
    const counts: PageSaveCounts = { added: 0, changed: 0, unchanged: 0 };
    if (!input.length) return counts;
    const existing = new Map(
      (
        await this.pages.find(
          { sourceId, key: { $in: input.map((p) => p.key) } },
          { projection: { key: 1, hash: 1 } },
        )
      ).map((p) => [p.key, p.hash]),
    );
    const ops = input.map((p) => {
      const hash = pageHash(p);
      const before = existing.get(p.key);
      if (before === undefined) counts.added += 1;
      else if (before !== hash) counts.changed += 1;
      else counts.unchanged += 1;
      const set: Partial<WebsitePage> = {
        url: p.url,
        title: p.title,
        description: p.description,
        text: p.text,
        words: p.words,
        hash,
        runId,
        crawledAt: at,
        ...(p.lang ? { lang: p.lang } : {}),
        ...(before !== hash ? { changedAt: at } : {}),
      };
      return { key: p.key, sourceId, set };
    });
    await this.pages.upsertMany(ops);
    return counts;
  }

  /** Removes pages a crawl found gone. */
  remove(sourceId: Types.ObjectId, keys: string[]): Promise<number> {
    if (!keys.length) return Promise.resolve(0);
    return this.pages.deleteMany({ sourceId, key: { $in: keys } });
  }

  /** After a crawl that read the whole site: removes pages it did not see. */
  removeUnseen(sourceId: Types.ObjectId, runId: Types.ObjectId): Promise<number> {
    return this.pages.deleteMany({ sourceId, runId: { $ne: runId } });
  }

  removeSource(sourceId: Types.ObjectId): Promise<number> {
    return this.pages.deleteMany({ sourceId });
  }

  count(sourceId?: Types.ObjectId): Promise<number> {
    return this.pages.count(sourceId ? { sourceId } : {});
  }

  /** Pages per source, for the sources list. */
  async countsBySource(): Promise<Map<string, number>> {
    const rows = await this.pages.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $group: { _id: '$sourceId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id.toHexString(), r.n]));
  }

  /** For the agent's prompt: how many pages, on which sites, and some of their titles. */
  async summary(maxTitles = 15): Promise<{ count: number; hosts: string[]; titles: string[] }> {
    const count = await this.pages.count({});
    if (!count) return { count: 0, hosts: [], titles: [] };
    const sample = await this.pages.find(
      {},
      { projection: { url: 1, title: 1 }, sort: { words: -1 }, limit: 200 },
    );
    const hosts = [...new Set(sample.map((p) => new URL(p.url).host))];
    const titles = [...new Set(sample.map((p) => p.title.trim()).filter(Boolean))]
      .sort((a, b) => a.length - b.length)
      .slice(0, maxTitles);
    return { count, hosts, titles };
  }

  /** The best pages for a customer's question, with the lines that match. */
  async search(query: string, limit = 3): Promise<PageHit[]> {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    let found: { url: string; title: string; text: string }[] = await this.pages.textSearch(
      terms.join(' '),
      limit,
    );
    if (!found.length) {
      // Whole-word search found nothing: try parts of words ("deliver" in "delivery").
      const candidates = await this.pages.find(
        {
          $or: terms
            .filter((t) => t.length >= 3)
            .slice(0, 5)
            .flatMap((t) => [
              { title: { $regex: escapeRegex(t), $options: 'i' } },
              { text: { $regex: escapeRegex(t), $options: 'i' } },
            ]),
        },
        { projection: { url: 1, title: 1, text: 1 }, limit: 50 },
      );
      found = candidates
        .map((p) => {
          const hay = `${p.title}\n${p.text}`.toLowerCase();
          return { p, score: terms.filter((t) => hay.includes(t)).length };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.p);
    }
    return found.map((p) => ({ url: p.url, title: p.title, passages: passages(p.text, terms) }));
  }

  async list(sourceId: Types.ObjectId, q: { limit: number; cursor?: string }) {
    return this.pages.paginate({ sourceId }, q, '_id', { text: 0 });
  }

  async get(sourceId: Types.ObjectId, id: string): Promise<WebsitePageDoc | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.pages.findOne({ _id: new Types.ObjectId(id), sourceId });
  }
}
