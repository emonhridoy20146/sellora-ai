import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { UrlSigner } from '../../infra/storage/signing.js';
import { AuditService } from '../audit/audit.service.js';
import { GoogleError } from '../backups/google-drive.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { StoreRepository } from '../stores/repositories.js';
import { UsersService } from '../users/users.service.js';
import {
  SearchConsoleDayRepository,
  SearchConsoleRowRepository,
  SeoGoogleRepository,
} from './repositories.js';
import type { SeoGoogle } from './schemas.js';
import {
  SITE_VERIFICATION_SCOPE,
  SearchConsoleClient,
  WEBMASTERS_SCOPE,
  canUseSite,
} from './search-console.client.js';
import {
  addDays,
  groupBy,
  isoDay,
  opportunities,
  productSlugOf,
  totals,
  type QueryPageRow,
} from './search-report.js';

export const SEO_JOBS = {
  setup: 'sc-setup',
  sync: 'sc-sync',
  sweep: 'sc-sweep',
  bulk: 'bulk-run',
} as const;

export interface SeoJob {
  orgId: string;
  runId?: string;
}

/** Days of daily totals kept and fetched again at each sync (Google keeps 16 months). */
const DAYS_FETCHED = 90;
/** The phrase and page table covers this many days. */
const ROWS_DAYS = 28;
const ROWS_MAX = 5_000;
const SYNC_EVERY_MS = 24 * 3600_000;
const SYNC_RETRY_MS = 3600_000;
/** Google reads the tag when asked; the shop's pages may take a little while to show it. */
export const SETUP_RETRY_MS = 60_000;
const SETUP_MAX_ATTEMPTS = 6;

type Doc<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

/**
 * Google Search Console for a business's store (ADR 0032). Connecting signs in with Google;
 * Sellora then proves the business owns the store's address with a meta tag on its home
 * page, adds the site and its sitemap, and copies search numbers once a day.
 */
@Injectable()
export class SearchConsoleService {
  private readonly logger = new Logger(SearchConsoleService.name);

