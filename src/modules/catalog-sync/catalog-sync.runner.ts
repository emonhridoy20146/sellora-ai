import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { RequestContext, type Actor } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { SafeHttp } from '../../infra/http/safe-http.js';
import { chatMoney } from '../ai/agent/chat-text.js';
import { ProductsService, type ProductDoc } from '../commerce/products.service.js';
import type { ProductImage } from '../commerce/schemas.js';
import { FilesService } from '../files/files.service.js';
import { WebsitePagesService } from '../knowledge/website-pages.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { CatalogSyncService } from './catalog-sync.service.js';
import {
  SOURCE_LABEL,
  SourceError,
  type ConnectorInput,
  type SourceErrorKind,
} from './connectors/connector.js';
import { fromHttpError } from './connectors/http.js';
import { CONNECTORS } from './connectors/index.js';
import {
  CatalogSourceRepository,
  CatalogSyncRunRepository,
  type CatalogSourceDoc,
} from './repositories.js';
import {
  MAX_HELD,
  ZERO_COUNTS,
  ZERO_PAGES,
  type CatalogSource,
  type HeldChange,
  type PageCounts,
  type RunCounts,
  type RunStatus,
} from './schemas.js';
import {
  normalizeSourceProduct,
  productHash,
  type SourceProblem,
  type SourceProduct,
} from './source-product.js';

/** A run holds its source this long; renewed as it goes, so only a crashed run lets go. */
export const LEASE_MS = 30 * 60_000;
/** Problems kept on a run. */
const MAX_PROBLEMS = 50;
/** Due sources one sweep queues. */
const SWEEP_LIMIT = 50;
/** The longest wait after failed runs. */
const MAX_BACKOFF_MIN = 24 * 60;
const ACTOR: Actor = { type: 'system', id: 'catalog-sync' };
const MB = 1024 * 1024;
/** A large archive: more than half of the source's products, and more than this many. */
const LARGE_ARCHIVE_MIN = 5;

export type RunOutcome =
  | { status: RunStatus; counts: RunCounts; pages?: PageCounts; error?: string }
  | { status: 'skipped'; reason: string };

type PriceChange = HeldChange['prices'][number];
type PageInputs = Parameters<WebsitePagesService['save']>[2];

/** A price change that moves by more than half of the old price (ADR 0024). */
export const isLargePriceChange = (c: PriceChange): boolean =>
  c.fromMinor > 0 && Math.abs(c.toMinor - c.fromMinor) * 2 > c.fromMinor;

/** How each variant's price would change, for variants Sellora already has. */
export function priceChanges(current: ProductDoc, p: SourceProduct): PriceChange[] {
  const ids = new Map(
    (current.sync?.variants ?? []).map((m) => [m.externalId, m.variantId.toHexString()]),
  );
  const out: PriceChange[] = [];
  for (const sv of p.variants) {
    const id = ids.get(sv.externalId);
    const v = id ? current.variants.find((x) => x._id.toHexString() === id) : undefined;
    if (v && v.priceMinor !== sv.priceMinor)
      out.push({
        variant: current.options.length ? v.title : '',
        fromMinor: v.priceMinor,
        toMinor: sv.priceMinor,
      });
  }
  return out;
}

/** What a run tracks besides its counts. */
interface RunState {
  runId: Types.ObjectId;
  counts: RunCounts;
  pages: PageCounts | null;
  problems: Problems;
  /** The source's held changes as this run leaves them, by ref. */
  held: Map<string, HeldChange>;
  currency: string;
}

/** Minutes to wait after `failures` failed runs in a row. */
export function backoffMinutes(interval: number, failures: number): number {
  return Math.min(interval * 2 ** Math.max(0, failures - 1), Math.max(interval, MAX_BACKOFF_MIN));
}

class Problems {
  readonly list: SourceProblem[] = [];
  more = 0;
  /** Records a problem (without its flag; runs store what the merchant reads). */
  add(p: SourceProblem) {
    if (this.list.length < MAX_PROBLEMS) this.list.push({ ref: p.ref, message: p.message });
    else this.more += 1;
  }
}

