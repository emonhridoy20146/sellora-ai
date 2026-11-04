import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { escapeRegex } from '../commerce/text.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import { OrgsService, type OrganizationDoc } from '../orgs/orgs.service.js';
import type { Store, StoreStatus } from './schemas.js';
import { StoreRepository } from './repositories.js';
import { StoreDomainsService } from './store-domains.service.js';
import { StoreLinksService } from './store-links.service.js';
import { StoreNotifier } from './store-notifier.service.js';
import { StoresService, type StoreDoc } from './stores.service.js';

/**
 * The super-admin's side of online stores: the review queue, approving and rejecting
 * stores, and suspending (and reinstating) a store that breaks the rules. Reads cross
 * businesses; every change runs inside the store's own business scope and is audited
 * there, and the owner is told by email.
 */
@Injectable()
export class StoreReviewService {
  constructor(
    @InjectModel('Store') private readonly storeModel: Model<Store>,
    private readonly stores: StoreRepository,
    private readonly merchant: StoresService,
    private readonly orgs: OrgsService,
    private readonly links: StoreLinksService,
    private readonly notifier: StoreNotifier,
    private readonly domains: StoreDomainsService,
    private readonly audit: AuditService,
  ) {}

  private actor() {
    const a = RequestContext.actor();
    return { id: a.id };
  }