  constructor(
    private readonly google: SearchConsoleClient,
    private readonly connections: SeoGoogleRepository,
    private readonly days: SearchConsoleDayRepository,
    private readonly rows: SearchConsoleRowRepository,
    private readonly stores: StoreRepository,
    private readonly products: ProductRepository,
    private readonly links: StoreLinksService,
    private readonly signer: UrlSigner,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly encryption: EncryptionService,
    private readonly entitlements: EntitlementsService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    @InjectModel('SeoGoogle') private readonly connectionModel: Model<SeoGoogle>,
    @InjectQueue(QUEUES.seo) private readonly queue: Queue,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private web(): string {
    return this.config.get('WEB_APP_URL').replace(/\/+$/, '');
  }

  private aad(orgId: string): string {
    return `seo-google:${orgId}`;
  }

  private dto(c: Doc<SeoGoogle> | null) {
    if (!c) return null;
    return {
      status: c.status,
      email: c.email,
      storeId: c.storeId.toHexString(),
      siteUrl: c.siteUrl,
      step: c.step,
      setupError: c.setupError ?? null,
      verifiedAt: c.verifiedAt?.toISOString() ?? null,
      sitemapSubmittedAt: c.sitemapSubmittedAt?.toISOString() ?? null,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      lastSyncError: c.lastSyncError ?? null,
      connectedAt: c.connectedAt.toISOString(),
      connectedBy: c.connectedBy.label ?? null,
    };
  }

  /** Stores Search Console can be connected for: open ones, at their main address. */
  private async openStores() {
    const stores = await this.stores.find({ status: 'live' }, { sort: { createdAt: 1 } });
    return stores.map((s) => ({
      id: s._id.toHexString(),
      name: s.name,
      url: `${this.links.url(s).replace(/\/+$/, '')}/`,
    }));
  }

  async status() {
    const [connection, stores] = await Promise.all([
      this.connections.findOne({}),
      this.openStores(),
    ]);
    return { configured: this.google.configured, connection: this.dto(connection), stores };
  }

  // ---------------------------------------------------------------- connecting

  async connectUrl(storeId: string, userId: string): Promise<{ url: string }> {
    if (!this.google.configured)
      throw AppError.conflict(
        'google_not_configured',
        'Google sign-in is not set up on this server yet.',
      );
    const store = (await this.openStores()).find((s) => s.id === storeId);
    if (!store)
      throw AppError.conflict(
        'store_not_open',
        'Open the store first: Google can only check a store shoppers can visit.',
      );
    const orgId = this.orgId();
    const nonce = randomBytes(18).toString('base64url');
    await this.redis.set(
      `seo-google-state:${nonce}`,
      JSON.stringify({ orgId, userId, storeId }),
      'EX',
      900,
    );
    const state = this.signer.sign({
      p: 'seo-google',
      n: nonce,
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    const user = await this.users.findById(userId);
    return { url: this.google.consentUrl(state, user?.email) };
  }

  /** Google sends the browser back here; returns where to send it on. */
  async callback(q: { code?: string; state?: string; error?: string }): Promise<string> {
    const claims = q.state
      ? this.signer.verify<{ p?: string; n?: string; exp: number }>(q.state)
      : null;
    const saved =
      claims?.p === 'seo-google' && claims.n
        ? await this.redis.getdel(`seo-google-state:${claims.n}`)
        : null;
    if (!saved) return `${this.web()}/app?google=expired`;
    const { orgId, userId, storeId } = JSON.parse(saved) as {
      orgId: string;
      userId: string;
      storeId: string;
    };
    const back = (result: string) =>
      `${this.web()}/app/${orgId}/seo/search-console?google=${result}`;
    if (q.error || !q.code) return back(q.error === 'access_denied' ? 'denied' : 'failed');
    try {
      if (!(await this.entitlements.hasModule(orgId, 'seo'))) return back('failed');
      const tokens = await this.google.exchange(q.code);
      if (
        !tokens.scopes.includes(WEBMASTERS_SCOPE) ||
        !tokens.scopes.includes(SITE_VERIFICATION_SCOPE)
      ) {
        await this.google.revoke(tokens.refreshToken);
        return back('no_permission');
      }
      const user = await this.users.findById(userId);
      await RequestContext.withTenant(
        orgId,
        async () => {
          const store = (await this.openStores()).find((s) => s.id === storeId);
          if (!store) throw new Error('The store is not open any more');
          const before = await this.connections.findOne({});
          await this.connections.findOneAndUpdate(
            {},
            {
              $set: {
                status: 'connected',
                email: tokens.email,
                refreshTokenEnc: this.encryption.encrypt(tokens.refreshToken, this.aad(orgId)),
                scopes: tokens.scopes,
                storeId: new Types.ObjectId(storeId),
                siteUrl: store.url,
                step: 'verify',
                setupAttempts: 0,
                connectedBy: { id: userId, ...(user?.email ? { label: user.email } : {}) },
                connectedAt: new Date(),
              },
              $unset: {
                setupError: 1,
                verifiedAt: 1,
                sitemapSubmittedAt: 1,
                lastSyncError: 1,
                nextSyncAt: 1,
              },
            },
            { upsert: true },
          );
          if (before?.refreshTokenEnc)
            await this.google
              .revoke(this.encryption.decrypt(before.refreshTokenEnc, this.aad(orgId)))
              .catch(() => undefined);
          if (before && before.siteUrl !== store.url) {
            // Another store: its numbers do not belong to this one.
            await this.days.deleteMany({});
            await this.rows.deleteMany({});
          }
          await this.audit.record({
            orgId,
            actor: { type: 'user', id: userId, ...(user?.email ? { label: user.email } : {}) },
            action: 'seo.search_console_connected',
            target: { type: 'store', id: storeId, label: store.url },
            metadata: { google: tokens.email },
          });
        },
        { type: 'user', id: userId },
      );
      await this.queue.add(
        SEO_JOBS.setup,
        { orgId },
        { jobId: `sc-setup-${orgId}-${Date.now()}`, attempts: 1 },
      );
      return back('connected');
    } catch (err) {
      this.logger.error({ err, orgId }, 'Search Console connection failed');
      return back('failed');
    }
  }

  async disconnect(): Promise<void> {
    const orgId = this.orgId();
    const c = await this.connections.findOne({});
    if (!c) return;
    await this.google
      .revoke(this.encryption.decrypt(c.refreshTokenEnc, this.aad(orgId)))
      .catch(() => undefined);
    await this.connections.deleteOne({ _id: c._id });
    await this.days.deleteMany({});
    await this.rows.deleteMany({});
    await this.audit.record({
      orgId,
      action: 'seo.search_console_disconnected',
      target: { type: 'store', id: c.storeId.toHexString(), label: c.siteUrl },
    });
  }

  /** "Try again" after setup stopped, or "Refresh now" once it is done. */
  async retry(): Promise<ReturnType<SearchConsoleService['dto']>> {
    const orgId = this.orgId();
    const c = await this.connections.findOne({});
    if (!c) throw AppError.notFound('search_console', 'Search Console is not connected.');
    if (c.status === 'revoked')
      throw AppError.conflict(
        'google_revoked',
        'Google no longer accepts Sellora for this account. Connect again.',
      );
    const job = c.step === 'done' ? SEO_JOBS.sync : SEO_JOBS.setup;
    await this.connections.updateOne({ _id: c._id }, { $set: { setupAttempts: 0 } });
    await this.queue.add(job, { orgId }, { jobId: `${job}-${orgId}-${Date.now()}`, attempts: 1 });
    return this.dto(await this.connections.findOne({}));
  }

  // ---------------------------------------------------------------- the worker's part

  private async token(c: Doc<SeoGoogle>, orgId: string): Promise<string> {
    return this.google.accessToken(this.encryption.decrypt(c.refreshTokenEnc, this.aad(orgId)));
  }

  private async revoked(c: Doc<SeoGoogle>, orgId: string): Promise<void> {
    await this.connections.updateOne(
      { _id: c._id },
      {
        $set: {
          status: 'revoked',
          lastSyncError: 'Google no longer accepts Sellora for this account. Connect again.',
        },
        $unset: { nextSyncAt: 1 },
      },
    );
    await this.audit.recordSafe({
      orgId,
      action: 'seo.search_console_revoked',
      target: { type: 'store', id: c.storeId.toHexString(), label: c.siteUrl },
    });
  }

  /**
   * Verify the address, add the site, submit the sitemap; each step once. Stops with a
   * reason the business can read, and tries again a few times a minute apart when Google
   * could not see the tag yet.
   */
  async setup(orgId: string): Promise<{ step: string }> {
    return RequestContext.withTenant(orgId, async () => {
      const c = await this.connections.findOne({});
      if (!c || c.status !== 'connected') return { step: 'none' };
      let token: string;
      try {
        token = await this.token(c, orgId);
      } catch (err) {
        if (err instanceof GoogleError && err.kind === 'revoked') await this.revoked(c, orgId);
        return { step: 'token_failed' };
      }
      let step = c.step;
      try {
        if (step === 'verify') {
          const sites = await this.google.sites(token);
          const owned = sites.find((s) => s.siteUrl === c.siteUrl && canUseSite(s.permissionLevel));
          if (!owned) {
            const meta = await this.google.verificationToken(token, c.siteUrl);
            await this.stores.updateOne(
              { _id: c.storeId },
              { $set: { 'seo.googleVerification': meta } },
            );
            await this.google.verify(token, c.siteUrl);
          }
          step = 'add_site';
          await this.connections.updateOne(
            { _id: c._id },
            { $set: { step, verifiedAt: new Date(), setupAttempts: 0 }, $unset: { setupError: 1 } },
          );
        }
        if (step === 'add_site') {
          await this.google.addSite(token, c.siteUrl);
          step = 'sitemap';
          await this.connections.updateOne({ _id: c._id }, { $set: { step } });
        }
        if (step === 'sitemap') {
          await this.google.submitSitemap(token, c.siteUrl, `${c.siteUrl}sitemap.xml`);
          step = 'done';
          await this.connections.updateOne(
            { _id: c._id },
            {
              $set: { step, sitemapSubmittedAt: new Date(), nextSyncAt: new Date() },
              $unset: { setupError: 1 },
            },
          );
          await this.queue.add(
            SEO_JOBS.sync,
            { orgId },
            { jobId: `sc-sync-${orgId}-${Date.now()}`, attempts: 1 },
          );
        }
        return { step };
      } catch (err) {
        if (err instanceof GoogleError && err.kind === 'revoked') {
          await this.revoked(c, orgId);
          return { step: 'revoked' };
        }
        const attempts = c.setupAttempts + 1;
        const message =
          step === 'verify'
            ? `Google could not confirm the store's address yet (${err instanceof Error ? err.message : 'unknown error'}). The store must be open and its home page reachable.`
            : err instanceof Error
              ? err.message
              : 'Google refused the request';
        await this.connections.updateOne(
          { _id: c._id },
          { $set: { setupError: message.slice(0, 500), setupAttempts: attempts } },
        );
        if (attempts < SETUP_MAX_ATTEMPTS)
          await this.queue.add(
            SEO_JOBS.setup,
            { orgId },
            { jobId: `sc-setup-${orgId}-${Date.now()}`, delay: SETUP_RETRY_MS, attempts: 1 },
          );
        this.logger.warn({ orgId, step, attempts, err }, 'Search Console setup stopped');
        return { step: `failed:${step}` };
      }
    });
  }

  /** Copies the last 90 days of totals and the last 28 days of phrases and pages. */
  async sync(orgId: string): Promise<{ days: number; rows: number } | null> {
    return RequestContext.withTenant(orgId, async () => {
      const c = await this.connections.findOne({});
      if (!c || c.status !== 'connected' || c.step !== 'done') return null;
      try {
        const token = await this.token(c, orgId);
        const end = addDays(isoDay(new Date()), -1);
        const daily = await this.google.query(token, c.siteUrl, {
          startDate: addDays(end, -(DAYS_FETCHED - 1)),
          endDate: end,
          dimensions: ['date'],
          rowLimit: DAYS_FETCHED,
        });
        if (daily.length)
          await Promise.all(
            daily.map((r) =>
              this.days.findOneAndUpdate(
                { date: r.keys[0]! },
                {
                  $set: {
                    clicks: r.clicks,
                    impressions: r.impressions,
                    ctr: r.ctr,
                    position: r.position,
                  },
                },
                { upsert: true },
              ),
            ),
          );
        const rowsFrom = addDays(end, -(ROWS_DAYS - 1));
        const found = await this.google.query(token, c.siteUrl, {
          startDate: rowsFrom,
          endDate: end,
          dimensions: ['query', 'page'],
          rowLimit: ROWS_MAX,
        });
        const syncId = randomUUID();
        if (found.length)
          await this.rows.insertMany(
            found
              .filter((r) => r.keys[0] && r.keys[1])
              .map((r) => ({
                syncId,
                query: r.keys[0]!.slice(0, 300),
                page: r.keys[1]!.slice(0, 1000),
                clicks: r.clicks,
                impressions: r.impressions,
                ctr: r.ctr,
                position: r.position,
              })),
          );
        await this.rows.deleteMany({ syncId: { $ne: syncId } });
        await this.connections.updateOne(
          { _id: c._id },
          {
            $set: {
              lastSyncAt: new Date(),
              nextSyncAt: new Date(Date.now() + SYNC_EVERY_MS),
              rowsFrom,
              rowsTo: end,
            },
            $unset: { lastSyncError: 1 },
          },
        );
        return { days: daily.length, rows: found.length };
      } catch (err) {
        if (err instanceof GoogleError && err.kind === 'revoked') {
          await this.revoked(c, orgId);
          return null;
        }
        await this.connections.updateOne(
          { _id: c._id },
          {
            $set: {
              lastSyncError: (err instanceof Error ? err.message : 'Sync failed').slice(0, 500),
              nextSyncAt: new Date(Date.now() + SYNC_RETRY_MS),
            },
          },
        );
        this.logger.warn({ orgId, err }, 'Search Console sync failed');
        return null;
      }
    });
  }

  /** Queues a sync for every connection that is due (the hourly sweep). */
  async sweep(): Promise<{ queued: number }> {
    const due = await this.connectionModel
      .find({ status: 'connected', step: 'done', nextSyncAt: { $lte: new Date() } }, { orgId: 1 })
      .setOptions({ [CROSS_TENANT]: true })
      .limit(500)
      .lean<{ orgId: Types.ObjectId }[]>()
      .exec();
    for (const d of due) {
      const orgId = d.orgId.toHexString();
      await this.queue.add(
        SEO_JOBS.sync,
        { orgId },
        { jobId: `sc-sync-${orgId}-${Math.floor(Date.now() / 3_600_000)}`, attempts: 1 },
      );
    }
    return { queued: due.length };
  }

  // ---------------------------------------------------------------- the report

  async report(daysWanted: 7 | 28 | 90) {
    const c = await this.connections.findOne({});
    if (!c) return { connection: null, ready: false };
    const end = c.rowsTo ?? addDays(isoDay(new Date()), -1);
    const from = addDays(end, -(daysWanted - 1));
    const prevFrom = addDays(from, -daysWanted);
    const [current, previous, rowDocs] = await Promise.all([
      this.days.find({ date: { $gte: from, $lte: end } }, { sort: { date: 1 } }),
      this.days.find({ date: { $gte: prevFrom, $lt: from } }),
      this.rows.find({}, { sort: { impressions: -1 }, limit: ROWS_MAX }),
    ]);
    const rows: QueryPageRow[] = rowDocs.map((r) => ({
      query: r.query,
      page: r.page,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
    const opps = opportunities(rows);
    const slugs = [...new Set(opps.map((o) => productSlugOf(o.page)).filter(Boolean))] as string[];
    const productBySlug = new Map(
      (slugs.length
        ? await this.products.find({ slug: { $in: slugs } }, { projection: { slug: 1, name: 1 } })
        : []
      ).map((p) => [p.slug, { id: p._id.toHexString(), name: p.name }]),
    );
    const series: { date: string; clicks: number; impressions: number }[] = [];
    const byDate = new Map(current.map((d) => [d.date, d]));
    for (let d = from; d <= end; d = addDays(d, 1)) {
      const x = byDate.get(d);
      series.push({ date: d, clicks: x?.clicks ?? 0, impressions: x?.impressions ?? 0 });
    }
    return {
      connection: this.dto(c),
      ready: c.step === 'done' && Boolean(c.lastSyncAt),
      period: { from, to: end, days: daysWanted },
      totals: totals(current),
      previous: totals(previous),
      series,
      rowsPeriod: c.rowsFrom && c.rowsTo ? { from: c.rowsFrom, to: c.rowsTo } : null,
      topQueries: groupBy(rows, 'query'),
      topPages: groupBy(rows, 'page'),
      opportunities: opps.map((o) => {
        const slug = productSlugOf(o.page);
        return { ...o, product: slug ? (productBySlug.get(slug) ?? null) : null };
      }),
    };
  }
}
