import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { SafeHttp } from '../../infra/http/safe-http.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import { OrgsService } from '../orgs/orgs.service.js';
import type { CreateSourceBody, SourceInput, UpdateSourceBody } from './catalog-sync.dto.js';
import {
  SOURCE_LABEL,
  SourceError,
  type ConnectorContext,
  type ConnectorInput,
  type SourceCheck,
  type SourceKind,
} from './connectors/connector.js';
import { fromHttpError } from './connectors/http.js';
import { CONNECTORS } from './connectors/index.js';
import { normalizeSheetUrl } from './connectors/sheet.connector.js';
import { normalizeShopifyUrl } from './connectors/shopify.connector.js';
import { normalizeWooUrl } from './connectors/woocommerce.connector.js';
import {
  CatalogSourceRepository,
  CatalogSyncRunRepository,
  type CatalogSourceDoc,
  type CatalogSyncRunDoc,
} from './repositories.js';
import type { RunTrigger, SyncInterval } from './schemas.js';

export const CATALOG_SYNC_JOBS = { run: 'run', sweep: 'sweep' } as const;
export interface CatalogSyncJob {
  orgId: string;
  runId: string;
}

/** Run records are kept this long. */
export const RUN_KEEP_MS = 90 * 24 * 3600_000;
/** Sources one business may have. */
export const MAX_SOURCES = 10;

export const credentialsAad = (orgId: string, sourceId: string) =>
  `catalog-source:${orgId}:${sourceId}`;

