import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { AppConfig } from '../../config/app-config.js';
import { AuditService } from '../audit/audit.service.js';
import { escapeRegex } from '../commerce/text.js';
import { ProductRepository } from '../commerce/repositories.js';
import { OrgsService, type OrganizationDoc } from '../orgs/orgs.service.js';
import { StoreRepository } from '../stores/repositories.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { StoreNotifier } from '../stores/store-notifier.service.js';
import type { LandingContent } from './blocks.js';
import { LandingPageRepository } from './repositories.js';
import { LandingPagesService, type LandingPageDoc } from './landing-pages.service.js';
import type { LandingPage } from './schemas.js';
import type { StoreDoc } from '../stores/stores.service.js';

/** What the super-admin's list can show. */
export const REVIEW_FILTERS = ['pending', 'live', 'taken_down', 'all'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

/**
 * The super-admin's side of landing pages (ADR 0016): the review queue, approving or
 * rejecting the snapshot a business sent, and taking a page down (or lifting that). Reads
 * cross businesses; every change runs in the page's own business, is audited there, and
 * the owner is told by email.
 */
@Injectable()
export class LandingReviewService {
  constructor(
    @InjectModel('LandingPage') private readonly model: Model<LandingPage>,
    private readonly pages: LandingPageRepository,
    private readonly merchant: LandingPagesService,
    private readonly stores: StoreRepository,
    private readonly products: ProductRepository,
    private readonly orgs: OrgsService,
    private readonly links: StoreLinksService,
    private readonly notifier: StoreNotifier,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private actor() {
    return { id: RequestContext.actor().id };
  }

  /** The page's editor in the merchant dashboard. */
  dashboardUrl(p: Pick<LandingPageDoc, '_id' | 'orgId'>): string {
    const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
    return `${web}/app/${p.orgId.toHexString()}/landing-pages/${p._id.toHexString()}`;
  }

  private async load(id: string): Promise<LandingPageDoc> {
    const page = Types.ObjectId.isValid(id)
      ? await this.model
          .findById(id)
          .setOptions({ [CROSS_TENANT]: true })
          .lean<LandingPageDoc>()
          .exec()
      : null;
    if (!page) throw AppError.notFound('landing_page');
    return page;
  }

  private orgSummary(org: OrganizationDoc | undefined) {
    return org
      ? {
          id: org._id.toHexString(),
          name: org.name,
          status: org.status,
          category: org.category,
          currency: org.currency,
        }
      : null;
  }

  private filterFor(status: ReviewFilter): Record<string, unknown> {
    switch (status) {
      case 'pending':
        return { 'submission.status': 'pending' };
      case 'live':
        return { published: { $exists: true }, takedown: { $exists: false } };
      case 'taken_down':
        return { takedown: { $exists: true } };
      case 'all':
        return {};
    }
  }

  async list(q: { status: ReviewFilter; q?: string; page: number; pageSize: number }) {
    const filter = this.filterFor(q.status);
    if (q.q) {
      const re = { $regex: escapeRegex(q.q), $options: 'i' };
      filter.$or = [{ name: re }, { slug: re }];
    }
    // The queue is first come, first served; everything else shows the latest change first.
    const sort: Record<string, 1 | -1> =
      q.status === 'pending' ? { 'submission.submittedAt': 1, _id: 1 } : { updatedAt: -1, _id: -1 };
    const [items, total, pending] = await Promise.all([
      this.model
        .find(filter, { draft: 0, 'submission.content': 0, 'published.content': 0 })
        .setOptions({ [CROSS_TENANT]: true })
        .sort(sort)
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<LandingPageDoc[]>()
        .exec(),
      this.model
        .countDocuments(filter)
        .setOptions({ [CROSS_TENANT]: true })
        .exec(),
      this.model
        .countDocuments({ 'submission.status': 'pending' })
        .setOptions({ [CROSS_TENANT]: true })
        .exec(),
    ]);
    const orgIds = [...new Set(items.map((p) => p.orgId.toHexString()))];
    const [orgs, stores] = await Promise.all([
      Promise.all(orgIds.map((id) => this.orgs.get(id).catch(() => undefined))),
      this.storesById(items),
    ]);
    const orgById = new Map(orgs.filter(Boolean).map((o) => [o!._id.toHexString(), o!]));
    return {
      items: items.map((p) => {
        const store = stores.get(p.storeId.toHexString()) ?? null;
        return {
          ...this.merchant.toDto(p, store),
          org: this.orgSummary(orgById.get(p.orgId.toHexString())),
          flagCount: p.submission?.flags.length ?? 0,
        };
      }),
      total,
      pending,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** The stores of the listed pages, each read inside its own business. */
  private async storesById(items: Pick<LandingPageDoc, 'orgId' | 'storeId'>[]) {
    const byOrg = new Map<string, Set<string>>();
    for (const p of items) {
      const set = byOrg.get(p.orgId.toHexString()) ?? new Set<string>();
      set.add(p.storeId.toHexString());
      byOrg.set(p.orgId.toHexString(), set);
    }
    const out = new Map<string, StoreDoc>();
    for (const [orgId, ids] of byOrg) {
      const found = await RequestContext.withTenant(orgId, () =>
        this.stores.find({ _id: { $in: [...ids].map((i) => new Types.ObjectId(i)) } }),
      );
      for (const s of found) out.set(s._id.toHexString(), s);
    }
    return out;
  }

  /** Products named in an offer, for the reviewer to see what the page sells. */
  private async offerProducts(content: LandingContent | undefined) {
    if (!content) return [];
    const ids = [content.offer.productId, content.offer.addOn?.productId].filter((x): x is string =>
      Boolean(x),
    );
    if (ids.length === 0) return [];
    const found = await this.products.find({
      _id: { $in: ids.map((i) => new Types.ObjectId(i)) },
    });
    return found.map((p) => ({
      id: p._id.toHexString(),
      name: p.name,
      description: p.description,
      status: p.status,
      image: p.images[0]?.url ?? null,
      priceMinor: Math.min(...p.variants.map((v) => v.priceMinor)),
      currency: p.currency,
      role: p._id.toHexString() === content.offer.productId ? 'main' : 'add_on',
    }));
  }

  async detail(id: string) {
    const page = await this.load(id);
    const org = await this.orgs.get(page.orgId.toHexString());
    return RequestContext.withTenant(org._id.toHexString(), async () => {
      const store = await this.stores.findById(page.storeId);
      const pending = page.submission?.status === 'pending';
      const reviewed = pending ? page.submission!.content : page.published?.content;
      return {
        ...this.merchant.toDto(page, store),
        org: this.orgSummary(org),
        submissionContent: page.submission?.content ?? null,
        publishedContent: page.published?.content ?? null,
        products: await this.offerProducts(reviewed),
        preview:
          pending && this.links.enabled && store
            ? this.links.landingPreviewUrl(
                { id: page._id.toHexString(), slug: page.slug },
                store.handle,
                'submission',
              )
            : null,
      };
    });
  }

  private async notify(
    page: LandingPageDoc,
    category: string,
    render: Parameters<StoreNotifier['notifyOwner']>[2],
  ) {
    await this.notifier.notifyOwner(page, category, render);
  }

  /**
   * Publishes the snapshot the reviewer looked at. `revision` is the snapshot's: if the
   * business sent a newer one in between, the approval is refused so nobody approves
   * something they did not see.
   */
  async approve(id: string, revision: number, note?: string) {
    const loaded = await this.load(id);
    const by = this.actor();
    return RequestContext.withTenant(loaded.orgId.toHexString(), async () => {
      const page = await this.merchant.get(id);
      const sub = page.submission;
      if (!sub || sub.status !== 'pending')
        throw AppError.conflict('not_in_review', 'This page has nothing waiting for review.');
      if (sub.revision !== revision)
        throw AppError.conflict(
          'submission_changed',
          'The business sent a newer version since you opened this page. Look at it again.',
          { revision: sub.revision },
        );
      const { page: after, outcome } = await this.merchant.applyApproval(page, by, false);
      await this.audit.record({
        action: 'platform.landing_page.approved',
        orgId: page.orgId,
        target: { type: 'landing_page', id: page._id.toHexString(), label: page.name },
        metadata: {
          outcome,
          revision,
          ...(outcome === 'published' ? { version: after.published!.version } : {}),
          ...(outcome === 'scheduled'
            ? { publishAt: after.scheduled!.publishAt.toISOString() }
            : {}),
          ...(note ? { note } : {}),
        },
      });
      const store = await this.stores.findById(page.storeId);
      if (store && outcome === 'published')
        await this.notify(after, 'landing_page.approved', (locale) =>
          mailTemplates.landingApproved(locale, {
            pageName: after.name,
            pageUrl: this.merchant.pageUrl(store, after.slug),
          }),
        );
      else if (outcome !== 'published') {
        const org = await this.orgs.get(page.orgId.toHexString());
        await this.notify(after, 'landing_page.approved', (locale) =>
          mailTemplates.landingApprovedLater(locale, {
            pageName: after.name,
            kind: outcome,
            when:
              outcome === 'scheduled'
                ? new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: org.timezone,
                  }).format(after.scheduled!.publishAt)
                : '',
            dashboardUrl: this.dashboardUrl(after),
          }),
        );
      }
      return this.merchant.toDto(after, store);
    });
  }

  async reject(id: string, revision: number, reason: string) {
    const loaded = await this.load(id);
    const by = this.actor();
    return RequestContext.withTenant(loaded.orgId.toHexString(), async () => {
      const after = await this.pages.findOneAndUpdate(
        { _id: loaded._id, 'submission.status': 'pending', 'submission.revision': revision },
        {
          $set: {
            'submission.status': 'rejected',
            'submission.decidedAt': new Date(),
            'submission.decidedBy': by,
            'submission.reason': reason,
          },
        },
      );
      if (!after) {
        const now = await this.merchant.get(id);
        if (now.submission?.status === 'pending')
          throw AppError.conflict(
            'submission_changed',
            'The business sent a newer version since you opened this page. Look at it again.',
            { revision: now.submission.revision },
          );
        throw AppError.conflict('not_in_review', 'This page has nothing waiting for review.');
      }
      await this.audit.record({
        action: 'platform.landing_page.rejected',
        orgId: after.orgId,
        target: { type: 'landing_page', id: after._id.toHexString(), label: after.name },
        metadata: { revision, reason },
      });
      await this.notify(after, 'landing_page.rejected', (locale) =>
        mailTemplates.landingRejected(locale, {
          pageName: after.name,
          reason,
          live: Boolean(after.published && !after.takedown && !after.paused),
          dashboardUrl: this.dashboardUrl(after),
        }),
      );
      return this.merchant.toDto(after, await this.stores.findById(after.storeId));
    });
  }

  /**
   * Takes a page off the store: shoppers see that it is unavailable. A snapshot waiting
   * for review is turned down with the same reason. The page stays for the record.
   */
  async takedown(id: string, reason: string) {
    const loaded = await this.load(id);
    const by = this.actor();
    return RequestContext.withTenant(loaded.orgId.toHexString(), async () => {
      const now = new Date();
      const pending = loaded.submission?.status === 'pending';
      const taken = await this.pages.findOneAndUpdate(
        { _id: loaded._id, takedown: { $exists: false } },
        {
          $set: {
            takedown: { reason, at: now, by },
            ...(pending
              ? {
                  'submission.status': 'rejected',
                  'submission.decidedAt': now,
                  'submission.decidedBy': by,
                  'submission.reason': reason,
                }
              : {}),
          },
        },
      );
      if (!taken) throw AppError.conflict('already_taken_down', 'This page is already taken down.');
      // A running A/B test ends without a winner and a scheduled version is dropped (ADR 0031).
      const after = await this.merchant.afterTakedown(taken);
      await this.audit.record({
        action: 'platform.landing_page.taken_down',
        orgId: after.orgId,
        target: { type: 'landing_page', id: after._id.toHexString(), label: after.name },
        metadata: { reason, wasLive: Boolean(after.published && !after.paused) },
      });
      await this.notify(after, 'landing_page.taken_down', (locale) =>
        mailTemplates.landingTakenDown(locale, {
          pageName: after.name,
          reason,
          dashboardUrl: this.dashboardUrl(after),
        }),
      );
      return this.merchant.toDto(after, await this.stores.findById(after.storeId));
    });
  }

  /** Lifts a takedown: a page that was published shows its last approved version again. */
  async reinstate(id: string) {
    const loaded = await this.load(id);
    return RequestContext.withTenant(loaded.orgId.toHexString(), async () => {
      const after = await this.pages.findOneAndUpdate(
        { _id: loaded._id, takedown: { $exists: true } },
        { $unset: { takedown: '' } },
      );
      if (!after) throw AppError.conflict('not_taken_down', 'This page is not taken down.');
      await this.audit.record({
        action: 'platform.landing_page.reinstated',
        orgId: after.orgId,
        target: { type: 'landing_page', id: after._id.toHexString(), label: after.name },
      });
      const store = await this.stores.findById(after.storeId);
      await this.notify(after, 'landing_page.reinstated', (locale) =>
        mailTemplates.landingReinstated(locale, {
          pageName: after.name,
          live: Boolean(after.published && !after.paused),
          pageUrl: store ? this.merchant.pageUrl(store, after.slug) : this.dashboardUrl(after),
          dashboardUrl: this.dashboardUrl(after),
        }),
      );
      return this.merchant.toDto(after, store);
    });
  }
}
