import { HttpStatus, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { slugify } from '../../common/utils/slug.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import type { Product } from '../commerce/schemas.js';
import { FilesService } from '../files/files.service.js';
import type { FileRef } from '../files/schemas.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import { StoreRepository } from '../stores/repositories.js';
import type { Store } from '../stores/schemas.js';
import type { LandingPreviewKind } from '../stores/store-links.service.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { precheckStore } from '../stores/store-precheck.js';
import {
  contentImages,
  contentTexts,
  dayKey,
  landingContentSchema,
  publishProblems,
  slugProblem,
  SLUG_MESSAGES,
  withImageUrls,
  type LandingContent,
  type LandingLanguage,
  type OfferProducts,
} from './blocks.js';
import {
  LandingPageRepository,
  LandingPageStatRepository,
  LandingPageVersionRepository,
} from './repositories.js';
import { landingStatus, type LandingPage, type LandingPageVersion } from './schemas.js';
import { templateContent, type TemplateKey } from './templates.js';

export type LandingPageDoc = WithId<LandingPage>;
type StoreDoc = WithId<Store>;
type ProductDoc = WithId<Product>;
type VersionDoc = WithId<LandingPageVersion>;

/** Published versions kept per page; older ones are removed. */
export const VERSIONS_KEPT = 20;
/** Days of numbers shown in the dashboard. */
export const STATS_DAYS = 30;

export interface CreateLandingInput {
  storeId: string;
  name: string;
  slug?: string;
  productId: string;
  template: TemplateKey;
  language?: LandingLanguage;
}

export interface LandingTotals {
  visitors: number;
  orders: number;
  revenueMinor: number;
}

const ZERO: LandingTotals = { visitors: 0, orders: 0, revenueMinor: 0 };

/**
 * A business's landing pages (ADR 0016), merchant side: making and editing pages, sending
 * a version for review (or publishing it at once with automatic approval), pausing,
 * copying, deleting, earlier versions and the numbers. Shoppers' side and the
 * super-admin's side live in their own services.
 */
@Injectable()
export class LandingPagesService {
  constructor(
    private readonly pages: LandingPageRepository,
    private readonly versions: LandingPageVersionRepository,
    private readonly stats: LandingPageStatRepository,
    private readonly stores: StoreRepository,
    private readonly products: ProductRepository,
    private readonly orgs: OrgsService,
    private readonly files: FilesService,
    private readonly entitlements: EntitlementsService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly links: StoreLinksService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private actorRef() {
    return { id: RequestContext.actor().id };
  }

  private pageRef(id: Types.ObjectId | string): FileRef {
    return { type: 'landing_page', id: String(id) };
  }

  private versionRef(id: Types.ObjectId | string): FileRef {
    return { type: 'landing_page_version', id: String(id) };
  }

  private target(p: Pick<LandingPageDoc, '_id' | 'name'>) {
    return { type: 'landing_page', id: p._id.toHexString(), label: p.name };
  }

  // ---------------------------------------------------------------- dto

  /** Where the page lives for shoppers. */
  pageUrl(store: Pick<StoreDoc, 'handle' | 'primaryDomain'>, slug: string): string {
    return `${this.links.url(store)}/${slug}`;
  }

  toDto(p: LandingPageDoc, store: StoreDoc | null, totals?: LandingTotals) {
    return {
      id: p._id.toHexString(),
      storeId: p.storeId.toHexString(),
      store: store
        ? {
            id: store._id.toHexString(),
            name: store.name,
            handle: store.handle,
            status: store.status,
            url: this.links.url(store),
          }
        : null,
      name: p.name,
      slug: p.slug,
      language: p.language,
      url: store ? this.pageUrl(store, p.slug) : null,
      status: landingStatus(p),
      revision: p.revision,
      /** The draft differs from what shoppers see (or nothing is published yet). */
      hasUnpublishedChanges: !p.published || p.published.revision !== p.revision,
      /** Once a page has been published its address stays, so ads keep working. */
      slugLocked: Boolean(p.published),
      // Lists leave the draft out, so the product is only known on the detail.
      productId: (p.draft as LandingContent | undefined)?.offer.productId ?? null,
      submission: p.submission
        ? {
            status: p.submission.status,
            revision: p.submission.revision,
            submittedAt: p.submission.submittedAt.toISOString(),
            decidedAt: p.submission.decidedAt?.toISOString() ?? null,
            reason: p.submission.reason ?? null,
            flags: p.submission.flags,
          }
        : null,
      published: p.published
        ? {
            version: p.published.version,
            revision: p.published.revision,
            publishedAt: p.published.publishedAt.toISOString(),
            autoApproved: p.published.autoApproved,
          }
        : null,
      paused: p.paused,
      takedown: p.takedown ? { reason: p.takedown.reason, at: p.takedown.at.toISOString() } : null,
      ...(totals ? { last30Days: totals } : {}),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  /** The page with its draft, for the editor. */
  detailDto(p: LandingPageDoc, store: StoreDoc | null, totals?: LandingTotals) {
    return { ...this.toDto(p, store, totals), draft: p.draft };
  }

  // ---------------------------------------------------------------- reads

  async get(id: string): Promise<LandingPageDoc> {
    const page = await this.pages.findById(id);
    if (!page) throw AppError.notFound('landing_page');
    return page;
  }

  private async storeOf(p: Pick<LandingPageDoc, 'storeId'>): Promise<StoreDoc | null> {
    return this.stores.findById(p.storeId);
  }

  async detail(id: string) {
    const page = await this.get(id);
    const [store, totals] = await Promise.all([
      this.storeOf(page),
      this.totals([page._id]).then((m) => m.get(page._id.toHexString()) ?? ZERO),
    ]);
    return this.detailDto(page, store, totals);
  }

  async list() {
    const [items, ent] = await Promise.all([
      this.pages.find({}, { sort: { createdAt: -1 }, projection: { draft: 0 } as never }),
      this.entitlements.forOrg(this.orgId()),
    ]);
    const storeIds = [...new Set(items.map((p) => p.storeId.toHexString()))];
    const [stores, totals] = await Promise.all([
      storeIds.length
        ? this.stores.find({ _id: { $in: storeIds.map((i) => new Types.ObjectId(i)) } })
        : Promise.resolve([]),
      this.totals(items.map((p) => p._id)),
    ]);
    const byId = new Map(stores.map((s) => [s._id.toHexString(), s]));
    return {
      items: items.map((p) => {
        return this.toDto(
          p,
          byId.get(p.storeId.toHexString()) ?? null,
          totals.get(p._id.toHexString()) ?? ZERO,
        );
      }),
      limit: ent.limits.landingPages,
      used: items.length,
    };
  }

  /** Visitors, orders and order value per page over the last 30 days. */
  async totals(pageIds: Types.ObjectId[]): Promise<Map<string, LandingTotals>> {
    const out = new Map<string, LandingTotals>();
    if (pageIds.length === 0) return out;
    const org = await this.orgs.get(this.orgId());
    const since = dayKey(new Date(Date.now() - (STATS_DAYS - 1) * 86_400_000), org.timezone);
    const rows = await this.stats.find({ pageId: { $in: pageIds }, day: { $gte: since } });
    for (const r of rows) {
      const key = r.pageId.toHexString();
      const t = out.get(key) ?? { ...ZERO };
      t.visitors += r.visitors;
      t.orders += r.orders;
      t.revenueMinor += r.revenueMinor;
      out.set(key, t);
    }
    return out;
  }

  /** Day-by-day numbers for one page, oldest first, with days without visits filled in. */
  async daily(id: string, days = STATS_DAYS) {
    const page = await this.get(id);
    const org = await this.orgs.get(this.orgId());
    const keys = Array.from({ length: days }, (_, i) =>
      dayKey(new Date(Date.now() - (days - 1 - i) * 86_400_000), org.timezone),
    );
    const rows = await this.stats.find({ pageId: page._id, day: { $gte: keys[0]! } });
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const items = keys.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        visitors: r?.visitors ?? 0,
        orders: r?.orders ?? 0,
        revenueMinor: r?.revenueMinor ?? 0,
      };
    });
    const total = items.reduce(
      (a, d) => ({
        visitors: a.visitors + d.visitors,
        orders: a.orders + d.orders,
        revenueMinor: a.revenueMinor + d.revenueMinor,
      }),
      { ...ZERO },
    );
    return {
      days: items,
      total,
      conversionRate: total.visitors ? total.orders / total.visitors : null,
      currency: org.currency,
    };
  }

  // ---------------------------------------------------------------- addresses

  private async assertSlug(storeId: Types.ObjectId, slug: string, exceptId?: Types.ObjectId) {
    const problem = slugProblem(slug);
    if (problem) throw AppError.validation([{ path: 'slug', message: SLUG_MESSAGES[problem] }]);
    const taken = await this.pages.exists({
      storeId,
      slug,
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    });
    if (taken)
      throw AppError.conflict('slug_taken', 'Another page of this store uses this address.', {
        errors: [{ path: 'slug', message: 'Another page of this store uses this address' }],
      });
  }

  /** Whether a page address is free on a store, for the live check while typing. */
  async slugCheck(storeId: string, slug: string) {
    const store = await this.requireStore(storeId);
    const problem = slugProblem(slug);
    if (problem) return { slug, available: false, reason: SLUG_MESSAGES[problem] };
    const taken = await this.pages.exists({ storeId: store._id, slug });
    return {
      slug,
      available: !taken,
      reason: taken ? 'Another page of this store uses this address' : null,
      url: this.pageUrl(store, slug),
    };
  }

  /** A free slug made from `name`, adding -2, -3 … when taken. */
  private async freeSlug(storeId: Types.ObjectId, name: string): Promise<string> {
    let base = slugify(name, 50, 3);
    if (slugProblem(base)) base = 'offer';
    for (let n = 1; n < 50; n += 1) {
      const candidate = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
      if (slugProblem(candidate)) continue;
      if (!(await this.pages.exists({ storeId, slug: candidate }))) return candidate;
    }
    return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
  }

  private async requireStore(storeId: string): Promise<StoreDoc> {
    const store = await this.stores.findById(storeId);
    if (!store)
      throw AppError.validation([{ path: 'storeId', message: 'This store no longer exists' }]);
    if (store.status === 'suspended')
      throw AppError.conflict(
        'store_suspended',
        'This store is suspended by Sellora, so its pages cannot change.',
      );
    return store;
  }

  // ---------------------------------------------------------------- products in the offer

  /** Refuses a draft whose offer names products or options that do not exist. */
  private async assertOfferRefs(content: LandingContent): Promise<void> {
    const { offer } = content;
    const ids = [offer.productId, offer.addOn?.productId].filter((x): x is string => Boolean(x));
    if (ids.length === 0) return;
    const found = await this.products.find(
      { _id: { $in: ids.map((i) => new Types.ObjectId(i)) } },
      { projection: { _id: 1, variants: 1 } },
    );
    const byId = new Map(found.map((p) => [p._id.toHexString(), p]));
    const errors: FieldError[] = [];
    if (offer.productId && !byId.has(offer.productId))
      errors.push({ path: 'content.offer.productId', message: 'This product no longer exists' });
    if (offer.addOn) {
      const p = byId.get(offer.addOn.productId);
      if (!p)
        errors.push({
          path: 'content.offer.addOn.productId',
          message: 'This product no longer exists',
        });
      else if (!p.variants.some((v) => v._id.toHexString() === offer.addOn!.variantId))
        errors.push({
          path: 'content.offer.addOn.variantId',
          message: 'This option no longer exists',
        });
    }
    if (errors.length) throw AppError.validation(errors);
  }

  private async offerProducts(content: LandingContent): Promise<OfferProducts> {
    const org = await this.orgs.get(this.orgId());
    const load = async (id: string | null | undefined) => {
      if (!id) return null;
      const p: ProductDoc | null = await this.products.findById(id);
      return p
        ? {
            active: p.status === 'active',
            currencyOk: p.currency === org.currency,
            variantIds: p.variants.map((v) => v._id.toHexString()),
          }
        : null;
    };
    const [product, addOn] = await Promise.all([
      load(content.offer.productId),
      load(content.offer.addOn?.productId),
    ]);
    return { product, addOn };
  }

  // ---------------------------------------------------------------- pictures

  /** Every picture the page's draft, snapshot under review and published version use. */
  private pageImageIds(
    p: Pick<LandingPage, 'draft'> & Partial<Pick<LandingPage, 'submission' | 'published'>>,
  ): string[] {
    const all = [
      ...contentImages(p.draft),
      ...(p.submission ? contentImages(p.submission.content) : []),
      ...(p.published ? contentImages(p.published.content) : []),
    ];
    return [...new Set(all.map((i) => i.fileId))];
  }

  /**
   * Marks the draft's pictures as used by the page and fills in their URLs. Safe inside a
   * transaction.
   */
  private async attachDraft(pageId: Types.ObjectId, content: LandingContent) {
    const images = contentImages(content);
    const files = await this.files.attach(
      images.map((i) => i.fileId),
      this.pageRef(pageId),
      'store_asset',
      (i) => images[i]!.path,
    );
    return withImageUrls(content, (fileId) => this.files.publicUrl(files.get(fileId)!));
  }

  // ---------------------------------------------------------------- create and edit

  async create(input: CreateLandingInput) {
    const orgId = this.orgId();
    await this.entitlements.assertWithinLimit(orgId, 'landingPages', await this.pages.count());
    const store = await this.requireStore(input.storeId);
    const product = await this.products.findById(input.productId);
    if (!product)
      throw AppError.validation([{ path: 'productId', message: 'This product no longer exists' }]);
    const language = input.language ?? store.language;
    const slug = input.slug ?? (await this.freeSlug(store._id, input.name || product.name));
    await this.assertSlug(store._id, slug);
    const draft = landingContentSchema.parse(
      templateContent(input.template, language, {
        id: product._id.toHexString(),
        name: product.name,
        description: product.description,
      }),
    );
    let page: LandingPageDoc;
    try {
      page = await this.pages.create({
        storeId: store._id,
        name: input.name,
        slug,
        language,
        draft,
        revision: 1,
        paused: false,
        createdBy: this.actorRef(),
      });
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('slug_taken', 'Another page of this store uses this address.');
      throw err;
    }
    await this.audit.record({
      action: 'landing_page.created',
      orgId,
      target: this.target(page),
      metadata: { storeId: store._id.toHexString(), slug, template: input.template },
    });
    return this.detailDto(page, store, ZERO);
  }

  /** Renames the page, or changes its address (only before it is first published). */
  async updateSettings(
    id: string,
    patch: { name?: string; slug?: string; language?: LandingLanguage },
  ) {
    const page = await this.get(id);
    const store = await this.requireStore(page.storeId.toHexString());
    if (patch.slug !== undefined && patch.slug !== page.slug) {
      if (page.published)
        throw AppError.conflict(
          'slug_locked',
          'The address of a published page cannot change: ads and shared links point to it. Duplicate the page to use another address.',
        );
      await this.assertSlug(store._id, patch.slug, page._id);
    }
    const $set: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.slug !== undefined) $set.slug = patch.slug;
    if (patch.language !== undefined) $set.language = patch.language;
    if (Object.keys($set).length === 0) return this.detailDto(page, store);
    let after: LandingPageDoc | null;
    try {
      after = await this.pages.findOneAndUpdate({ _id: page._id }, { $set });
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('slug_taken', 'Another page of this store uses this address.');
      throw err;
    }
    await this.audit.record({
      action: 'landing_page.settings_saved',
      orgId: this.orgId(),
      target: this.target(after!),
      metadata: patch,
    });
    return this.detailDto(after!, store);
  }

  /**
   * Saves the draft. `revision` is the one the editor loaded: if someone saved in between,
   * the save is refused rather than silently overwriting their work.
   */
  async saveDraft(id: string, content: LandingContent, revision: number) {
    const before = await this.get(id);
    const store = await this.requireStore(before.storeId.toHexString());
    if (before.revision !== revision)
      throw AppError.conflict(
        'page_changed',
        'Someone else saved this page while you were editing. Reload it to see their changes.',
        { revision: before.revision },
      );
    await this.assertOfferRefs(content);
    const ref = this.pageRef(before._id);
    const beforeIds = this.pageImageIds(before);
    const afterIds = this.pageImageIds({ ...before, draft: content });
    const dropped = beforeIds.filter((f) => !afterIds.includes(f));
    const after = await this.tx.run(async () => {
      const draft = await this.attachDraft(before._id, content);
      await this.files.detach(dropped, ref);
      return this.pages.findOneAndUpdate(
        { _id: before._id, revision },
        { $set: { draft }, $inc: { revision: 1 } },
      );
    });
    if (!after)
      throw AppError.conflict(
        'page_changed',
        'Someone else saved this page while you were editing. Reload it to see their changes.',
      );
    await this.files.removeIfUnused(dropped);
    await this.audit.record({
      action: 'landing_page.saved',
      orgId: this.orgId(),
      target: this.target(after),
      metadata: { revision: after.revision, sections: content.sections.length },
    });
    return this.detailDto(after, store);
  }

  // ---------------------------------------------------------------- publishing

  /**
   * Sends the current draft for review, or publishes it at once when the platform approves
   * landing pages automatically and the word check finds nothing. A page Sellora took down
   * always goes to a person.
   */
  async submit(id: string) {
    const page = await this.get(id);
    const store = await this.requireStore(page.storeId.toHexString());
    if (page.published && page.published.revision === page.revision && !page.takedown)
      throw AppError.conflict('nothing_to_publish', 'Shoppers already see this version.');
    if (page.submission?.status === 'pending' && page.submission.revision === page.revision)
      throw AppError.conflict('already_in_review', 'This version is already waiting for review.');
    const problems = publishProblems(page.draft, await this.offerProducts(page.draft));
    if (problems.length)
      throw AppError.unprocessable('page_not_ready', 'The page is not ready to publish yet.', {
        errors: problems,
      });
    const flags = await this.precheck(page.name, page.draft);
    const settings = await this.platformSettings.get();
    const auto = settings.stores.autoApproveLandingPages && flags.length === 0 && !page.takedown;
    const now = new Date();
    if (auto) {
      const after = await this.publish(page, page.draft, page.revision, { id: 'auto' }, true);
      await this.audit.record({
        action: 'landing_page.published',
        orgId: this.orgId(),
        target: this.target(after),
        metadata: { version: after.published!.version, autoApproved: true },
      });
      return this.detailDto(after, store);
    }
    const after = await this.pages.findOneAndUpdate(
      { _id: page._id, revision: page.revision },
      {
        $set: {
          submission: {
            status: 'pending',
            revision: page.revision,
            content: page.draft,
            submittedAt: now,
            submittedBy: this.actorRef(),
            flags,
          },
        },
      },
    );
    if (!after)
      throw AppError.conflict(
        'page_changed',
        'The page changed while sending it. Refresh and try again.',
      );
    await this.audit.record({
      action: 'landing_page.submitted',
      orgId: this.orgId(),
      target: this.target(after),
      metadata: { revision: page.revision, flags: flags.length },
    });
    return this.detailDto(after, store);
  }

  /** The automatic word check over the page's text and the products it sells. */
  async precheck(name: string, content: LandingContent) {
    const texts = contentTexts(name, content);
    const ids = [content.offer.productId, content.offer.addOn?.productId].filter((x): x is string =>
      Boolean(x),
    );
    const products = ids.length
      ? await this.products.find({ _id: { $in: ids.map((i) => new Types.ObjectId(i)) } })
      : [];
    for (const p of products)
      texts.push({
        where: `product:${p._id.toHexString()}`,
        label: `Product: ${p.name}`,
        text: `${p.name} ${p.description}`,
      });
    return precheckStore(texts);
  }

  /**
   * Makes `content` (a snapshot taken at draft `revision`) the published version: keeps it
   * as a version, clears the review and any takedown, and trims old versions. Runs in the
   * page's business; used by automatic approval and by the super-admin.
   */
  async publish(
    page: LandingPageDoc,
    content: LandingContent,
    revision: number,
    by: { id: string },
    autoApproved: boolean,
  ): Promise<LandingPageDoc> {
    const now = new Date();
    const latest = await this.versions.findOne({ pageId: page._id }, undefined, {
      sort: { version: -1 },
    });
    const version = Math.max(latest?.version ?? 0, page.published?.version ?? 0) + 1;
    const published = { version, revision, content, publishedAt: now, autoApproved };
    const beforeIds = this.pageImageIds(page);
    const afterIds = this.pageImageIds({ draft: page.draft, published });
    const dropped = beforeIds.filter((f) => !afterIds.includes(f));
    const images = contentImages(content).map((i) => i.fileId);

    const { after, pruned } = await this.tx.run(async () => {
      const saved = await this.versions.create({
        pageId: page._id,
        version,
        content,
        publishedAt: now,
        approvedBy: by,
        autoApproved,
      });
      if (images.length)
        await this.files.attach(images, this.versionRef(saved._id), 'store_asset', () => 'content');
      await this.files.detach(dropped, this.pageRef(page._id));
      const updated = await this.pages.findOneAndUpdate(
        { _id: page._id },
        { $set: { published }, $unset: { submission: '', takedown: '' } },
      );
      if (!updated) throw AppError.notFound('landing_page');
      const old: VersionDoc[] = await this.versions.find(
        { pageId: page._id },
        { sort: { version: -1 }, skip: VERSIONS_KEPT },
      );
      for (const v of old) {
        await this.files.detach(
          contentImages(v.content).map((i) => i.fileId),
          this.versionRef(v._id),
        );
        await this.versions.deleteOne({ _id: v._id });
      }
      return { after: updated, pruned: old };
    });
    await this.files.removeIfUnused([
      ...dropped,
      ...pruned.flatMap((v) => contentImages(v.content).map((i) => i.fileId)),
    ]);
    return after;
  }

  /** Takes the snapshot out of the review queue. */
  async withdraw(id: string) {
    const page = await this.get(id);
    const after = await this.pages.findOneAndUpdate(
      { _id: page._id, 'submission.status': 'pending' },
      { $unset: { submission: '' } },
    );
    if (!after)
      throw AppError.conflict(
        'not_in_review',
        'Only a version waiting for review can be taken back.',
      );
    await this.dropSnapshotImages(page, after);
    await this.audit.record({
      action: 'landing_page.withdrawn',
      orgId: this.orgId(),
      target: this.target(after),
    });
    return this.detailDto(after, await this.storeOf(after));
  }

  /** Releases pictures only the removed snapshot used. */
  private async dropSnapshotImages(before: LandingPageDoc, after: LandingPageDoc) {
    const keep = this.pageImageIds(after);
    const dropped = this.pageImageIds(before).filter((f) => !keep.includes(f));
    if (dropped.length === 0) return;
    await this.files.detach(dropped, this.pageRef(before._id));
    await this.files.removeIfUnused(dropped);
  }

  private async setPaused(id: string, paused: boolean) {
    const page = await this.get(id);
    if (!page.published || page.takedown)
      throw AppError.conflict(
        'page_not_live',
        paused ? 'Only a live page can be paused.' : 'Only a paused page can be opened again.',
      );
    const after = await this.pages.findOneAndUpdate(
      { _id: page._id, paused: !paused },
      { $set: { paused } },
    );
    if (!after)
      throw AppError.conflict(
        'page_not_live',
        paused ? 'This page is already paused.' : 'This page is not paused.',
      );
    await this.audit.record({
      action: paused ? 'landing_page.paused' : 'landing_page.resumed',
      orgId: this.orgId(),
      target: this.target(after),
    });
    return this.detailDto(after, await this.storeOf(after));
  }

  pause(id: string) {
    return this.setPaused(id, true);
  }

  resume(id: string) {
    return this.setPaused(id, false);
  }

  // ---------------------------------------------------------------- copies, versions, removal

  async duplicate(id: string, input: { name?: string; slug?: string }) {
    const orgId = this.orgId();
    const source = await this.get(id);
    await this.entitlements.assertWithinLimit(orgId, 'landingPages', await this.pages.count());
    const store = await this.requireStore(source.storeId.toHexString());
    const name = input.name ?? `${source.name} (copy)`.slice(0, 80);
    const slug = input.slug ?? (await this.freeSlug(store._id, `${source.slug}-copy`));
    await this.assertSlug(store._id, slug);
    const _id = new Types.ObjectId();
    const page = await this.tx.run(async () => {
      const draft = await this.attachDraft(_id, source.draft);
      return this.pages.create({
        _id,
        storeId: store._id,
        name,
        slug,
        language: source.language,
        draft,
        revision: 1,
        paused: false,
        createdBy: this.actorRef(),
      });
    });
    await this.audit.record({
      action: 'landing_page.duplicated',
      orgId,
      target: this.target(page),
      metadata: { from: source._id.toHexString() },
    });
    return this.detailDto(page, store, ZERO);
  }

  async listVersions(id: string) {
    const page = await this.get(id);
    const items = await this.versions.find(
      { pageId: page._id },
      { sort: { version: -1 }, projection: { content: 0 } as never },
    );
    return {
      items: items.map((v) => ({
        version: v.version,
        publishedAt: v.publishedAt.toISOString(),
        autoApproved: v.autoApproved,
        live: page.published?.version === v.version,
      })),
    };
  }

  /** Copies a published version back into the draft (it still needs publishing). */
  async restore(id: string, version: number) {
    const page = await this.get(id);
    const store = await this.requireStore(page.storeId.toHexString());
    const saved = await this.versions.findOne({ pageId: page._id, version });
    if (!saved) throw AppError.notFound('landing_page_version');
    const content = landingContentSchema.parse(saved.content);
    const beforeIds = this.pageImageIds(page);
    const afterIds = this.pageImageIds({ ...page, draft: content });
    const dropped = beforeIds.filter((f) => !afterIds.includes(f));
    const after = await this.tx.run(async () => {
      const draft = await this.attachDraft(page._id, content);
      await this.files.detach(dropped, this.pageRef(page._id));
      return this.pages.findOneAndUpdate(
        { _id: page._id },
        { $set: { draft }, $inc: { revision: 1 } },
      );
    });
    await this.files.removeIfUnused(dropped);
    await this.audit.record({
      action: 'landing_page.restored',
      orgId: this.orgId(),
      target: this.target(after!),
      metadata: { version },
    });
    return this.detailDto(after!, store);
  }

  async remove(id: string): Promise<void> {
    const page = await this.get(id);
    if (page.takedown)
      throw AppError.conflict(
        'page_taken_down',
        'A page taken down by Sellora stays for the record. Contact support to remove it.',
      );
    const versions = await this.versions.find({ pageId: page._id });
    const pageImages = this.pageImageIds(page);
    const versionImages = versions.flatMap((v) => contentImages(v.content).map((i) => i.fileId));
    await this.tx.run(async () => {
      await this.files.detach(pageImages, this.pageRef(page._id));
      for (const v of versions)
        await this.files.detach(
          contentImages(v.content).map((i) => i.fileId),
          this.versionRef(v._id),
        );
      await this.versions.deleteMany({ pageId: page._id });
      await this.stats.deleteMany({ pageId: page._id });
      await this.pages.deleteOne({ _id: page._id });
    });
    await this.files.removeIfUnused([...pageImages, ...versionImages]);
    await this.audit.record({
      action: 'landing_page.deleted',
      orgId: this.orgId(),
      target: this.target(page),
      metadata: { slug: page.slug, status: landingStatus(page) },
    });
  }

  /** A one-hour link showing the draft as shoppers would see it. */
  async previewLink(id: string, kind: LandingPreviewKind = 'draft') {
    const page = await this.get(id);
    const store = await this.storeOf(page);
    if (!store) throw AppError.notFound('store');
    if (!this.links.enabled)
      throw new AppError(
        'storefront_not_configured',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Online stores are not set up on this server yet. Ask the platform team to set STOREFRONT_API_KEY.',
      );
    return this.links.landingPreviewUrl(
      { id: page._id.toHexString(), slug: page.slug },
      store.handle,
      kind,
    );
  }
}
