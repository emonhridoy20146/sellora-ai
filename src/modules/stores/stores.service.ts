import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { slugify, withRandomSuffix } from '../../common/utils/slug.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { CategoryRepository, ProductRepository } from '../commerce/repositories.js';
import { FilesService } from '../files/files.service.js';
import type { FileRef } from '../files/schemas.js';
import type { BusinessCategory } from '../orgs/business-categories.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import type { Store, StorePageKey, StoreStatus } from './schemas.js';
import { HANDLE_MESSAGES, handleProblem, normalizeHandle } from './store-hosts.js';
import { StoreLinksService } from './store-links.service.js';
import { precheckStore, type CheckedText } from './store-precheck.js';
import { StoreRepository } from './repositories.js';
import {
  THEMES,
  starterSettings,
  suggestedThemes,
  themeByKey,
  type ThemeSettings,
} from './themes.js';

export type StoreDoc = WithId<Store>;

export interface CreateStoreInput {
  name: string;
  handle?: string;
  category?: BusinessCategory;
  language?: 'en' | 'bn';
  themeKey?: string;
  palette?: number;
}

export interface UpdateStoreInput {
  name?: string;
  handle?: string;
  category?: BusinessCategory;
  language?: 'en' | 'bn';
  contact?: Store['contact'];
  social?: Store['social'];
  seo?: Store['seo'];
  pages?: Store['pages'];
  checkout?: { note?: string; minOrderMinor?: number };
}

/** What a store still needs before it can be sent for review. */
export interface StoreReadiness {
  activeProducts: number;
  hasContact: boolean;
  ready: boolean;
}

/** Statuses a business may delete a store in (a suspended store stays for the record). */
const DELETABLE: readonly StoreStatus[] = ['draft', 'pending', 'live', 'rejected', 'paused'];
/** Products read for the automatic check; the newest ones are what shoppers see first. */
const PRECHECK_PRODUCTS = 300;

/** Starter policy pages, in the store's language. Businesses edit them before opening. */
const STARTER_PAGES: Record<'en' | 'bn', Partial<Record<StorePageKey, string>>> = {
  en: {
    shipping:
      'We deliver across Bangladesh. The delivery charge for your area is shown at checkout.\n\nPay cash when the parcel reaches you. We call or message to confirm every order before sending it.',
    returns:
      'If an item arrives damaged or is not what you ordered, contact us within 3 days of delivery with a photo and we will replace it or refund you.',
  },
  bn: {
    shipping:
      'আমরা সারা বাংলাদেশে ডেলিভারি দিই। আপনার এলাকার ডেলিভারি চার্জ চেকআউটে দেখানো হয়।\n\nপণ্য হাতে পেয়ে টাকা দিন। পাঠানোর আগে প্রতিটি অর্ডার কল বা মেসেজে নিশ্চিত করা হয়।',
    returns:
      'পণ্য ভাঙা বা ভুল এলে ডেলিভারির ৩ দিনের মধ্যে ছবিসহ আমাদের জানান, আমরা বদলে দেব বা টাকা ফেরত দেব।',
  },
};

/** The uploaded images a theme uses, with where each sits (for error paths). */
export function themeImages(theme: ThemeSettings): { fileId: string; path: string }[] {
  const out: { fileId: string; path: string }[] = [];
  if (theme.logo) out.push({ fileId: theme.logo.fileId, path: 'theme.logo.fileId' });
  theme.sections.forEach((s, i) => {
    if ((s.type === 'hero' || s.type === 'banner') && s.image)
      out.push({ fileId: s.image.fileId, path: `theme.sections.${i}.image.fileId` });
  });
  return out;
}

/** Every piece of text in a store a shopper reads, for the automatic check. */
export function storeTexts(store: Pick<Store, 'name' | 'seo' | 'pages' | 'theme'>): CheckedText[] {
  const texts: CheckedText[] = [
    { where: 'name', label: 'Store name', text: store.name },
    {
      where: 'seo',
      label: 'Search title and description',
      text: `${store.seo.title ?? ''} ${store.seo.description ?? ''}`,
    },
    { where: 'announcement', label: 'Announcement bar', text: store.theme.announcement },
  ];
  for (const [key, text] of Object.entries(store.pages))
    if (text) texts.push({ where: `page:${key}`, label: `Page: ${key}`, text });
  store.theme.sections.forEach((s, i) => {
    const parts =
      s.type === 'hero'
        ? [s.heading, s.subheading, s.buttonLabel]
        : s.type === 'banner'
          ? [s.heading, s.text, s.buttonLabel]
          : s.type === 'text'
            ? [s.heading, s.body]
            : s.type === 'features'
              ? s.items.flatMap((f) => [f.title, f.text])
              : [s.title];
    texts.push({
      where: `section:${s.id}`,
      label: `Home section ${i + 1} (${s.type})`,
      text: parts.join(' '),
    });
  });
  return texts;
}