  private async load(id: string): Promise<StoreDoc> {
    const store = Types.ObjectId.isValid(id)
      ? await this.storeModel
          .findById(id)
          .setOptions({ [CROSS_TENANT]: true })
          .lean<StoreDoc>()
          .exec()
      : null;
    if (!store) throw AppError.notFound('store');
    return store;
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

  async list(q: { status?: StoreStatus; q?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.q) {
      const re = { $regex: escapeRegex(q.q), $options: 'i' };
      filter.$or = [{ name: re }, { handle: re }];
    }
    // The queue is first come, first served; everything else shows the latest change first.
    const sort: Record<string, 1 | -1> =
      q.status === 'pending' ? { 'review.submittedAt': 1, _id: 1 } : { updatedAt: -1, _id: -1 };
    const [items, total, pending] = await Promise.all([
      this.storeModel
        .find(filter, null, { [CROSS_TENANT]: true })
        .sort(sort)
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<StoreDoc[]>()
        .exec(),
      this.storeModel
        .countDocuments(filter)
        .setOptions({ [CROSS_TENANT]: true })
        .exec(),
      this.storeModel
        .countDocuments({ status: 'pending' })
        .setOptions({ [CROSS_TENANT]: true })
        .exec(),
    ]);
    const orgs = await Promise.all(
      [...new Set(items.map((s) => s.orgId.toHexString()))].map((id) =>
        this.orgs.get(id).catch(() => undefined),
      ),
    );
    const orgById = new Map(orgs.filter(Boolean).map((o) => [o!._id.toHexString(), o!]));
    return {
      items: items.map((s) => ({
        id: s._id.toHexString(),
        name: s.name,
        handle: s.handle,
        url: this.links.url(s),
        status: s.status,
        category: s.category,
        themeKey: s.themeKey,
        org: this.orgSummary(orgById.get(s.orgId.toHexString())),
        flagCount: s.review.flags.length,
        submittedAt: s.review.submittedAt?.toISOString() ?? null,
        decidedAt: s.review.decidedAt?.toISOString() ?? null,
        updatedAt: s.updatedAt.toISOString(),
      })),
      total,
      pending,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async detail(id: string) {
    const store = await this.load(id);
    const org = await this.orgs.get(store.orgId.toHexString());
    return RequestContext.withTenant(org._id.toHexString(), async () => {
      const readiness = await this.merchant.readiness(store);
      return {
        ...this.merchant.toDto(store, readiness),
        org: this.orgSummary(org),
        flags: store.review.flags,
        statusBeforeSuspension: store.statusBeforeSuspension ?? null,
        domains: await this.domains.forStore(store),
        preview: this.links.enabled
          ? this.links.previewUrl(store._id.toHexString(), store.handle)
          : null,
      };
    });
  }

  /** Re-runs the automatic check (after the business changed its products, say). */
  async recheck(id: string) {
    const store = await this.load(id);
    return RequestContext.withTenant(store.orgId.toHexString(), async () => {
      const flags = await this.merchant.precheck(store);
      await this.stores.updateOne({ _id: store._id }, { $set: { 'review.flags': flags } });
      return { flags };
    });
  }

  private async change(
    id: string,
    from: StoreStatus[],
    update: (store: StoreDoc, now: Date) => Record<string, unknown>,
    action: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<StoreDoc> {
    const store = await this.load(id);
    return RequestContext.withTenant(store.orgId.toHexString(), async () => {
      const after = await this.stores.findOneAndUpdate(
        { _id: store._id, status: { $in: from } },
        update(store, new Date()),
      );
      if (!after)
        throw AppError.conflict('invalid_store_status', message, { storeStatus: store.status });
      await this.audit.record({
        action,
        orgId: store.orgId,
        target: { type: 'store', id: store._id.toHexString(), label: store.name },
        metadata: { from: store.status, to: after.status, ...metadata },
      });
      return after;
    });
  }

  async approve(id: string, note?: string): Promise<StoreDoc> {
    const by = this.actor();
    const store = await this.change(
      id,
      ['pending'],
      (s, now) => ({
        $set: {
          status: 'live',
          'review.decidedAt': now,
          'review.decidedBy': by,
          'review.autoApproved': false,
          ...(s.liveSince ? {} : { liveSince: now }),
        },
        $unset: { 'review.reason': '' },
      }),
      'platform.store.approved',
      'Only a store waiting for review can be approved.',
      note ? { note } : {},
    );
    await this.notifier.notifyOwner(store, 'store.approved', (locale) =>
      mailTemplates.storeApproved(locale, {
        storeName: store.name,
        storeUrl: this.links.url(store),
      }),
    );
    return store;
  }

  async reject(id: string, reason: string): Promise<StoreDoc> {
    const by = this.actor();
    const store = await this.change(
      id,
      ['pending'],
      (_s, now) => ({
        $set: {
          status: 'rejected',
          'review.decidedAt': now,
          'review.decidedBy': by,
          'review.reason': reason,
        },
      }),
      'platform.store.rejected',
      'Only a store waiting for review can be rejected.',
      { reason },
    );
    await this.notifier.notifyOwner(store, 'store.rejected', (locale) =>
      mailTemplates.storeRejected(locale, {
        storeName: store.name,
        reason,
        dashboardUrl: this.notifier.dashboardUrl(store),
      }),
    );
    return store;
  }

  async suspend(id: string, reason: string): Promise<StoreDoc> {
    const by = this.actor();
    const store = await this.change(
      id,
      ['draft', 'pending', 'live', 'rejected', 'paused'],
      (s, now) => ({
        $set: {
          status: 'suspended',
          statusBeforeSuspension: s.status,
          'review.decidedAt': now,
          'review.decidedBy': by,
          'review.reason': reason,
        },
      }),
      'platform.store.suspended',
      'This store is already suspended.',
      { reason },
    );
    await this.notifier.notifyOwner(store, 'store.suspended', (locale) =>
      mailTemplates.storeSuspended(locale, {
        storeName: store.name,
        reason,
        dashboardUrl: this.notifier.dashboardUrl(store),
      }),
    );
    return store;
  }

  /** Lifts a suspension: the store goes back to where it was (open stores open again). */
  async reinstate(id: string): Promise<StoreDoc> {
    const by = this.actor();
    const store = await this.change(
      id,
      ['suspended'],
      (s, now) => ({
        $set: {
          status: s.statusBeforeSuspension ?? 'draft',
          'review.decidedAt': now,
          'review.decidedBy': by,
        },
        $unset: { statusBeforeSuspension: '', 'review.reason': '' },
      }),
      'platform.store.reinstated',
      'Only a suspended store can be reinstated.',
    );
    await this.notifier.notifyOwner(store, 'store.reinstated', (locale) =>
      mailTemplates.storeReinstated(locale, {
        storeName: store.name,
        dashboardUrl: this.notifier.dashboardUrl(store),
      }),
    );
    return store;
  }
}