/**
 * Runs catalog syncs in the worker (ADR 0023): reads the source through its connector, writes
 * each product through ProductsService, copies new photos, archives what disappeared, and
 * records what happened. One run per source at a time (a lease on the source).
 */
@Injectable()
export class CatalogSyncRunner {
  private readonly logger = new Logger(CatalogSyncRunner.name);

  constructor(
    private readonly service: CatalogSyncService,
    private readonly sources: CatalogSourceRepository,
    private readonly runs: CatalogSyncRunRepository,
    private readonly products: ProductsService,
    private readonly files: FilesService,
    private readonly orgs: OrgsService,
    private readonly knowledge: WebsitePagesService,
    private readonly http: SafeHttp,
    private readonly config: AppConfig,
    @InjectModel('CatalogSource') private readonly sourceModel: Model<CatalogSource>,
  ) {}

  /** Queues a run for every source whose time has come. */
  async sweep(now = new Date()): Promise<{ queued: number }> {
    const due = await this.sourceModel
      .find(
        {
          status: 'active',
          intervalMinutes: { $gt: 0 },
          nextSyncAt: { $lte: now },
          $or: [{ lease: { $exists: false } }, { 'lease.until': { $lt: now } }],
        },
        { _id: 1, orgId: 1, intervalMinutes: 1 },
        { [CROSS_TENANT]: true },
      )
      .sort({ nextSyncAt: 1 })
      .limit(SWEEP_LIMIT)
      .lean()
      .exec();
    let queued = 0;
    for (const d of due) {
      try {
        await RequestContext.withTenant(
          d.orgId.toHexString(),
          async () => {
            // Moves the next time on first, so a slow queue never doubles a run.
            const s = await this.sources.findOneAndUpdate(
              { _id: d._id, nextSyncAt: { $lte: now } },
              { $set: { nextSyncAt: new Date(now.getTime() + d.intervalMinutes * 60_000) } },
            );
            if (!s) return;
            if (await this.runs.exists({ sourceId: s._id, status: 'queued' })) return;
            await this.service.queueRun(s, 'schedule');
            queued += 1;
          },
          ACTOR,
        );
      } catch (err) {
        this.logger.error({ err, sourceId: d._id.toHexString() }, 'Could not queue a catalog sync');
      }
    }
    return { queued };
  }

  run(orgId: string, runId: string, now = () => new Date()): Promise<RunOutcome> {
    return RequestContext.withTenant(orgId, () => this.runInTenant(runId, now), ACTOR);
  }

  private async runInTenant(runId: string, now: () => Date): Promise<RunOutcome> {
    const run = await this.runs.findById(runId);
    if (!run || run.status !== 'queued') return { status: 'skipped', reason: 'run_missing' };
    const started = now();
    const leased = await this.sources.findOneAndUpdate(
      {
        _id: run.sourceId,
        $or: [{ lease: { $exists: false } }, { 'lease.until': { $lt: started } }],
      },
      { $set: { lease: { runId: run._id, until: new Date(started.getTime() + LEASE_MS) } } },
    );
    if (!leased) {
      const exists = await this.sources.exists({ _id: run.sourceId });
      await this.runs.updateOne(
        { _id: run._id },
        {
          $set: {
            status: 'failed',
            error: exists
              ? 'Another sync of this source was already running.'
              : 'The source was removed.',
            finishedAt: started,
          },
          $unset: { csv: '' },
        },
      );
      return { status: 'skipped', reason: exists ? 'busy' : 'source_missing' };
    }
    await this.runs.updateOne(
      { _id: run._id },
      { $set: { status: 'running', startedAt: started } },
    );

    const state: RunState = {
      runId: run._id,
      counts: { ...ZERO_COUNTS },
      pages: leased.kind === 'website' ? { ...ZERO_PAGES } : null,
      problems: new Problems(),
      held: new Map((leased.held ?? []).map((h) => [h.ref, h])),
      currency: 'BDT',
    };
    let error: { message: string; kind: SourceErrorKind } | undefined;
    try {
      const { currency } = await this.orgs.get(leased.orgId.toHexString());
      state.currency = currency;
      const site = leased.website;
      if (leased.kind === 'website' && !site?.verifiedAt)
        throw new SourceError('ownership', 'Prove the website is yours first, then press Verify.');
      const input: ConnectorInput = {
        ...(leased.url ? { url: leased.url } : {}),
        ...(leased.credentialsEnc ? { credentials: this.service.credentials(leased) } : {}),
        ...(run.csv !== undefined ? { csv: run.csv } : {}),
        currency,
        ...(site
          ? {
              website: {
                token: site.token,
                importProducts: site.importProducts,
                readPages: site.readPages,
                productPages: site.importProducts
                  ? await this.products.sourceExternalIds(leased._id)
                  : [],
              },
            }
          : {}),
      };
      await this.read(leased, input, state, now);
    } catch (err) {
      const e =
        err instanceof SourceError
          ? err
          : err instanceof AppError
            ? new SourceError('bad_response', err.message)
            : null;
      if (!e) this.logger.error({ err, runId }, 'Catalog sync failed');
      error = e
        ? { message: e.message, kind: e.kind }
        : { message: fromHttpError(err, SOURCE_LABEL[leased.kind]).message, kind: 'unavailable' };
    }
    return this.finish(leased, run, state, error, now());
  }

