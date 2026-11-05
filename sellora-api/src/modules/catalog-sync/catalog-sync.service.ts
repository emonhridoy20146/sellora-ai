import { randomBytes } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { SafeHttp } from '../../infra/http/safe-http.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import { WebsitePagesService, type WebsitePageDoc } from '../knowledge/website-pages.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { DNS_LOOKUP, type DnsLookup } from '../stores/dns-lookup.js';
import type {
  CreateSourceBody,
  HeldDecisionBody,
  SourceInput,
  UpdateSourceBody,
} from './catalog-sync.dto.js';
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
import { readHomePage } from './connectors/website.connector.js';
import { checkOwnership, ownershipInstructions } from './website/ownership.js';
import { normalizeSiteUrl, sameSite } from './website/site-url.js';
import {
  CatalogSourceRepository,
  CatalogSyncRunRepository,
  type CatalogSourceDoc,
  type CatalogSyncRunDoc,
} from './repositories.js';
import {
  WEBSITE_INTERVALS,
  type HeldChange,
  type RunTrigger,
  type SyncInterval,
} from './schemas.js';

export const CATALOG_SYNC_JOBS = { run: 'run', sweep: 'sweep' } as const;
export interface CatalogSyncJob {
  orgId: string;
  runId: string;
}

/** Run records are kept this long. */
export const RUN_KEEP_MS = 90 * 24 * 3600_000;
/** Sources one business may have. */
export const MAX_SOURCES = 10;
/** The default user agent sites see; CRAWL_USER_AGENT replaces it. */
export const crawlUserAgent = (webUrl: string) =>
  `SelloraBot/1.0 (+${webUrl.replace(/\/$/, '')}/bot)`;

export const credentialsAad = (orgId: string, sourceId: string) =>
  `catalog-source:${orgId}:${sourceId}`;

function toHeldDto(h: HeldChange) {
  return {
    ref: h.ref,
    kind: h.kind,
    label: h.label,
    productId: h.productId?.toHexString() ?? null,
    prices: h.prices,
    names: h.names,
    decision: h.decision,
    seenAt: h.seenAt.toISOString(),
    decidedAt: h.decidedAt?.toISOString() ?? null,
  };
}

function toWebsiteDto(s: CatalogSourceDoc, pageCount: number) {
  const w = s.website;
  if (!w || !s.url) return null;
  const host = new URL(s.url).hostname;
  return {
    host,
    verified: Boolean(w.verifiedAt),
    verifiedAt: w.verifiedAt?.toISOString() ?? null,
    verifiedBy: w.verifiedBy ?? null,
    verifyError: w.verifyError ?? null,
    checkedAt: w.checkedAt?.toISOString() ?? null,
    token: w.token,
    ...ownershipInstructions(host, w.token),
    importProducts: w.importProducts,
    readPages: w.readPages,
    pageCount,
  };
}

