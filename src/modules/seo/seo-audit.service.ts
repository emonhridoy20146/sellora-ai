import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { ProductsService, type ProductDoc } from '../commerce/products.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { StoreRepository } from '../stores/repositories.js';
import { SeoBulkRunRepository, SeoGoogleRepository } from './repositories.js';
import type { SeoBulkRun, SeoSuggestion } from './schemas.js';
import { SEO_JOBS } from './search-console.service.js';
import {
  META_MAX,
  META_MIN,
  TITLE_MAX,
  TITLE_MIN,
  normalizeForMatch,
  scoreProductSeo,
  visibleLength,
  type SeoCheckKey,
} from './seo-score.js';
import { SeoWriterService } from './seo-writer.service.js';
import type { WriterLanguage } from './writer-tasks.js';

/** Products one bulk run writes for. */
export const BULK_MAX = 50;
const AUDIT_MAX = 2_000;

export const APPLY_FIELDS = [
  'title',
  'meta',
  'keywords',
  'faq',
  'description',
  'tags',
  'alts',
  'slug',
] as const;
export type ApplyField = (typeof APPLY_FIELDS)[number];

type Doc<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

const key = (s: string) => normalizeForMatch(s);

/** The score of a product as it is, or as it would be with a suggestion applied. */
export function productScore(
  p: Pick<ProductDoc, 'name' | 'slug' | 'description' | 'seo' | 'images'>,
  dupes: { titles: Map<string, number>; metas: Map<string, number> },
  s?: SeoSuggestion,
) {
  const title = s?.seoTitle ?? (p.seo?.title || p.name);
  const meta = s?.metaDescription ?? p.seo?.description ?? '';
  // Others using the same text: everyone with it, minus this product itself.
  const others = (m: Map<string, number>, text: string, own: string) =>
    Math.max(0, (m.get(key(text)) ?? 0) - (key(own) === key(text) ? 1 : 0));
  return scoreProductSeo({
    name: p.name,
    slug: s?.slug ?? p.slug,
    seoTitle: s?.seoTitle ?? p.seo?.title,
    metaDescription: meta,
    description: s?.description ?? p.description,
    keywords: s?.keywords ?? p.seo?.keywords ?? [],
    images: p.images.map((img, i) => ({ alt: s?.imageAlts[i] ?? img.alt })),
    faqCount: s?.faq.length ?? p.seo?.faq.length ?? 0,
    sameTitle: others(dupes.titles, title, p.seo?.title || p.name),
    sameMeta: meta ? others(dupes.metas, meta, p.seo?.description ?? '') : 0,
  });
}

function toRunDto(r: Doc<SeoBulkRun>) {
  return {
    id: r._id.toHexString(),
    status: r.status,
    language: r.language,
    credits: r.credits,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    counts: {
      total: r.items.length,
      waiting: r.items.filter((i) => i.status === 'waiting').length,
      written: r.items.filter((i) => i.status === 'written').length,
      applied: r.items.filter((i) => i.status === 'applied').length,
      failed: r.items.filter((i) => i.status === 'failed').length,
    },
    items: r.items.map((i) => ({
      productId: i.productId.toHexString(),
      name: i.name,
      status: i.status,
      scoreBefore: i.scoreBefore,
      scoreAfter: i.scoreAfter ?? null,
      suggestion: i.suggestion ?? null,
      error: i.error ?? null,
      credits: i.credits,
    })),
  };
}

/**
 * The SEO audit of the whole catalogue and the store, and the bulk optimiser that writes
 * suggestions for many products at once (ADR 0032). Suggestions are only applied when the
 * business says so, product by product or all together.
 */
@Injectable()
export class SeoAuditService {
  private readonly logger = new Logger(SeoAuditService.name);