export function toSourceDto(s: CatalogSourceDoc, productCount: number) {
  return {
    id: s._id.toHexString(),
    kind: s.kind,
    kindLabel: SOURCE_LABEL[s.kind],
    name: s.name,
    status: s.status,
    url: s.url ?? null,
    title: s.title ?? null,
    credentialsHint: s.credentialsHint ?? null,
    intervalMinutes: s.intervalMinutes,
    newProductStatus: s.newProductStatus,
    syncStock: s.syncStock,
    archiveMissing: s.archiveMissing,
    nextSyncAt: s.status === 'active' ? (s.nextSyncAt?.toISOString() ?? null) : null,
    running: Boolean(s.lease && s.lease.until.getTime() > Date.now()),
    lastRun: s.lastRun
      ? {
          id: s.lastRun.runId.toHexString(),
          status: s.lastRun.status,
          finishedAt: s.lastRun.finishedAt.toISOString(),
          counts: s.lastRun.counts,
          error: s.lastRun.error ?? null,
        }
      : null,
    lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
    failures: s.failures,
    productCount,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toRunDto(r: CatalogSyncRunDoc) {
  return {
    id: r._id.toHexString(),
    sourceId: r.sourceId.toHexString(),
    trigger: r.trigger,
    status: r.status,
    counts: r.counts,
    problems: r.problems,
    moreProblems: r.moreProblems,
    error: r.error ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function hintOf(credentials: Record<string, string> | undefined): string | undefined {
  const value = credentials?.accessToken ?? credentials?.consumerKey;
  return value ? `…${value.slice(-4)}` : undefined;
}

/**
 * Catalog sources and their runs, for the business in the request (ADR 0023). Reading the
 * sources happens in the worker (CatalogSyncRunner); this checks what the merchant typed,
 * stores it and queues runs.
 */
@Injectable()
export class CatalogSyncService {
  constructor(
    private readonly sources: CatalogSourceRepository,
    private readonly runs: CatalogSyncRunRepository,
    private readonly products: ProductRepository,
    private readonly orgs: OrgsService,
    private readonly encryption: EncryptionService,
    private readonly http: SafeHttp,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.catalogSync) private readonly queue: Queue<CatalogSyncJob>,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  connectorContext(): ConnectorContext {
    return { http: this.http, setting: (key) => this.config.get(key) };
  }

  /** The address as it will be stored and called, or a 422 saying what is wrong. */
  normalizeUrl(kind: SourceKind, url: string): string {
    const allowAny = this.config.get('SYNC_ALLOW_PRIVATE_NETWORK');
    try {
      const normalized =
        kind === 'shopify'
          ? normalizeShopifyUrl(url, allowAny)
          : kind === 'woocommerce'
            ? normalizeWooUrl(url)
            : normalizeSheetUrl(url);
      this.http.parseUrl(normalized);
      return normalized;
    } catch (err) {
      const e = fromHttpError(err, 'The address');
      throw AppError.validation([{ path: 'url', message: e.message }]);
    }
  }

  private async inputOf(source: SourceInput): Promise<ConnectorInput> {
    const { currency } = await this.orgs.get(this.orgId());
    if (source.kind === 'csv') return { csv: source.csv, currency };
    return {
      url: this.normalizeUrl(source.kind, source.url),
      ...('credentials' in source ? { credentials: source.credentials } : {}),
      currency,
    };
  }

  /** Reads a little of the source (nothing is saved): what would be imported, and problems. */
  async check(
    source: SourceInput,
  ): Promise<SourceCheck & { currencyOk: boolean; businessCurrency: string }> {
    const input = await this.inputOf(source);
    let result: SourceCheck;
    try {
      result = await CONNECTORS[source.kind].check(input, this.connectorContext());
    } catch (err) {
      const e = err instanceof SourceError ? err : fromHttpError(err, SOURCE_LABEL[source.kind]);
      throw AppError.unprocessable(`source_${e.kind}`, e.message);
    }
    const currencyOk = !result.currency || result.currency.toUpperCase() === input.currency;
    return { ...result, currencyOk, businessCurrency: input.currency };
  }

  async list() {
    const [sources, counts] = await Promise.all([
      this.sources.find({}, { sort: { createdAt: 1 } }),
      this.products.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { 'sync.sourceId': { $exists: true }, status: { $ne: 'archived' } } },
        { $group: { _id: '$sync.sourceId', n: { $sum: 1 } } },
      ]),
    ]);
    const byId = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return sources.map((s) => toSourceDto(s, byId.get(s._id.toHexString()) ?? 0));
  }

  async get(id: string): Promise<CatalogSourceDoc> {
    const s = await this.sources.findById(id);
    if (!s) throw AppError.notFound('catalog_source');
    return s;
  }

  async dto(s: CatalogSourceDoc) {
    const n = await this.products.count({ 'sync.sourceId': s._id, status: { $ne: 'archived' } });
    return toSourceDto(s, n);
  }

  async create(body: CreateSourceBody) {
    const orgId = this.orgId();
    if ((await this.sources.count({})) >= MAX_SOURCES)
      throw AppError.conflict(
        'too_many_sources',
        `A business can have up to ${MAX_SOURCES} sources.`,
      );
    const check = await this.check(body.source);
    if (!check.currencyOk)
      throw AppError.unprocessable(
        'source_currency',
        `This source sells in ${check.currency}, the business in ${check.businessCurrency}. Prices are not converted.`,
      );
    if (body.source.kind === 'csv' || body.source.kind === 'sheet') {
      if (!check.sample.length)
        throw AppError.unprocessable(
          'source_empty',
          check.problems[0]?.message ?? 'No products were found in the file.',
        );
    }
    const input = body.source;
    const url = input.kind === 'csv' ? undefined : this.normalizeUrl(input.kind, input.url);
    const id = new Types.ObjectId();
    const credentials = 'credentials' in input ? input.credentials : undefined;
    const interval = (input.kind === 'csv' ? 0 : (body.intervalMinutes ?? 60)) as SyncInterval;
    const actorId = new Types.ObjectId(RequestContext.actor().id);
    const source = await this.sources.create({
      _id: id,
      kind: input.kind,
      name:
        body.name ??
        (input.kind === 'csv' ? input.filename : (check.title ?? SOURCE_LABEL[input.kind])).slice(
          0,
          80,
        ),
      status: 'active',
      ...(url ? { url } : {}),
      ...(credentials
        ? {
            credentialsEnc: this.encryption.encrypt(
              JSON.stringify(credentials),
              credentialsAad(orgId, id.toHexString()),
            ),
            credentialsHint: hintOf(credentials),
          }
        : {}),
      ...(check.title ? { title: check.title.slice(0, 200) } : {}),
      intervalMinutes: interval,
      newProductStatus: body.newProductStatus ?? 'active',
      syncStock: body.syncStock ?? true,
      archiveMissing: body.archiveMissing ?? true,
      failures: 0,
      lastSeen: 0,
      createdBy: actorId,
    });
    const run = await this.queueRun(
      source,
      input.kind === 'csv' ? 'upload' : 'first',
      input.kind === 'csv' ? input.csv : undefined,
    );
    await this.audit.record({
      action: 'catalog.source.created',
      orgId,
      target: { type: 'catalog_source', id: id.toHexString(), label: source.name },
      metadata: { kind: source.kind, url: source.url ?? null },
    });
    return { source: await this.dto(source), runId: run._id.toHexString() };
  }

  async update(id: string, body: UpdateSourceBody) {
    const orgId = this.orgId();
    const before = await this.get(id);
    const set: Record<string, unknown> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.newProductStatus !== undefined) set.newProductStatus = body.newProductStatus;
    if (body.syncStock !== undefined) set.syncStock = body.syncStock;
    if (body.archiveMissing !== undefined) set.archiveMissing = body.archiveMissing;
    if (body.intervalMinutes !== undefined) {
      if (before.kind === 'csv' && body.intervalMinutes !== 0)
        throw AppError.validation([
          { path: 'intervalMinutes', message: 'A CSV file is imported when it is uploaded.' },
        ]);
      set.intervalMinutes = body.intervalMinutes;
    }
    if (body.status !== undefined) set.status = body.status;

    if (body.url !== undefined || body.credentials !== undefined) {
      if (before.kind === 'csv')
        throw AppError.validation([{ path: 'url', message: 'Upload a new file instead.' }]);
      const credentials = body.credentials ?? this.credentials(before);
      const url = body.url ?? before.url!;
      const source = (
        before.kind === 'sheet' ? { kind: 'sheet', url } : { kind: before.kind, url, credentials }
      ) as SourceInput;
      const check = await this.check(source);
      if (!check.currencyOk)
        throw AppError.unprocessable(
          'source_currency',
          `This source sells in ${check.currency}, the business in ${check.businessCurrency}.`,
        );
      set.url = this.normalizeUrl(before.kind, url);
      if (check.title) set.title = check.title.slice(0, 200);
      if (body.credentials) {
        set.credentialsEnc = this.encryption.encrypt(
          JSON.stringify(body.credentials),
          credentialsAad(orgId, before._id.toHexString()),
        );
        set.credentialsHint = hintOf(body.credentials);
      }
      set.failures = 0;
    }
    const interval = (set.intervalMinutes as number | undefined) ?? before.intervalMinutes;
    const status = (set.status as string | undefined) ?? before.status;
    // Turning a schedule on (or resuming) syncs soon; turning it off clears the next time.
    if (status === 'active' && interval > 0) {
      const next = new Date(Date.now() + interval * 60_000);
      if (!before.nextSyncAt || before.status !== 'active' || before.nextSyncAt > next || set.url)
        set.nextSyncAt = set.url ? new Date() : next;
    }
    const unset =
      status !== 'active' || interval === 0 ? { $unset: { nextSyncAt: '' as const } } : {};
    if (unset.$unset) delete set.nextSyncAt;
    const after = await this.sources.findOneAndUpdate({ _id: before._id }, { $set: set, ...unset });
    if (!after) throw AppError.notFound('catalog_source');
    await this.audit.record({
      action: 'catalog.source.updated',
      orgId,
      target: { type: 'catalog_source', id, label: after.name },
      metadata: {
        fields: Object.keys(set).filter(
          (k) => !['credentialsEnc', 'nextSyncAt', 'failures'].includes(k),
        ),
      },
    });
    return this.dto(after);
  }

  /** The source's credentials, decrypted (only for a call to the source). */
  credentials(s: CatalogSourceDoc): Record<string, string> | undefined {
    if (!s.credentialsEnc) return undefined;
    return JSON.parse(
      this.encryption.decrypt(
        s.credentialsEnc,
        credentialsAad(s.orgId.toHexString(), s._id.toHexString()),
      ),
    ) as Record<string, string>;
  }

  /** Removes the source; its products stay as ordinary products. */
  async remove(id: string): Promise<{ products: number }> {
    const s = await this.get(id);
    const products = await this.products.updateMany(
      { 'sync.sourceId': s._id },
      { $unset: { sync: '' } },
    );
    await this.runs.deleteMany({ sourceId: s._id });
    await this.sources.deleteOne({ _id: s._id });
    await this.audit.record({
      action: 'catalog.source.deleted',
      orgId: this.orgId(),
      target: { type: 'catalog_source', id, label: s.name },
      metadata: { kind: s.kind, products },
    });
    return { products };
  }

  /** Queues a run now. 409 while one is queued or running. */
  async syncNow(id: string): Promise<CatalogSyncRunDoc> {
    const s = await this.get(id);
    if (s.kind === 'csv')
      throw AppError.unprocessable('upload_needed', 'A CSV file is imported when it is uploaded.');
    await this.assertIdle(s);
    const run = await this.queueRun(s, 'manual');
    await this.audit.record({
      action: 'catalog.source.synced',
      orgId: this.orgId(),
      target: { type: 'catalog_source', id, label: s.name },
    });
    return run;
  }

  /** A new version of a CSV source's file; checked, then imported by the worker. */
  async uploadCsv(id: string, file: { filename: string; csv: string }): Promise<CatalogSyncRunDoc> {
    const s = await this.get(id);
    if (s.kind !== 'csv')
      throw AppError.unprocessable('not_csv', 'Only a CSV source takes uploaded files.');
    await this.assertIdle(s);
    const check = await this.check({ kind: 'csv', ...file });
    if (!check.sample.length)
      throw AppError.unprocessable(
        'source_empty',
        check.problems[0]?.message ?? 'No products were found in the file.',
      );
    const run = await this.queueRun(s, 'upload', file.csv);
    await this.audit.record({
      action: 'catalog.source.uploaded',
      orgId: this.orgId(),
      target: { type: 'catalog_source', id, label: s.name },
      metadata: { filename: file.filename, bytes: Buffer.byteLength(file.csv) },
    });
    return run;
  }

  private async assertIdle(s: CatalogSourceDoc): Promise<void> {
    if (s.lease && s.lease.until.getTime() > Date.now())
      throw AppError.conflict('sync_running', 'This source is syncing now.');
    if (await this.runs.exists({ sourceId: s._id, status: 'queued' }))
      throw AppError.conflict('sync_queued', 'A sync of this source is about to start.');
  }

  /** Writes a queued run and hands it to the worker. Also used by the sweep. */
  async queueRun(
    s: CatalogSourceDoc,
    trigger: RunTrigger,
    csv?: string,
  ): Promise<CatalogSyncRunDoc> {
    const actor = RequestContext.actor();
    const run = await this.runs.create({
      sourceId: s._id,
      trigger,
      status: 'queued',
      problems: [],
      moreProblems: 0,
      ...(csv !== undefined ? { csv } : {}),
      ...(actor.type === 'user' ? { by: new Types.ObjectId(actor.id) } : {}),
      expiresAt: new Date(Date.now() + RUN_KEEP_MS),
    });
    await this.queue.add(
      CATALOG_SYNC_JOBS.run,
      { orgId: s.orgId.toHexString(), runId: run._id.toHexString() },
      {
        jobId: `run-${run._id.toHexString()}`,
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
    return run;
  }

  async listRuns(id: string, q: { limit: number; cursor?: string }) {
    const s = await this.get(id);
    const page = await this.runs.paginate({ sourceId: s._id }, q, '_id', { csv: 0 });
    return { items: page.items.map(toRunDto), nextCursor: page.nextCursor };
  }

  async getRun(id: string, runId: string) {
    const s = await this.get(id);
    const run = await this.runs.findOne(
      { _id: Types.ObjectId.isValid(runId) ? new Types.ObjectId(runId) : null, sourceId: s._id },
      { csv: 0 },
    );
    if (!run) throw AppError.notFound('catalog_sync_run');
    return toRunDto(run);
  }
}