  /** Reads every batch and writes the products; throws when the source cannot be read to the end. */
  private async read(
    source: CatalogSourceDoc,
    input: ConnectorInput,
    state: RunState,
    now: () => Date,
  ): Promise<void> {
    const { counts, problems } = state;
    const label = SOURCE_LABEL[source.kind];
    const connector = CONNECTORS[source.kind];
    const seen = new Set<string>();
    /** Websites: products whose page was read and no longer has them. */
    const gone = new Set<string>();
    const categories = new Map<string, Types.ObjectId>();
    let limitReached = false;
    const ctx = await this.service.connectorContext(source.kind);
    for await (const batch of connector.read(input, ctx)) {
      for (const p of batch.problems) {
        if (p.skipped) counts.failed += 1;
        problems.add(p);
      }
      if (batch.movedProducts?.length)
        await this.products.rekeySource(source._id, batch.movedProducts);
      for (const id of batch.goneProducts ?? []) gone.add(id);
      if (state.pages) await this.pages(source, state, batch);

      // Duplicates (the same item twice at the source) are reported, never written twice.
      const fresh: SourceProduct[] = [];
      for (const raw of batch.products) {
        counts.seen += 1;
        const n = normalizeSourceProduct(raw);
        if (!n.ok) {
          counts.failed += 1;
          problems.add(n.problem);
          continue;
        }
        for (const note of n.notes) problems.add(note);
        if (seen.has(n.product.externalId)) {
          counts.failed += 1;
          problems.add({
            ref: n.product.name,
            message: 'It is listed twice at the source; the first one was used.',
          });
          continue;
        }
        seen.add(n.product.externalId);
        gone.delete(n.product.externalId);
        fresh.push(n.product);
      }
      const existing = new Map(
        (
          await this.products.findBySource(
            source._id,
            fresh.map((p) => p.externalId),
          )
        ).map((p) => [p.sync!.externalId, p]),
      );
      const archive: Types.ObjectId[] = [];
      for (const p of fresh) {
        const current = existing.get(p.externalId) ?? null;
        if (!p.active) {
          state.held.delete(p.externalId);
          if (current && source.archiveMissing && current.status !== 'archived')
            archive.push(current._id);
          else counts.unchanged += 1;
          continue;
        }
        if (!current && limitReached) {
          counts.failed += 1;
          continue;
        }
        const hash = productHash(p, { syncStock: source.syncStock });
        const restoring = current?.status === 'archived' && current.sync?.archivedBySync;
        if (current && current.sync?.hash === hash && !restoring) {
          counts.unchanged += 1;
          state.held.delete(p.externalId);
          continue;
        }
        if (current && !restoring && this.holdPrice(source, state, current, p, hash, now()))
          continue;
        try {
          const images = await this.photos(p, current, problems, ctx.crawl?.userAgent);
          let categoryId: Types.ObjectId | null = null;
          if (p.category) {
            const key = p.category.toLowerCase();
            categoryId = categories.get(key) ?? (await this.products.categoryFor(p.category));
            categories.set(key, categoryId);
          }
          const { outcome } = await this.products.applySourceProduct(current, {
            sourceId: source._id,
            externalId: p.externalId,
            hash,
            sourceLabel: label,
            name: p.name,
            description: p.description,
            tags: p.tags,
            categoryId,
            images,
            options: p.options,
            variants: p.variants,
            syncStock: source.syncStock,
            stockFrom: source.kind === 'website' ? 'availability' : 'counts',
            newStatus: source.newProductStatus,
            createdBy: source.createdBy,
          });
          counts[outcome] += 1;
          state.held.delete(p.externalId);
        } catch (err) {
          counts.failed += 1;
          if (err instanceof AppError) {
            if (err.code === 'plan_limit_reached') {
              limitReached = true;
              problems.add({
                ref: p.name,
                message: `${err.message} Products after this one were not added.`,
              });
            } else problems.add({ ref: p.name, message: err.message });
          } else {
            this.logger.warn(
              { err, externalId: p.externalId },
              'A synced product could not be written',
            );
            problems.add({
              ref: p.name,
              message: 'It could not be saved; Sellora will try again at the next sync.',
            });
          }
        }
      }
      counts.archived += await this.products.archiveFromSource(archive);
      const renewed = await this.sources.updateOne(
        { _id: source._id, 'lease.runId': source.lease!.runId },
        { $set: { 'lease.until': new Date(now().getTime() + LEASE_MS) } },
      );
      if (!renewed.matched) {
        // Removed while running: what this run wrote must not point at a source that is gone.
        await this.products.detachSource(source._id);
        await this.knowledge.removeSource(source._id);
        throw new SourceError('not_found', 'The source was removed during the sync.');
      }
    }

    const importsProducts = source.kind !== 'website' || source.website?.importProducts !== false;
    // Everything was read: products the source no longer has are archived, unless the source
    // answered with nothing at all where it used to have products.
    if (importsProducts && counts.seen === 0 && source.lastSeen > 0)
      throw new SourceError(
        'bad_response',
        `${label} answered with no products (it had ${source.lastSeen} last time), so nothing was archived. If the catalog really is empty, archive the products in Sellora.`,
      );
    if (state.pages) await this.finishPages(source, state);
    if (!source.archiveMissing) return;
    // A crawl may not reach every page: only products confirmed gone are archived.
    const missing = connector.partialReads
      ? (await this.products.findBySource(source._id, [...gone])).filter(
          (p) => p.status !== 'archived',
        )
      : await this.products.findBySourceMissing(source._id, [...seen]);
    counts.archived += await this.archiveGone(source, state, missing, now());
  }