  constructor(
    private readonly products: ProductRepository,
    private readonly productsService: ProductsService,
    private readonly stores: StoreRepository,
    private readonly links: StoreLinksService,
    private readonly google: SeoGoogleRepository,
    private readonly runs: SeoBulkRunRepository,
    private readonly writer: SeoWriterService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.seo) private readonly queue: Queue,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private async activeProducts(): Promise<ProductDoc[]> {
    return this.products.find(
      { status: 'active' },
      {
        sort: { updatedAt: -1 },
        limit: AUDIT_MAX,
        projection: {
          name: 1,
          slug: 1,
          description: 1,
          seo: 1,
          images: 1,
          tags: 1,
          categoryId: 1,
          variants: 1,
          currency: 1,
          updatedAt: 1,
        },
      },
    );
  }

  private dupes(products: ProductDoc[]) {
    const titles = new Map<string, number>();
    const metas = new Map<string, number>();
    for (const p of products) {
      const t = key(p.seo?.title || p.name);
      titles.set(t, (titles.get(t) ?? 0) + 1);
      const m = p.seo?.description ? key(p.seo.description) : '';
      if (m) metas.set(m, (metas.get(m) ?? 0) + 1);
    }
    return { titles, metas };
  }

  /** How many other active products use this search title or meta description. */
  async duplicates(q: { title?: string; meta?: string; exceptId?: string }) {
    const products = await this.products.find(
      {
        status: 'active',
        ...(q.exceptId && Types.ObjectId.isValid(q.exceptId)
          ? { _id: { $ne: new Types.ObjectId(q.exceptId) } }
          : {}),
      },
      { projection: { name: 1, seo: 1 }, limit: AUDIT_MAX },
    );
    const t = q.title ? key(q.title) : '';
    const m = q.meta ? key(q.meta) : '';
    return {
      sameTitle: t ? products.filter((p) => key(p.seo?.title || p.name) === t).length : 0,
      sameMeta: m
        ? products.filter((p) => p.seo?.description && key(p.seo.description) === m).length
        : 0,
    };
  }