/**
 * A business's online stores (merchant side). A store is set up as a draft, sent to the
 * super-admin for review, and opens to shoppers once approved (or straight away when the
 * platform turns on automatic approval and the automatic check finds nothing). The handle
 * is the store's subdomain; it can change until the store first opens.
 */
@Injectable()
export class StoresService {
  constructor(
    private readonly stores: StoreRepository,
    @InjectModel('Store') private readonly storeModel: Model<Store>,
    private readonly products: ProductRepository,
    private readonly categories: CategoryRepository,
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
    const a = RequestContext.actor();
    return { id: a.id };
  }

  private fileRef(storeId: Types.ObjectId | string): FileRef {
    return { type: 'store', id: String(storeId) };
  }

  // ---------------------------------------------------------------- dto

  toDto(s: StoreDoc, readiness?: StoreReadiness) {
    return {
      id: s._id.toHexString(),
      name: s.name,
      handle: s.handle,
      host: this.links.host(s.handle),
      url: this.links.url(s.handle),
      category: s.category,
      language: s.language,
      themeKey: s.themeKey,
      theme: s.theme,
      contact: {
        phone: s.contact.phone ?? '',
        whatsapp: s.contact.whatsapp ?? '',
        email: s.contact.email ?? '',
        address: s.contact.address ?? '',
      },
      social: {
        facebook: s.social.facebook ?? '',
        instagram: s.social.instagram ?? '',
        youtube: s.social.youtube ?? '',
        tiktok: s.social.tiktok ?? '',
      },
      seo: { title: s.seo.title ?? '', description: s.seo.description ?? '' },
      pages: Object.fromEntries(
        (['about', 'shipping', 'returns', 'privacy', 'terms'] as const).map((k) => [
          k,
          s.pages[k] ?? '',
        ]),
      ) as Record<StorePageKey, string>,
      checkout: { note: s.checkout.note ?? '', minOrderMinor: s.checkout.minOrderMinor ?? 0 },
      status: s.status,
      review: {
        submittedAt: s.review.submittedAt?.toISOString() ?? null,
        decidedAt: s.review.decidedAt?.toISOString() ?? null,
        reason: s.review.reason ?? null,
        autoApproved: s.review.autoApproved ?? false,
      },
      handleLocked: Boolean(s.liveSince),
      liveSince: s.liveSince?.toISOString() ?? null,
      ...(readiness ? { readiness } : {}),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  /** The theme catalog, with the themes that suit the business's category first. */
  async themes() {
    const org = await this.orgs.get(this.orgId());
    return {
      suggested: suggestedThemes(org.category),
      items: THEMES.map((t) => ({
        key: t.key,
        name: t.name,
        tagline: t.tagline,
        categories: t.categories,
        palettes: t.palettes,
        defaults: t.defaults,
      })),
    };
  }

  // ---------------------------------------------------------------- reads

  async list(): Promise<{ items: StoreDoc[]; limit: number | null }> {
    const [items, ent] = await Promise.all([
      this.stores.find({}, { sort: { createdAt: 1 } }),
      this.entitlements.forOrg(this.orgId()),
    ]);
    return { items, limit: ent.limits.stores };
  }

  async get(id: string): Promise<StoreDoc> {
    const store = await this.stores.findById(id);
    if (!store) throw AppError.notFound('store');
    return store;
  }

  async readiness(store: StoreDoc): Promise<StoreReadiness> {
    const activeProducts = await this.products.count({ status: 'active' });
    const hasContact = Boolean(store.contact.phone?.trim() || store.contact.whatsapp?.trim());
    return { activeProducts, hasContact, ready: activeProducts > 0 && hasContact };
  }

  // ---------------------------------------------------------------- handles

  private async handleTaken(handle: string, exceptId?: Types.ObjectId): Promise<boolean> {
    // Handles are subdomains, unique across every business, so this read crosses tenants.
    const found = await this.storeModel
      .exists({ handle, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
      .setOptions({ [CROSS_TENANT]: true })
      .exec();
    return found !== null;
  }

  async checkHandle(raw: string, exceptId?: string) {
    const handle = normalizeHandle(raw);
    const problem = handleProblem(handle);
    if (problem) return { handle, available: false, problem, message: HANDLE_MESSAGES[problem] };
    const except =
      exceptId && Types.ObjectId.isValid(exceptId) ? new Types.ObjectId(exceptId) : undefined;
    if (await this.handleTaken(handle, except))
      return {
        handle,
        available: false,
        problem: 'taken',
        message: 'Another store uses this address',
      };
    return { handle, available: true, problem: null, message: null };
  }

  private async assertHandleUsable(handle: string, exceptId?: Types.ObjectId): Promise<void> {
    const problem = handleProblem(handle);
    if (problem) throw AppError.validation([{ path: 'handle', message: HANDLE_MESSAGES[problem] }]);
    if (await this.handleTaken(handle, exceptId))
      throw AppError.conflict('handle_taken', 'Another store uses this address. Choose another.', {
        handle,
      });
  }

  /** A free handle made from the store name. */
  private async suggestHandle(name: string): Promise<string> {
    const base = slugify(name, 28).slice(0, 28).replace(/-+$/g, '');
    const candidates = [
      base,
      ...Array.from({ length: 6 }, () => withRandomSuffix(base.slice(0, 28))),
    ];
    for (const c of candidates) if (!handleProblem(c) && !(await this.handleTaken(c))) return c;
    return withRandomSuffix(`store-${Date.now().toString(36)}`.slice(0, 28));
  }

  // ---------------------------------------------------------------- writes

  async create(input: CreateStoreInput): Promise<StoreDoc> {
    const orgId = this.orgId();
    await this.entitlements.assertWithinLimit(orgId, 'stores', await this.stores.count());
    const org = await this.orgs.get(orgId);
    const category = input.category ?? org.category;
    const language = input.language ?? org.locale;
    const theme = themeByKey(input.themeKey ?? suggestedThemes(category)[0]!)!;
    const handle = input.handle
      ? normalizeHandle(input.handle)
      : await this.suggestHandle(input.name);
    if (input.handle) await this.assertHandleUsable(handle);

    const settings = starterSettings(theme, input.name, language);
    const palette = theme.palettes[input.palette ?? 0] ?? theme.palettes[0]!;
    settings.palette = { primary: palette.primary, accent: palette.accent };

    let store: StoreDoc;
    try {
      store = await this.stores.create({
        name: input.name,
        handle,
        category,
        language,
        themeKey: theme.key,
        theme: settings,
        contact: {
          ...(org.contact?.phone ? { phone: org.contact.phone } : {}),
          ...(org.contact?.email ? { email: org.contact.email } : {}),
          ...(org.contact?.address ? { address: org.contact.address } : {}),
        },
        social: {},
        seo: { title: input.name },
        pages: STARTER_PAGES[language],
        checkout: { minOrderMinor: 0 },
        status: 'draft',
        review: { flags: [] },
        createdBy: new Types.ObjectId(RequestContext.actor().id),
      });
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict(
          'handle_taken',
          'Another store uses this address. Choose another.',
          {
            handle,
          },
        );
      throw err;
    }
    await this.audit.record({
      action: 'store.created',
      orgId,
      target: { type: 'store', id: store._id.toHexString(), label: store.name },
      metadata: { handle, themeKey: theme.key },
    });
    return store;
  }

  async update(id: string, input: UpdateStoreInput): Promise<StoreDoc> {
    const before = await this.get(id);
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.category !== undefined) set.category = input.category;
    if (input.language !== undefined) set.language = input.language;
    if (input.handle !== undefined) {
      const handle = normalizeHandle(input.handle);
      if (handle !== before.handle) {
        if (before.liveSince)
          throw AppError.conflict(
            'handle_locked',
            'The address cannot change after the store has opened, so links people saved keep working.',
          );
        await this.assertHandleUsable(handle, before._id);
        set.handle = handle;
      }
    }
    // Text groups: an empty string clears a field.
    const groups = {
      contact: input.contact,
      social: input.social,
      seo: input.seo,
      pages: input.pages,
    };
    for (const [group, values] of Object.entries(groups)) {
      if (!values) continue;
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        if (value === '') unset[`${group}.${key}`] = '';
        else set[`${group}.${key}`] = value;
      }
    }
    if (input.checkout) {
      if (input.checkout.note !== undefined) {
        if (input.checkout.note === '') unset['checkout.note'] = '';
        else set['checkout.note'] = input.checkout.note;
      }
      if (input.checkout.minOrderMinor !== undefined)
        set['checkout.minOrderMinor'] = input.checkout.minOrderMinor;
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) return before;
    let after: StoreDoc | null;
    try {
      after = await this.stores.findOneAndUpdate(
        { _id: before._id, ...(set.handle ? { liveSince: { $exists: false } } : {}) },
        {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
      );
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('handle_taken', 'Another store uses this address. Choose another.');
      throw err;
    }
    if (!after)
      throw AppError.conflict(
        'handle_locked',
        'The address cannot change after the store has opened, so links people saved keep working.',
      );
    await this.audit.record({
      action: 'store.updated',
      orgId: this.orgId(),
      target: { type: 'store', id: after._id.toHexString(), label: after.name },
      metadata: {
        fields: [
          ...new Set([...Object.keys(set), ...Object.keys(unset)].map((k) => k.split('.')[0])),
        ],
        ...(set.handle ? { handle: { from: before.handle, to: set.handle } } : {}),
      },
    });
    return after;
  }

  /** Checks that the categories product sections show exist in this business. */
  private async assertSectionCategories(theme: ThemeSettings): Promise<void> {
    const errors: FieldError[] = [];
    const wanted: { id: string; path: string }[] = [];
    theme.sections.forEach((s, i) => {
      if (s.type !== 'products') return;
      if (s.source === 'category' && !s.categoryId)
        errors.push({
          path: `theme.sections.${i}.categoryId`,
          message: 'Choose a category to show',
        });
      if (s.categoryId) wanted.push({ id: s.categoryId, path: `theme.sections.${i}.categoryId` });
    });
    if (wanted.length) {
      const found = await this.categories.find(
        { _id: { $in: [...new Set(wanted.map((w) => w.id))].map((i) => new Types.ObjectId(i)) } },
        { projection: { _id: 1 } },
      );
      const ids = new Set(found.map((c) => c._id.toHexString()));
      for (const w of wanted)
        if (!ids.has(w.id))
          errors.push({ path: w.path, message: 'This category no longer exists' });
    }
    if (errors.length) throw AppError.validation(errors);
  }

  /**
   * Saves the store's design. Uploaded images are marked as used by the store and get their
   * address from storage; images the new design no longer uses are released and removed.
   */
  async setTheme(id: string, themeKey: string, theme: ThemeSettings): Promise<StoreDoc> {
    const before = await this.get(id);
    if (!themeByKey(themeKey))
      throw AppError.validation([{ path: 'themeKey', message: 'Unknown theme' }]);
    await this.assertSectionCategories(theme);
    const ref = this.fileRef(before._id);
    const next = themeImages(theme);
    const previous = themeImages(before.theme).map((i) => i.fileId);
    const dropped = previous.filter((f) => !next.some((n) => n.fileId === f));

    const after = await this.tx.run(async () => {
      const files = await this.files.attach(
        next.map((n) => n.fileId),
        ref,
        'store_asset',
        (i) => next[i]!.path,
      );
      const url = (fileId: string) => this.files.publicUrl(files.get(fileId)!);
      const saved: ThemeSettings = {
        ...theme,
        logo: theme.logo ? { fileId: theme.logo.fileId, url: url(theme.logo.fileId) } : null,
        sections: theme.sections.map((s) =>
          (s.type === 'hero' || s.type === 'banner') && s.image
            ? { ...s, image: { fileId: s.image.fileId, url: url(s.image.fileId) } }
            : s,
        ),
      };
      await this.files.detach(dropped, ref);
      return (await this.stores.findOneAndUpdate(
        { _id: before._id },
        { $set: { themeKey, theme: saved } },
      ))!;
    });
    await this.files.removeIfUnused(dropped);
    await this.audit.record({
      action: 'store.design_saved',
      orgId: this.orgId(),
      target: { type: 'store', id: after._id.toHexString(), label: after.name },
      metadata: { themeKey, sections: theme.sections.length },
    });
    return after;
  }

  /** Runs the automatic check over the store and its active products. */
  async precheck(store: StoreDoc) {
    const products = await this.products.find(
      { status: 'active' },
      {
        sort: { updatedAt: -1 },
        limit: PRECHECK_PRODUCTS,
        projection: { name: 1, description: 1, tags: 1 },
      },
    );
    return precheckStore([
      ...storeTexts(store),
      ...products.map((p) => ({
        where: `product:${p._id.toHexString()}`,
        label: `Product: ${p.name}`,
        text: `${p.name} ${p.description} ${p.tags.join(' ')}`,
      })),
    ]);
  }

  /**
   * Sends a draft (or a rejected store, after fixing it) for review. With automatic approval
   * on and nothing flagged, the store opens straight away.
   */
  async submit(id: string): Promise<StoreDoc> {
    const store = await this.get(id);
    if (store.status !== 'draft' && store.status !== 'rejected')
      throw AppError.conflict(
        'store_not_draft',
        `This store is ${store.status}; only a draft or a rejected store can be sent for review.`,
        {
          storeStatus: store.status,
        },
      );
    const readiness = await this.readiness(store);
    const missing: FieldError[] = [];
    if (readiness.activeProducts === 0)
      missing.push({ path: 'products', message: 'Add at least one active product' });
    if (!readiness.hasContact)
      missing.push({
        path: 'contact.phone',
        message: 'Add a phone or WhatsApp number shoppers can reach',
      });
    if (missing.length)
      throw AppError.unprocessable('store_not_ready', 'The store is not ready for review yet.', {
        errors: missing,
      });

    const flags = await this.precheck(store);
    const settings = await this.platformSettings.get();
    const auto = settings.stores.autoApprove && flags.length === 0;
    const now = new Date();
    const by = this.actorRef();
    const after = await this.stores.findOneAndUpdate(
      { _id: store._id, status: { $in: ['draft', 'rejected'] } },
      {
        $set: {
          status: auto ? 'live' : 'pending',
          review: {
            submittedAt: now,
            submittedBy: by,
            flags,
            ...(auto ? { decidedAt: now, decidedBy: { id: 'auto' }, autoApproved: true } : {}),
          },
          ...(auto && !store.liveSince ? { liveSince: now } : {}),
        },
      },
    );
    if (!after)
      throw AppError.conflict(
        'store_changed',
        'The store changed while sending it. Refresh and try again.',
      );
    await this.audit.record({
      action: auto ? 'store.opened' : 'store.submitted',
      orgId: this.orgId(),
      target: { type: 'store', id: after._id.toHexString(), label: after.name },
      metadata: { flags: flags.length, autoApproved: auto },
    });
    return after;
  }

  private async move(
    id: string,
    from: StoreStatus[],
    to: StoreStatus,
    action: string,
    message: string,
  ): Promise<StoreDoc> {
    const store = await this.get(id);
    const after = await this.stores.findOneAndUpdate(
      { _id: store._id, status: { $in: from } },
      { $set: { status: to } },
    );
    if (!after)
      throw AppError.conflict('invalid_store_status', message, { storeStatus: store.status });
    await this.audit.record({
      action,
      orgId: this.orgId(),
      target: { type: 'store', id: after._id.toHexString(), label: after.name },
      metadata: { from: store.status, to },
    });
    return after;
  }

  /** Takes a store out of the review queue to keep editing. */
  withdraw(id: string) {
    return this.move(
      id,
      ['pending'],
      'draft',
      'store.withdrawn',
      'Only a store waiting for review can be taken back.',
    );
  }

  /** Closes a live store to shoppers for a while (it shows a closed page). */
  pause(id: string) {
    return this.move(id, ['live'], 'paused', 'store.paused', 'Only an open store can be paused.');
  }

  /** Opens a paused store again. It was approved before, so no new review is needed. */
  resume(id: string) {
    return this.move(
      id,
      ['paused'],
      'live',
      'store.resumed',
      'Only a paused store can be opened again.',
    );
  }

  async remove(id: string): Promise<void> {
    const store = await this.get(id);
    if (!DELETABLE.includes(store.status))
      throw AppError.conflict(
        'store_suspended',
        'A store suspended by Sellora cannot be deleted. Contact support.',
      );
    const fileIds = themeImages(store.theme).map((i) => i.fileId);
    await this.tx.run(async () => {
      await this.files.detach(fileIds, this.fileRef(store._id));
      await this.stores.deleteOne({ _id: store._id, status: { $in: DELETABLE } });
    });
    await this.files.removeIfUnused(fileIds);
    await this.audit.record({
      action: 'store.deleted',
      orgId: this.orgId(),
      target: { type: 'store', id: store._id.toHexString(), label: store.name },
      metadata: { handle: store.handle, status: store.status },
    });
  }

  /** A link that shows the store as shoppers will see it, before it opens. */
  async previewLink(id: string) {
    const store = await this.get(id);
    if (!this.links.enabled)
      throw new AppError(
        'storefront_not_configured',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Online stores are not set up on this server yet. Ask the platform team to set STOREFRONT_API_KEY.',
      );
    return this.links.previewUrl(store._id.toHexString(), store.handle);
  }
}