  /** Website pages in a batch: saved for the AI, or removed when gone. */
  private async pages(
    source: CatalogSourceDoc,
    state: RunState,
    batch: {
      pages?: PageInputs;
      gonePages?: string[];
      crawlEnd?: { read: number; notRead: number };
    },
  ): Promise<void> {
    const pages = state.pages!;
    if (batch.pages?.length && source.website?.readPages) {
      const c = await this.knowledge.save(source._id, state.runId, batch.pages);
      pages.added += c.added;
      pages.changed += c.changed;
    }
    if (batch.gonePages?.length)
      pages.removed += await this.knowledge.remove(source._id, batch.gonePages);
    if (batch.crawlEnd) {
      pages.read = batch.crawlEnd.read;
      pages.notRead = batch.crawlEnd.notRead;
    }
  }

  /** After a crawl: pages it did not see go when it read the whole site (or pages are off). */
  private async finishPages(source: CatalogSourceDoc, state: RunState): Promise<void> {
    const pages = state.pages!;
    if (!source.website?.readPages) pages.removed += await this.knowledge.removeSource(source._id);
    else if (pages.notRead === 0)
      pages.removed += await this.knowledge.removeUnseen(source._id, state.runId);
    if (pages.notRead > 0)
      state.problems.add({
        ref: 'Pages',
        message: `Read ${pages.read} pages, the most one crawl may read on this plan; ${pages.notRead} more were found but not read.`,
      });
  }

