import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { RequestContext, type Actor } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { SafeHttp } from '../../infra/http/safe-http.js';
import { ProductsService, type ProductDoc } from '../commerce/products.service.js';
import type { ProductImage } from '../commerce/schemas.js';
import { FilesService } from '../files/files.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { CatalogSyncService } from './catalog-sync.service.js';
import { SOURCE_LABEL, SourceError, type ConnectorInput } from './connectors/connector.js';
import { fromHttpError } from './connectors/http.js';
import { CONNECTORS } from './connectors/index.js';
import {
  CatalogSourceRepository,
  CatalogSyncRunRepository,
  type CatalogSourceDoc,
} from './repositories.js';
import { ZERO_COUNTS, type CatalogSource, type RunCounts, type RunStatus } from './schemas.js';
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

export type RunOutcome =
  { status: RunStatus; counts: RunCounts; error?: string } | { status: 'skipped'; reason: string };

/** Minutes to wait after `failures` failed runs in a row. */
export function backoffMinutes(interval: number, failures: number): number {
  return Math.min(interval * 2 ** Math.max(0, failures - 1), Math.max(interval, MAX_BACKOFF_MIN));
}

class Problems {
  readonly list: SourceProblem[] = [];
  more = 0;
  add(p: SourceProblem) {
    if (this.list.length < MAX_PROBLEMS) this.list.push(p);
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

    const counts: RunCounts = { ...ZERO_COUNTS };
    const problems = new Problems();
    let error: string | undefined;
    try {
      const { currency } = await this.orgs.get(leased.orgId.toHexString());
      const input: ConnectorInput = {
        ...(leased.url ? { url: leased.url } : {}),
        ...(leased.credentialsEnc ? { credentials: this.service.credentials(leased) } : {}),
        ...(run.csv !== undefined ? { csv: run.csv } : {}),
        currency,
      };
      await this.read(leased, input, counts, problems, now);
    } catch (err) {
      const e =
        err instanceof SourceError
          ? err
          : err instanceof AppError
            ? new SourceError('bad_response', err.message)
            : null;
      if (!e) this.logger.error({ err, runId }, 'Catalog sync failed');
      error = e?.message ?? fromHttpError(err, SOURCE_LABEL[leased.kind]).message;
    }
    return this.finish(leased, run._id, { counts, problems, error }, now());
  }

  /** Reads every batch and writes the products; throws when the source cannot be read to the end. */
  private async read(
    source: CatalogSourceDoc,
    input: ConnectorInput,
    counts: RunCounts,
    problems: Problems,
    now: () => Date,
  ): Promise<void> {
    const label = SOURCE_LABEL[source.kind];
    const seen = new Set<string>();
    const categories = new Map<string, Types.ObjectId>();
    let limitReached = false;
    const ctx = this.service.connectorContext();
    for await (const batch of CONNECTORS[source.kind].read(input, ctx)) {
      for (const p of batch.problems) problems.add(p);
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
          continue;
        }
        try {
          const images = await this.photos(p, current, problems);
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
            newStatus: source.newProductStatus,
            createdBy: source.createdBy,
          });
          counts[outcome] += 1;
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
        throw new SourceError('not_found', 'The source was removed during the sync.');
      }
    }

    // Everything was read: products the source no longer has are archived, unless the source
    // answered with nothing at all where it used to have products.
    if (counts.seen === 0 && source.lastSeen > 0)
      throw new SourceError(
        'bad_response',
        `${label} answered with no products (it had ${source.lastSeen} last time), so nothing was archived. If the catalog really is empty, archive the products in Sellora.`,
      );
    if (source.archiveMissing) {
      const gone = await this.products.findBySourceMissing(source._id, [...seen]);
      counts.archived += await this.products.archiveFromSource(gone.map((p) => p._id));
    }
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
          headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
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
    runId: Types.ObjectId,
    r: { counts: RunCounts; problems: Problems; error?: string },
    at: Date,
  ): Promise<RunOutcome> {
    const status: RunStatus = r.error ? 'failed' : r.counts.failed > 0 ? 'partial' : 'succeeded';
    await this.runs.updateOne(
      { _id: runId },
      {
        $set: {
          status,
          counts: r.counts,
          problems: r.problems.list,
          moreProblems: r.problems.more,
          finishedAt: at,
          ...(r.error ? { error: r.error } : {}),
        },
        $unset: { csv: '' },
      },
    );
    const failures = r.error ? source.failures + 1 : 0;
    const interval = source.intervalMinutes;
    const set: Record<string, unknown> = {
      lastRun: {
        runId,
        status,
        finishedAt: at,
        counts: r.counts,
        ...(r.error ? { error: r.error } : {}),
      },
      failures,
    };
    if (!r.error) {
      set.lastSuccessAt = at;
      set.lastSeen = r.counts.seen;
    }
    const unset: Record<string, ''> = { lease: '' };
    if (interval > 0 && source.status === 'active')
      set.nextSyncAt = new Date(
        at.getTime() + (r.error ? backoffMinutes(interval, failures) : interval) * 60_000,
      );
    else unset.nextSyncAt = '';
    await this.sources.updateOne(
      { _id: source._id, 'lease.runId': runId },
      { $set: set, $unset: unset },
    );
    return { status, counts: r.counts, ...(r.error ? { error: r.error } : {}) };
  }
}