  async run() {
    const [products, stores, google] = await Promise.all([
      this.activeProducts(),
      this.stores.find({}, { sort: { createdAt: 1 } }),
      this.google.findOne({}),
    ]);
    const dupes = this.dupes(products);
    const items = products
      .map((p) => {
        const s = productScore(p, dupes);
        return {
          id: p._id.toHexString(),
          name: p.name,
          slug: p.slug,
          image: p.images[0]?.url ?? null,
          score: s.score,
          failing: s.checks.filter((c) => !c.ok).map((c) => c.key),
        };
      })
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    const failingCount = (k: SeoCheckKey) => items.filter((i) => i.failing.includes(k)).length;
    const average = items.length
      ? Math.round(items.reduce((a, i) => a + i.score, 0) / items.length)
      : null;
    return {
      products: {
        count: items.length,
        average,
        good: items.filter((i) => i.score >= 80).length,
        fair: items.filter((i) => i.score >= 50 && i.score < 80).length,
        poor: items.filter((i) => i.score < 50).length,
        issues: {
          focus_keyword: failingCount('focus_keyword'),
          title_length: failingCount('title_length'),
          meta_description: failingCount('meta_description'),
          description_length: failingCount('description_length'),
          image_alt: failingCount('image_alt'),
          unique_title: failingCount('unique_title'),
          unique_meta: failingCount('unique_meta'),
          faq: failingCount('faq'),
        },
        items,
        truncated: products.length >= AUDIT_MAX,
      },
      stores: stores.map((s) => {
        const url = this.links.url(s).replace(/\/+$/, '');
        const title = s.seo.title?.trim() || s.name;
        const description = s.seo.description?.trim() ?? '';
        const tl = visibleLength(title);
        const dl = visibleLength(description);
        const open = s.status === 'live';
        const connected =
          google?.storeId.equals(s._id) && google.status === 'connected' && google.step === 'done';
        return {
          id: s._id.toHexString(),
          name: s.name,
          url,
          open,
          checks: [
            {
              key: 'store_title',
              ok: tl >= TITLE_MIN && tl <= TITLE_MAX,
              detail: `${tl} characters`,
            },
            {
              key: 'store_description',
              ok: dl >= META_MIN && dl <= META_MAX,
              detail: description ? `${dl} characters` : 'missing',
            },
            { key: 'indexable', ok: open, detail: open ? 'open to search engines' : 'not open' },
            {
              key: 'search_console',
              ok: Boolean(connected),
              detail: connected ? 'connected, sitemap sent' : 'not connected',
            },
          ],
          sitemapUrl: `${url}/sitemap.xml`,
          robotsUrl: `${url}/robots.txt`,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- bulk optimiser

  async startBulk(input: { productIds?: string[]; below?: number; language: WriterLanguage }) {
    if (await this.runs.exists({ status: { $in: ['queued', 'running'] } }))
      throw AppError.conflict(
        'bulk_running',
        'A bulk run is still writing. Wait for it to finish or stop it.',
      );
    const products = await this.activeProducts();
    const dupes = this.dupes(products);
    const chosen = input.productIds?.length
      ? products.filter((p) => input.productIds!.includes(p._id.toHexString()))
      : products;
    const picked = chosen
      .map((p) => ({ p, score: productScore(p, dupes).score }))
      .filter((x) => (input.productIds?.length ? true : x.score < (input.below ?? 80)))
      .sort((a, b) => a.score - b.score)
      .slice(0, BULK_MAX);
    if (!picked.length)
      throw AppError.unprocessable(
        'nothing_to_fix',
        'No active product matches. Every product may already score well.',
      );
    const run = await this.runs.create({
      status: 'queued',
      language: input.language,
      items: picked.map((x) => ({
        productId: x.p._id,
        name: x.p.name,
        scoreBefore: x.score,
        status: 'waiting',
        credits: 0,
      })),
      credits: 0,
      createdBy: new Types.ObjectId(RequestContext.actor().id),
    });
    await this.queue.add(
      SEO_JOBS.bulk,
      { orgId: this.orgId(), runId: run._id.toHexString() },
      { jobId: `seo-bulk-${run._id.toHexString()}`, attempts: 1 },
    );
    await this.audit.record({
      orgId: this.orgId(),
      action: 'seo.bulk_started',
      target: { type: 'seo_bulk_run', id: run._id.toHexString() },
      metadata: { products: picked.length },
    });
    return toRunDto(run);
  }

  async bulkRuns() {
    const items = await this.runs.find({}, { sort: { createdAt: -1 }, limit: 10 });
    return { items: items.map(toRunDto) };
  }

  private async runDoc(id: string): Promise<Doc<SeoBulkRun>> {
    const r = await this.runs.findById(id);
    if (!r) throw AppError.notFound('seo_bulk_run');
    return r;
  }

  async bulkRun(id: string) {
    return toRunDto(await this.runDoc(id));
  }

  async cancelBulk(id: string) {
    const r = await this.runDoc(id);
    if (r.status === 'queued' || r.status === 'running')
      await this.runs.updateOne(
        { _id: r._id, status: { $in: ['queued', 'running'] } },
        { $set: { status: 'cancelled', finishedAt: new Date() } },
      );
    return this.bulkRun(id);
  }

  /** The worker writes each waiting product's suggestion, one at a time. */
  async processBulk(orgId: string, runId: string): Promise<{ written: number }> {
    return RequestContext.withTenant(orgId, async () => {
      const start = await this.runs.findOneAndUpdate(
        { _id: new Types.ObjectId(runId), status: { $in: ['queued', 'running'] } },
        { $set: { status: 'running' } },
      );
      if (!start) return { written: 0 };
      const all = await this.activeProducts();
      const dupes = this.dupes(all);
      let written = 0;
      for (const item of start.items) {
        if (item.status !== 'waiting') continue;
        const now = await this.runs.findById(runId, { status: 1 });
        if (now?.status !== 'running') break;
        const p = await this.products.findById(item.productId);
        const at = { _id: start._id, 'items.productId': item.productId };
        if (!p || p.status !== 'active') {
          await this.runs.updateOne(at, {
            $set: { 'items.$.status': 'skipped', 'items.$.error': 'No longer active' },
          });
          continue;
        }
        try {
          const { suggestion, credits } = await this.writer.writeProduct(this.writer.material(p), {
            focusKeyword: p.seo?.keywords[0] ?? null,
            language: start.language,
            productId: p._id.toHexString(),
            bulk: true,
          });
          await this.runs.updateOne(at, {
            $set: {
              'items.$.status': 'written',
              'items.$.suggestion': suggestion,
              'items.$.scoreAfter': productScore(p, dupes, suggestion).score,
              'items.$.credits': credits,
            },
            $inc: { credits },
          });
          written++;
        } catch (err) {
          const message =
            err instanceof AppError ? err.message : 'The AI could not write this product.';
          await this.runs.updateOne(at, {
            $set: { 'items.$.status': 'failed', 'items.$.error': message.slice(0, 300) },
          });
          // An empty wallet or an AI that is not set up stops the whole run.
          if (
            err instanceof AppError &&
            ['insufficient_balance', 'ai_not_configured', 'ai_model_unavailable'].includes(err.code)
          ) {
            const left = await this.runs.findById(runId);
            for (const rest of left?.items ?? [])
              if (rest.status === 'waiting')
                await this.runs.updateOne(
                  { _id: start._id, 'items.productId': rest.productId },
                  { $set: { 'items.$.status': 'failed', 'items.$.error': message.slice(0, 300) } },
                );
            break;
          }
          if (!(err instanceof AppError))
            this.logger.warn({ err, orgId, runId }, 'Bulk SEO item failed');
        }
      }
      await this.runs.updateOne(
        { _id: start._id, status: 'running' },
        { $set: { status: 'done', finishedAt: new Date() } },
      );
      return { written };
    });
  }

  /** Saves a written suggestion to its product (the fields chosen). */
  async applyItem(runId: string, productId: string, fields: ApplyField[]) {
    const r = await this.runDoc(runId);
    const item = r.items.find((i) => i.productId.toHexString() === productId);
    if (!item) throw AppError.notFound('seo_bulk_item');
    if (item.status !== 'written' || !item.suggestion)
      throw AppError.conflict('not_written', 'There is no suggestion to apply for this product.');
    const p = await this.productsService.get(productId);
    const s = item.suggestion;
    const want = new Set(fields);
    const seo = {
      title: want.has('title') ? s.seoTitle : p.seo?.title,
      description: want.has('meta') ? s.metaDescription : p.seo?.description,
      keywords: want.has('keywords') ? s.keywords : (p.seo?.keywords ?? []),
      faq: want.has('faq') ? s.faq : (p.seo?.faq ?? []),
    };
    await this.productsService.update(productId, {
      seo,
      ...(want.has('description') ? { description: s.description } : {}),
      ...(want.has('tags') ? { tags: s.tags.slice(0, 30) } : {}),
      ...(want.has('slug') && s.slug ? { slug: s.slug } : {}),
      ...(want.has('alts') && p.images.length
        ? {
            images: p.images.map((img, i) => ({
              ...(img.fileId ? { fileId: img.fileId.toHexString() } : { url: img.url }),
              ...((s.imageAlts[i] ?? img.alt) ? { alt: s.imageAlts[i] ?? img.alt } : {}),
            })),
          }
        : {}),
    });
    await this.runs.updateOne(
      { _id: r._id, 'items.productId': item.productId },
      { $set: { 'items.$.status': 'applied' } },
    );
    return this.bulkRun(runId);
  }
}