  /**
   * Holds a change that moves a price by more than half, unless the merchant chose to apply
   * this version (ADR 0024). Returns true when the product is not to be written now.
   */
  private holdPrice(
    source: CatalogSourceDoc,
    state: RunState,
    current: ProductDoc,
    p: SourceProduct,
    hash: string,
    at: Date,
  ): boolean {
    if (!source.holdLargeChanges) return false;
    const changes = priceChanges(current, p);
    if (!changes.some(isLargePriceChange)) return false;
    const entry = state.held.get(p.externalId);
    if (entry?.hash === hash && entry.decision === 'apply') return false;
    if (entry?.hash === hash && entry.decision === 'keep') {
      state.counts.unchanged += 1;
      return true;
    }
    state.held.set(p.externalId, {
      ref: p.externalId,
      kind: 'price',
      label: p.name,
      productId: current._id,
      prices: changes,
      names: [],
      hash,
      decision: 'pending',
      seenAt: at,
    });
    state.counts.held += 1;
    const what = changes
      .filter(isLargePriceChange)
      .slice(0, 3)
      .map(
        (c) =>
          `${c.variant ? `${c.variant}: ` : ''}${chatMoney(c.fromMinor, state.currency)} → ${chatMoney(c.toMinor, state.currency)}`,
      )
      .join(', ');
    state.problems.add({
      ref: p.name,
      message: `The price changed by more than half (${what}), so it waits for you to apply or keep it.`,
    });
    return true;
  }

  /** Archives products gone from the source; a large archive waits for the merchant. */
  private async archiveGone(
    source: CatalogSourceDoc,
    state: RunState,
    gone: ProductDoc[],
    at: Date,
  ): Promise<number> {
    if (!gone.length) {
      state.held.delete('archive');
      return 0;
    }
    if (source.holdLargeChanges && gone.length > LARGE_ARCHIVE_MIN) {
      const live = (await this.products.findBySourceMissing(source._id, [])).length;
      if (gone.length * 2 > live) {
        const ids = gone.map((g) => g.sync?.externalId ?? g._id.toHexString()).sort();
        const hash = createHash('sha256').update(ids.join('\n')).digest('base64url').slice(0, 32);
        const entry = state.held.get('archive');
        if (!(entry?.hash === hash && entry.decision === 'apply')) {
          if (!(entry?.hash === hash && entry.decision === 'keep')) {
            state.held.set('archive', {
              ref: 'archive',
              kind: 'archive',
              label: `${gone.length} products`,
              prices: [],
              names: gone.slice(0, 20).map((g) => g.name),
              hash,
              decision: 'pending',
              seenAt: at,
            });
            state.counts.held += 1;
            state.problems.add({
              ref: `${gone.length} products`,
              message: `They are gone from the source: more than half of its ${live} products at once, so none were archived. They wait for you to apply or keep it.`,
            });
          }
          return 0;
        }
      }
    }
    state.held.delete('archive');
    return this.products.archiveFromSource(gone.map((g) => g._id));
  }