export function toSourceDto(s: CatalogSourceDoc, productCount: number, pageCount = 0) {
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
    holdLargeChanges: s.holdLargeChanges ?? false,
    held: (s.held ?? []).map(toHeldDto),
    website: toWebsiteDto(s, pageCount),
    nextSyncAt: s.status === 'active' ? (s.nextSyncAt?.toISOString() ?? null) : null,
    running: Boolean(s.lease && s.lease.until.getTime() > Date.now()),
    lastRun: s.lastRun
      ? {
          id: s.lastRun.runId.toHexString(),
          status: s.lastRun.status,
          finishedAt: s.lastRun.finishedAt.toISOString(),
          counts: { ...s.lastRun.counts, held: s.lastRun.counts.held ?? 0 },
          pages: s.lastRun.pages ?? null,
          error: s.lastRun.error ?? null,
        }
      : null,
    lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
    failures: s.failures,
    productCount,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toPageDto(p: WebsitePageDoc, withText = false) {
  return {
    id: p._id.toHexString(),
    url: p.url,
    title: p.title,
    description: p.description,
    words: p.words,
    crawledAt: p.crawledAt.toISOString(),
    changedAt: p.changedAt.toISOString(),
    ...(withText ? { text: p.text } : {}),
  };
}

export function toRunDto(r: CatalogSyncRunDoc) {
  return {
    id: r._id.toHexString(),
    sourceId: r.sourceId.toHexString(),
    trigger: r.trigger,
    status: r.status,
    counts: { ...r.counts, held: r.counts.held ?? 0 },
    pages: r.pages ?? null,
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
    private readonly entitlements: EntitlementsService,
    private readonly knowledge: WebsitePagesService,
    @Inject(DNS_LOOKUP) private readonly dns: DnsLookup,
    @InjectQueue(QUEUES.catalogSync) private readonly queue: Queue<CatalogSyncJob>,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  /** What a connector may use; websites also get DNS and the plan's page budget. */
  async connectorContext(kind?: SourceKind): Promise<ConnectorContext> {
    const base: ConnectorContext = { http: this.http, setting: (key) => this.config.get(key) };
    if (kind !== 'website') return base;
    const cap = this.config.get('CRAWL_MAX_PAGES');
    const plan = (await this.entitlements.forOrg(this.orgId())).limits.websitePages;
    return {
      ...base,
      verifyRecords: async (domain) => {
        const a = await this.dns.lookup(domain);
        return { txt: a.txt, unreachable: a.unreachable };
      },
      crawl: {
        maxPages: Math.max(1, Math.min(plan ?? cap, cap)),
        userAgent:
          this.config.get('CRAWL_USER_AGENT') || crawlUserAgent(this.config.get('WEB_APP_URL')),
        minDelayMs: this.config.get('CRAWL_MIN_DELAY_MS'),
      },
    };
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
            : kind === 'website'
              ? normalizeSiteUrl(url)
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
      result = await CONNECTORS[source.kind].check(input, await this.connectorContext(source.kind));
    } catch (err) {
      const e = err instanceof SourceError ? err : fromHttpError(err, SOURCE_LABEL[source.kind]);
      throw AppError.unprocessable(`source_${e.kind}`, e.message);
    }
    const currencyOk = !result.currency || result.currency.toUpperCase() === input.currency;
    return {
      ...result,
      problems: result.problems.map((p) => ({ ref: p.ref, message: p.message })),
      currencyOk,
      businessCurrency: input.currency,
    };
  }

  async list() {
    const [sources, counts, pages] = await Promise.all([
      this.sources.find({}, { sort: { createdAt: 1 } }),
      this.products.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { 'sync.sourceId': { $exists: true }, status: { $ne: 'archived' } } },
        { $group: { _id: '$sync.sourceId', n: { $sum: 1 } } },
      ]),
      this.knowledge.countsBySource(),
    ]);
    const byId = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return sources.map((s) =>
      toSourceDto(s, byId.get(s._id.toHexString()) ?? 0, pages.get(s._id.toHexString()) ?? 0),
    );
  }

  async get(id: string): Promise<CatalogSourceDoc> {
    const s = await this.sources.findById(id);
    if (!s) throw AppError.notFound('catalog_source');
    return s;
  }

  async dto(s: CatalogSourceDoc) {
    const [n, pages] = await Promise.all([
      this.products.count({ 'sync.sourceId': s._id, status: { $ne: 'archived' } }),
      s.kind === 'website' ? this.knowledge.count(s._id) : Promise.resolve(0),
    ]);
    return toSourceDto(s, n, pages);
  }

  async create(body: CreateSourceBody) {
    const orgId = this.orgId();
    if ((await this.sources.count({})) >= MAX_SOURCES)
      throw AppError.conflict(
        'too_many_sources',
        `A business can have up to ${MAX_SOURCES} sources.`,
      );
    if (body.source.kind === 'website') return this.createWebsite(body, body.source.url);
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
      holdLargeChanges: body.holdLargeChanges ?? false,
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

  /**
   * A website source (ADR 0024): checked (home page, robots.txt, sitemap), saved with an
   * ownership token, and crawled only after "Verify" finds the proof.
   */
  private async createWebsite(body: CreateSourceBody, rawUrl: string) {
    const orgId = this.orgId();
    if ((await this.entitlements.forOrg(orgId)).limits.websitePages === 0)
      throw AppError.paymentRequired(
        'plan_limit_reached',
        'Your plan does not include reading your website. Upgrade to add it.',
        { limit: 'websitePages', max: 0, current: 0 },
      );
    const interval = (body.intervalMinutes ?? 1440) as SyncInterval;
    this.assertWebsiteInterval(interval);
    const check = await this.check({ kind: 'website', url: rawUrl });
    const address = check.site!.address;
    const host = new URL(address).hostname;
    const others = await this.sources.find({ kind: 'website' }, { projection: { url: 1 } });
    if (others.some((o) => o.url && sameSite(new URL(o.url).hostname, host)))
      throw AppError.conflict('website_exists', 'This website is already one of your sources.');
    const source = await this.sources.create({
      kind: 'website',
      name: (body.name ?? (check.title || host)).slice(0, 80),
      status: 'active',
      url: address,
      ...(check.title ? { title: check.title.slice(0, 200) } : {}),
      intervalMinutes: interval,
      newProductStatus: body.newProductStatus ?? 'active',
      syncStock: body.syncStock ?? true,
      archiveMissing: body.archiveMissing ?? true,
      holdLargeChanges: body.holdLargeChanges ?? true,
      website: {
        token: randomBytes(16).toString('hex'),
        importProducts: body.importProducts ?? true,
        readPages: body.readPages ?? true,
      },
      failures: 0,
      lastSeen: 0,
      createdBy: new Types.ObjectId(RequestContext.actor().id),
    });
    await this.audit.record({
      action: 'catalog.source.created',
      orgId,
      target: { type: 'catalog_source', id: source._id.toHexString(), label: source.name },
      metadata: { kind: 'website', url: address },
    });
    return { source: await this.dto(source), runId: null };
  }

  private assertWebsiteInterval(n: number) {
    if (!(WEBSITE_INTERVALS as readonly number[]).includes(n))
      throw AppError.validation([
        {
          path: 'intervalMinutes',
          message: 'A website is read hourly, every 6 hours, daily, or only when asked.',
        },
      ]);
  }

  /**
   * Checks the website's ownership proof now. On success the first crawl (or a new one)
   * starts; on failure the merchant reads what was not found.
   */
  async verify(id: string) {
    const s = await this.get(id);
    if (s.kind !== 'website' || !s.website || !s.url)
      throw AppError.unprocessable('not_website', 'Only a website source needs verifying.');
    const ctx = await this.connectorContext('website');
    const home = await readHomePage(s.url, ctx).catch(() => null);
    const result = await checkOwnership({
      host: new URL(s.url).hostname,
      token: s.website.token,
      home,
      ...(ctx.verifyRecords ? { lookup: ctx.verifyRecords } : {}),
    });
    const at = new Date();
    if (!result.ok) {
      await this.sources.updateOne(
        { _id: s._id },
        { $set: { 'website.verifyError': result.message, 'website.checkedAt': at } },
      );
      throw AppError.unprocessable('site_not_verified', result.message);
    }
    const after = await this.sources.findOneAndUpdate(
      { _id: s._id },
      {
        $set: {
          'website.verifiedAt': at,
          'website.verifiedBy': result.method,
          'website.checkedAt': at,
          failures: 0,
        },
        $unset: { 'website.verifyError': '' },
      },
    );
    if (!after) throw AppError.notFound('catalog_source');
    let runId: string | null = null;
    if (!(await this.busy(after))) {
      const run = await this.queueRun(after, after.lastRun ? 'manual' : 'first');
      runId = run._id.toHexString();
    }
    await this.audit.record({
      action: 'catalog.source.verified',
      orgId: this.orgId(),
      target: { type: 'catalog_source', id, label: after.name },
      metadata: { method: result.method },
    });
    return { source: await this.dto(after), runId };
  }

  /** Apply or keep a large change the source made (ADR 0024). "Apply" starts a sync. */
  async decideHeld(id: string, body: HeldDecisionBody) {
    const s = await this.get(id);
    const entry = (s.held ?? []).find((h) => h.ref === body.ref);
    if (!entry) throw AppError.notFound('held_change', 'This change is no longer waiting.');
    const updated = await this.sources.findOneAndUpdate(
      { _id: s._id, held: { $elemMatch: { ref: entry.ref, hash: entry.hash } } },
      {
        $set: {
          'held.$.decision': body.decision,
          'held.$.decidedAt': new Date(),
          'held.$.decidedBy': new Types.ObjectId(RequestContext.actor().id),
        },
      },
    );
    if (!updated) throw AppError.notFound('held_change', 'This change is no longer waiting.');
    let runId: string | null = null;
    const canRun =
      updated.kind !== 'csv' && (updated.kind !== 'website' || updated.website?.verifiedAt);
    if (body.decision === 'apply' && canRun && !(await this.busy(updated)))
      runId = (await this.queueRun(updated, 'manual'))._id.toHexString();
    await this.audit.record({
      action: 'catalog.source.change_decided',
      orgId: this.orgId(),
      target: { type: 'catalog_source', id, label: updated.name },
      metadata: { ref: entry.ref, kind: entry.kind, decision: body.decision },
    });
    return { source: await this.dto(updated), runId };
  }

  /** A website source's kept pages, newest first. */
  async listPages(id: string, q: { limit: number; cursor?: string }) {
    const s = await this.get(id);
    if (s.kind !== 'website')
      throw AppError.unprocessable('not_website', 'Only a website source has pages.');
    const page = await this.knowledge.list(s._id, q);
    return { items: page.items.map((p) => toPageDto(p)), nextCursor: page.nextCursor };
  }

  async getPage(id: string, pageId: string) {
    const s = await this.get(id);
    const p = await this.knowledge.get(s._id, pageId);
    if (!p) throw AppError.notFound('website_page');
    return toPageDto(p, true);
  }

  /** What the AI's search_website tool finds for a question. */
  searchPages(q: string) {
    return this.knowledge.search(q, 5).then((hits) => ({ hits }));
  }

  async update(id: string, body: UpdateSourceBody) {
    const orgId = this.orgId();
    const before = await this.get(id);
    const set: Record<string, unknown> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.newProductStatus !== undefined) set.newProductStatus = body.newProductStatus;
    if (body.syncStock !== undefined) set.syncStock = body.syncStock;
    if (body.archiveMissing !== undefined) set.archiveMissing = body.archiveMissing;
    if (body.holdLargeChanges !== undefined) set.holdLargeChanges = body.holdLargeChanges;
    if (body.importProducts !== undefined || body.readPages !== undefined) {
      if (before.kind !== 'website')
        throw AppError.validation([
          { path: 'readPages', message: 'Only a website source reads pages.' },
        ]);
      if (body.importProducts !== undefined) set['website.importProducts'] = body.importProducts;
      if (body.readPages !== undefined) set['website.readPages'] = body.readPages;
    }
    if (body.intervalMinutes !== undefined) {
      if (before.kind === 'csv' && body.intervalMinutes !== 0)
        throw AppError.validation([
          { path: 'intervalMinutes', message: 'A CSV file is imported when it is uploaded.' },
        ]);
      if (before.kind === 'website') this.assertWebsiteInterval(body.intervalMinutes);
      set.intervalMinutes = body.intervalMinutes;
    }
    if (body.status !== undefined) set.status = body.status;

    if (body.url !== undefined || body.credentials !== undefined) {
      if (before.kind === 'csv')
        throw AppError.validation([{ path: 'url', message: 'Upload a new file instead.' }]);
      if (before.kind === 'website')
        throw AppError.validation([
          {
            path: 'url',
            message: 'A website keeps its address: add the new address as another source.',
          },
        ]);
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
    // A website is not scheduled until it is verified.
    const verified = before.kind !== 'website' || Boolean(before.website?.verifiedAt);
    if (status === 'active' && interval > 0 && verified) {
      const next = new Date(Date.now() + interval * 60_000);
      if (!before.nextSyncAt || before.status !== 'active' || before.nextSyncAt > next || set.url)
        set.nextSyncAt = set.url ? new Date() : next;
    }
    const unset =
      status !== 'active' || interval === 0 || !verified
        ? { $unset: { nextSyncAt: '' as const } }
        : {};
    if (unset.$unset) delete set.nextSyncAt;
    const after = await this.sources.findOneAndUpdate({ _id: before._id }, { $set: set, ...unset });
    if (!after) throw AppError.notFound('catalog_source');
    if (body.readPages === false) await this.knowledge.removeSource(after._id);
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
    await this.knowledge.removeSource(s._id);
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
    if (s.kind === 'website' && !s.website?.verifiedAt)
      throw AppError.unprocessable(
        'site_not_verified',
        'Prove the website is yours first: add the tag or DNS record, then press Verify.',
      );
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

  private async busy(s: CatalogSourceDoc): Promise<boolean> {
    if (s.lease && s.lease.until.getTime() > Date.now()) return true;
    return this.runs.exists({ sourceId: s._id, status: 'queued' });
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