  /**
   * The product's photos: ones already copied (by their source address) are reused, new ones
   * are fetched into the business's storage. A photo that cannot be fetched is left out and
   * reported; the product is still written.
   */
  private async photos(
    p: SourceProduct,
    current: ProductDoc | null,
    problems: Problems,
    userAgent?: string,
  ): Promise<ProductImage[]> {
    const known = new Map(
      (current?.images ?? []).filter((i) => i.sourceUrl).map((i) => [i.sourceUrl!, i]),
    );
    const out: ProductImage[] = [];
    const maxBytes = this.config.get('FILE_MAX_IMAGE_MB') * MB;
    for (const img of p.images) {
      const kept = known.get(img.url);
      if (kept) {
        out.push({ ...kept, ...(img.alt ? { alt: img.alt } : {}) });
        continue;
      }
      try {
        const res = await this.http.request(img.url, {
          maxBytes,
          headers: {
            accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
            ...(userAgent ? { 'user-agent': userAgent } : {}),
          },
        });
        if (res.status < 200 || res.status >= 300)
          throw new SourceError('not_found', `HTTP ${res.status}`);
        const file = await this.files.saveBytes({
          purpose: 'product_image',
          bytes: res.bytes,
          filename: (p.name || 'photo').slice(0, 60),
        });
        out.push({
          url: this.files.publicUrl(file),
          fileId: file._id,
          ...(img.alt ? { alt: img.alt } : {}),
          sourceUrl: img.url,
        });
      } catch (err) {
        const why =
          err instanceof AppError
            ? err.message
            : err instanceof SourceError
              ? err.message
              : fromHttpError(err, 'The photo').message;
        problems.add({ ref: p.name, message: `A photo was skipped (${why}).` });
      }
    }
    return out;
  }

  private async finish(
    source: CatalogSourceDoc,
    run: { _id: Types.ObjectId; startedAt?: Date },
    state: RunState,
    error: { message: string; kind: SourceErrorKind } | undefined,
    at: Date,
  ): Promise<RunOutcome> {
    const runId = run._id;
    const { counts, pages, problems } = state;
    const status: RunStatus = error
      ? 'failed'
      : counts.failed > 0 || counts.held > 0 || (pages?.notRead ?? 0) > 0
        ? 'partial'
        : 'succeeded';
    await this.runs.updateOne(
      { _id: runId },
      {
        $set: {
          status,
          counts,
          ...(pages ? { pages } : {}),
          problems: problems.list,
          moreProblems: problems.more,
          finishedAt: at,
          ...(error ? { error: error.message } : {}),
        },
        $unset: { csv: '' },
      },
    );
    const failures = error ? source.failures + 1 : 0;
    const lostOwnership = error?.kind === 'ownership';
    const interval = source.intervalMinutes;
    // Decisions the merchant made while this run was going are kept.
    const now = await this.sources.findById(source._id, { held: 1 });
    const decided = new Map((now?.held ?? []).map((h) => [h.ref, h]));
    const held = [...state.held.values()]
      .map((h) => {
        const d = decided.get(h.ref);
        return d && d.hash === h.hash && d.decision !== h.decision ? { ...h, ...d } : h;
      })
      .slice(0, MAX_HELD);
    const set: Record<string, unknown> = {
      lastRun: {
        runId,
        status,
        finishedAt: at,
        counts,
        ...(pages ? { pages } : {}),
        ...(error ? { error: error.message } : {}),
      },
      failures,
      held,
    };
    const unset: Record<string, ''> = { lease: '' };
    if (!error) {
      set.lastSuccessAt = at;
      set.lastSeen = counts.seen;
    }
    if (source.website) {
      set['website.checkedAt'] = at;
      if (lostOwnership) {
        set['website.verifyError'] = error.message;
        unset['website.verifiedAt'] = '';
        unset['website.verifiedBy'] = '';
      } else if (!error) unset['website.verifyError'] = '';
    }
    if (interval > 0 && source.status === 'active' && !lostOwnership)
      set.nextSyncAt = new Date(
        at.getTime() + (error ? backoffMinutes(interval, failures) : interval) * 60_000,
      );
    else unset.nextSyncAt = '';
    await this.sources.updateOne(
      { _id: source._id, 'lease.runId': runId },
      { $set: set, $unset: unset },
    );
    // "Apply" pressed while this run was going: the next run applies it now.
    const startedAt = run.startedAt ?? at;
    if (
      !error &&
      held.some((h) => h.decision === 'apply' && h.decidedAt && h.decidedAt > startedAt)
    ) {
      const fresh = await this.sources.findById(source._id);
      if (fresh && !(await this.runs.exists({ sourceId: fresh._id, status: 'queued' })))
        await this.service.queueRun(fresh, 'manual');
    }
    return {
      status,
      counts,
      ...(pages ? { pages } : {}),
      ...(error ? { error: error.message } : {}),
    };
  }
}
