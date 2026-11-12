import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { FilesService } from '../files/files.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { InventoryService } from './inventory.service.js';
import { CategoryRepository, OrderRepository, ProductRepository } from './repositories.js';
import type {
  Category,
  Product,
  ProductImage,
  ProductSeo,
  ProductStatus,
  ProductSync,
  Variant,
} from './schemas.js';
import { escapeRegex, searchText, slugify } from './text.js';

export type ProductDoc = WithId<Product>;
export type CategoryDoc = WithId<Category>;

export interface VariantInput {
  id?: string;
  optionValues: string[];
  sku?: string | null;
  barcode?: string | null;
  priceMinor: number;
  compareAtPriceMinor?: number | null;
  costMinor?: number | null;
  trackStock: boolean;
  /** Opening stock; only used for new variants. Existing stock changes go through inventory. */
  stock?: number;
  weightGrams?: number | null;
}

export interface ProductSeoInput {
  title?: string;
  description?: string;
  keywords: string[];
  faq: { question: string; answer: string }[];
}

/** Earlier addresses kept for redirects, per product. */
const PREVIOUS_SLUGS_MAX = 20;

export interface ProductInput {
  name: string;
  /** Leave out for an address made from the name. */
  slug?: string;
  seo?: ProductSeoInput | null;
  description: string;
  categoryId: string | null;
  tags: string[];
  status: ProductStatus;
  images: { url?: string; fileId?: string; alt?: string }[];
  options: { name: string; values: string[] }[];
  variants: VariantInput[];
}

export function toProductDto(p: ProductDoc, lowStockThreshold?: number) {
  const tracked = p.variants.filter((v) => v.trackStock);
  const totalStock = tracked.reduce((a, v) => a + v.stock, 0);
  const prices = p.variants.map((v) => v.priceMinor);
  return {
    id: p._id.toHexString(),
    name: p.name,
    slug: p.slug,
    previousSlugs: p.previousSlugs ?? [],
    seo: {
      title: p.seo?.title ?? '',
      description: p.seo?.description ?? '',
      keywords: p.seo?.keywords ?? [],
      faq: (p.seo?.faq ?? []).map((f) => ({ question: f.question, answer: f.answer })),
    },
    description: p.description,
    categoryId: p.categoryId?.toHexString() ?? null,
    tags: p.tags,
    status: p.status,
    currency: p.currency,
    images: p.images.map((i) => ({
      url: i.url,
      fileId: i.fileId?.toHexString() ?? null,
      alt: i.alt ?? '',
    })),
    options: p.options,
    variants: p.variants.map((v) => ({
      id: v._id.toHexString(),
      title: v.title,
      optionValues: v.optionValues,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null,
      priceMinor: v.priceMinor,
      compareAtPriceMinor: v.compareAtPriceMinor ?? null,
      costMinor: v.costMinor ?? null,
      trackStock: v.trackStock,
      stock: v.stock,
      weightGrams: v.weightGrams ?? null,
    })),
    priceRange: { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) },
    stock: {
      tracked: tracked.length > 0,
      total: totalStock,
      lowVariants:
        lowStockThreshold === undefined
          ? null
          : tracked.filter((v) => v.stock <= lowStockThreshold).length,
    },
    soldCount: p.soldCount,
    sync: p.sync
      ? {
          sourceId: p.sync.sourceId.toHexString(),
          syncedAt: p.sync.syncedAt.toISOString(),
          archivedBySync: p.sync.archivedBySync,
        }
      : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toCategoryDto(c: CategoryDoc, productCount?: number) {
  return {
    id: c._id.toHexString(),
    name: c.name,
    slug: c.slug,
    sortOrder: c.sortOrder,
    ...(productCount !== undefined ? { productCount } : {}),
  };
}

const DEFAULT_TITLE = 'Default';

/** A product as a catalog source has it, ready to write (ADR 0023). */
export interface SourceProductWrite {
  sourceId: Types.ObjectId;
  externalId: string;
  hash: string;
  /** "Shopify": used in stock notes. */
  sourceLabel: string;
  name: string;
  description: string;
  tags: string[];
  categoryId: Types.ObjectId | null;
  /** Photos already saved to storage (or kept as links). */
  images: ProductImage[];
  options: { name: string; values: string[] }[];
  variants: {
    externalId: string;
    optionValues: string[];
    sku?: string;
    barcode?: string;
    priceMinor: number;
    compareAtPriceMinor?: number;
    trackStock: boolean;
    stock: number;
    weightGrams?: number;
  }[];
  syncStock: boolean;
  /**
   * `availability`: the source says "sold out" or not, never how many (a website, ADR 0024).
   * A sold-out variant is sent as counted with 0, an available one as not counted.
   */
  stockFrom?: 'counts' | 'availability';
  /** Status of a product the sync creates or restores. */
  newStatus: 'active' | 'draft';
  createdBy: Types.ObjectId;
}

export type SourceWriteOutcome = 'created' | 'updated' | 'restored' | 'unchanged';

@Injectable()
export class ProductsService {
  constructor(
    private readonly products: ProductRepository,
    private readonly categories: CategoryRepository,
    private readonly orders: OrderRepository,
    private readonly inventory: InventoryService,
    private readonly entitlements: EntitlementsService,
    private readonly orgs: OrgsService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  // ---------------------------------------------------------------- photos

  /**
   * Marks uploaded photos as used by the product and takes their URLs from storage; linked
   * photos keep the URL given. Run inside the product's transaction.
   */
  private async attachImages(
    productId: Types.ObjectId,
    images: ProductInput['images'],
  ): Promise<ProductImage[]> {
    const withFile = images.flatMap((img, index) =>
      img.fileId ? [{ index, id: img.fileId }] : [],
    );
    const files = await this.files.attach(
      withFile.map((f) => f.id),
      { type: 'product', id: productId.toHexString() },
      'product_image',
      (i) => `images.${withFile[i]!.index}.fileId`,
    );
    return images.map((img) => {
      const file = img.fileId ? files.get(img.fileId) : undefined;
      return {
        url: file ? this.files.publicUrl(file) : img.url!,
        ...(file ? { fileId: file._id } : {}),
        ...(img.alt ? { alt: img.alt } : {}),
      };
    });
  }

  /**
   * After a save that dropped photos: deletes uploaded ones nothing uses any more, except
   * those shown on past orders, which are kept for order history.
   */
  private async releaseImages(productId: Types.ObjectId, dropped: ProductImage[]): Promise<void> {
    const keep: string[] = [];
    const release: string[] = [];
    for (const img of dropped) {
      if (!img.fileId) continue;
      const onOrders = await this.orders.exists({
        'items.productId': productId,
        'items.imageUrl': img.url,
      });
      (onOrders ? keep : release).push(img.fileId.toHexString());
    }
    if (keep.length)
      await this.files.attach(
        keep,
        { type: 'order_history', id: productId.toHexString() },
        'product_image',
        (i) => `images.${i}`,
      );
    await this.files.removeIfUnused(release);
  }

  // ---------------------------------------------------------------- products

  async list(query: {
    q?: string;
    status?: ProductStatus | 'all';
    categoryId?: string;
    stock?: 'low' | 'out';
    lowStockThreshold: number;
    limit: number;
    cursor?: string;
  }) {
    const filter: Record<string, unknown> = {};
    if (!query.status) filter.status = { $ne: 'archived' };
    else if (query.status !== 'all') filter.status = query.status;
    if (query.categoryId) filter.categoryId = new Types.ObjectId(query.categoryId);
    if (query.q) filter.searchText = { $regex: escapeRegex(query.q.toLowerCase()) };
    if (query.stock === 'out')
      filter.variants = { $elemMatch: { trackStock: true, stock: { $lte: 0 } } };
    if (query.stock === 'low')
      filter.variants = {
        $elemMatch: { trackStock: true, stock: { $lte: query.lowStockThreshold } },
      };
    return this.products.paginate(filter, query, 'updatedAt');
  }

  async get(id: string): Promise<ProductDoc> {
    const p = await this.products.findById(id);
    if (!p) throw AppError.notFound('product');
    return p;
  }

  /**
   * Active products matching any of `terms`, best match first (most terms matched, then
   * best sellers). Used by the AI agent, where customers describe products loosely.
   */
  async searchActive(terms: string[], limit: number): Promise<ProductDoc[]> {
    const words = [
      ...new Set(
        terms
          .flatMap((t) =>
            t
              .normalize('NFKC')
              .toLowerCase()
              .split(/[\s,.;:/|()]+/),
          )
          .filter((w) => w.length >= 2),
      ),
    ].slice(0, 8);
    if (!words.length) return [];
    const docs = await this.products.find(
      {
        status: 'active',
        $or: words.map((w) => ({ searchText: { $regex: escapeRegex(w) } })),
      },
      { sort: { soldCount: -1, updatedAt: -1 }, limit: 100 },
    );
    const score = (p: ProductDoc) => words.filter((w) => p.searchText.includes(w)).length;
    return docs
      .map((p, i) => ({ p, s: score(p), i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.p);
  }

  /** Best-selling active products and how many are active, for the AI agent's catalog. */
  async topActive(limit: number): Promise<{ products: ProductDoc[]; totalActive: number }> {
    const [products, totalActive] = await Promise.all([
      this.products.find({ status: 'active' }, { sort: { soldCount: -1, updatedAt: -1 }, limit }),
      this.products.count({ status: 'active' }),
    ]);
    return { products, totalActive };
  }

  /** Several products by id, for order building (missing ids are left out). */
  async getMany(ids: string[]): Promise<ProductDoc[]> {
    const valid = [...new Set(ids)].filter((i) => Types.ObjectId.isValid(i));
    if (!valid.length) return [];
    return this.products.find({ _id: { $in: valid.map((i) => new Types.ObjectId(i)) } });
  }

  private validateShape(input: Pick<ProductInput, 'options' | 'variants'>): void {
    const errors: { path: string; message: string }[] = [];
    const optionNames = input.options.map((o) => o.name.trim().toLowerCase());
    if (new Set(optionNames).size !== optionNames.length)
      errors.push({ path: 'options', message: 'Option names must be different' });
    input.options.forEach((o, i) => {
      const values = o.values.map((v) => v.trim().toLowerCase());
      if (new Set(values).size !== values.length)
        errors.push({ path: `options.${i}.values`, message: 'Values must be different' });
    });
    if (input.options.length === 0 && input.variants.length !== 1)
      errors.push({ path: 'variants', message: 'A product without options has one variant' });
    const combos = new Set<string>();
    input.variants.forEach((v, i) => {
      if (v.optionValues.length !== input.options.length) {
        errors.push({
          path: `variants.${i}.optionValues`,
          message: 'Pick a value for each option',
        });
        return;
      }
      v.optionValues.forEach((val, j) => {
        if (!input.options[j]!.values.includes(val))
          errors.push({
            path: `variants.${i}.optionValues.${j}`,
            message: `"${val}" is not a value of ${input.options[j]!.name}`,
          });
      });
      const key = v.optionValues.join('\u0000').toLowerCase();
      if (combos.has(key))
        errors.push({
          path: `variants.${i}.optionValues`,
          message: 'This combination is listed twice',
        });
      combos.add(key);
      if (
        v.compareAtPriceMinor !== undefined &&
        v.compareAtPriceMinor !== null &&
        v.compareAtPriceMinor <= v.priceMinor
      )
        errors.push({
          path: `variants.${i}.compareAtPriceMinor`,
          message: 'The old price must be higher than the price',
        });
    });
    const skus = input.variants.map((v) => v.sku?.trim()).filter((s): s is string => Boolean(s));
    if (new Set(skus.map((s) => s.toLowerCase())).size !== skus.length)
      errors.push({ path: 'variants', message: 'Each variant needs its own SKU' });
    if (errors.length) throw AppError.validation(errors);
  }

  private async assertSkusFree(skus: string[], exceptId?: Types.ObjectId): Promise<void> {
    if (!skus.length) return;
    const clash = await this.products.findOne(
      {
        'variants.sku': { $in: skus },
        ...(exceptId ? { _id: { $ne: exceptId } } : {}),
      },
      { name: 1, variants: 1 },
    );
    if (clash) {
      const used = clash.variants.find((v) => v.sku && skus.includes(v.sku))?.sku;
      throw AppError.conflict('sku_taken', `SKU ${used} is already used by ${clash.name}.`, {
        sku: used,
        productId: clash._id.toHexString(),
      });
    }
  }

  private async assertCategory(categoryId: string | null): Promise<Types.ObjectId | undefined> {
    if (!categoryId) return undefined;
    const c = await this.categories.findById(categoryId);
    if (!c) throw AppError.validation([{ path: 'categoryId', message: 'Unknown category' }]);
    return c._id;
  }

  /** True when the address is the one made from the name (renaming then moves it along). */
  private autoSlug(p: { name: string; slug: string }): boolean {
    const root = slugify(p.name);
    return p.slug === root || new RegExp(`^${escapeRegex(root)}-\\d+$`).test(p.slug);
  }

  /** The earlier addresses after moving from `from` to `to`, newest first. */
  private movedSlugs(from: string, previous: string[] | undefined, to: string): string[] {
    return [from, ...(previous ?? [])]
      .filter((s, i, all) => s !== to && all.indexOf(s) === i)
      .slice(0, PREVIOUS_SLUGS_MAX);
  }

  /** An address a product now uses stops redirecting to the product that used it before. */
  private async claimSlug(slug: string, productId: Types.ObjectId): Promise<void> {
    await this.products.updateMany(
      { previousSlugs: slug, _id: { $ne: productId } },
      { $pull: { previousSlugs: slug } },
    );
  }

  private seoFields(seo: ProductSeoInput): ProductSeo {
    const title = seo.title?.trim();
    const description = seo.description?.trim();
    return {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      keywords: [...new Set(seo.keywords.map((k) => k.trim()).filter(Boolean))],
      faq: seo.faq.map((f) => ({ question: f.question.trim(), answer: f.answer.trim() })),
    };
  }

  private async uniqueSlug(base: string, exceptId?: Types.ObjectId): Promise<string> {
    const root = slugify(base);
    for (let n = 1; n < 1000; n++) {
      const slug = n === 1 ? root : `${root}-${n}`;
      const taken = await this.products.exists({
        slug,
        ...(exceptId ? { _id: { $ne: exceptId } } : {}),
      });
      if (!taken) return slug;
    }
    return `${root}-${Date.now().toString(36)}`;
  }

  private buildVariant(v: VariantInput, existing?: Variant): Variant {
    return {
      _id: existing?._id ?? new Types.ObjectId(),
      title: v.optionValues.length ? v.optionValues.join(' / ') : DEFAULT_TITLE,
      optionValues: v.optionValues,
      ...(v.sku?.trim() ? { sku: v.sku.trim() } : {}),
      ...(v.barcode?.trim() ? { barcode: v.barcode.trim() } : {}),
      priceMinor: v.priceMinor,
      ...(v.compareAtPriceMinor != null ? { compareAtPriceMinor: v.compareAtPriceMinor } : {}),
      ...(v.costMinor != null ? { costMinor: v.costMinor } : {}),
      trackStock: v.trackStock,
      // Existing variants keep their stock; stock only changes through InventoryService.
      stock: existing ? existing.stock : v.trackStock ? (v.stock ?? 0) : 0,
      ...(v.weightGrams != null ? { weightGrams: v.weightGrams } : {}),
    };
  }

  private search(name: string, tags: string[], variants: Variant[]): string {
    return searchText(
      name,
      tags,
      variants.map((v) => v.sku ?? ''),
      variants.map((v) => v.barcode ?? ''),
    );
  }

  async create(input: ProductInput): Promise<ProductDoc> {
    this.validateShape(input);
    const orgId = this.orgId();
    if (input.status !== 'archived')
      await this.entitlements.assertWithinLimit(
        orgId,
        'products',
        await this.products.count({ status: { $ne: 'archived' } }),
      );
    const variants = input.variants.map((v) => this.buildVariant(v));
    await this.assertSkusFree(variants.flatMap((v) => (v.sku ? [v.sku] : [])));
    const categoryId = await this.assertCategory(input.categoryId);
    const org = await this.orgs.get(orgId);
    const productId = new Types.ObjectId();
    const slug = await this.uniqueSlug(input.slug ?? input.name);
    const product = await this.tx.run(async () => {
      await this.claimSlug(slug, productId);
      const images = await this.attachImages(productId, input.images);
      const created = await this.products.create({
        _id: productId,
        name: input.name,
        slug,
        ...(input.seo ? { seo: this.seoFields(input.seo) } : {}),
        description: input.description,
        ...(categoryId ? { categoryId } : {}),
        tags: input.tags,
        status: input.status,
        currency: org.currency,
        images,
        options: input.options,
        variants,
        searchText: this.search(input.name, input.tags, variants),
        soldCount: 0,
        createdBy: new Types.ObjectId(RequestContext.actor().id),
      });
      await this.inventory.recordInitial(created._id, created.variants);
      return created;
    });
    await this.audit.record({
      action: 'catalog.product.created',
      orgId,
      target: { type: 'product', id: product._id.toHexString(), label: product.name },
    });
    return product;
  }

  async update(id: string, input: Partial<ProductInput>): Promise<ProductDoc> {
    const before = await this.get(id);
    const options = input.options ?? before.options;
    const set: Record<string, unknown> = {};
    let newVariants: Variant[] = [];
    if (input.variants || input.options) {
      const variantInputs: VariantInput[] =
        input.variants ??
        before.variants.map((v) => ({
          id: v._id.toHexString(),
          optionValues: v.optionValues,
          sku: v.sku,
          barcode: v.barcode,
          priceMinor: v.priceMinor,
          compareAtPriceMinor: v.compareAtPriceMinor,
          costMinor: v.costMinor,
          trackStock: v.trackStock,
          weightGrams: v.weightGrams,
        }));
      this.validateShape({ options, variants: variantInputs });
      const variants = variantInputs.map((v) => {
        const existing = v.id
          ? before.variants.find((b) => b._id.toHexString() === v.id)
          : undefined;
        if (v.id && !existing)
          throw AppError.validation([{ path: 'variants', message: 'Unknown variant id' }]);
        const built = this.buildVariant(v, existing);
        // Turning tracking off drops the count; turning it on starts from zero.
        if (existing && existing.trackStock !== v.trackStock) built.stock = 0;
        return built;
      });
      newVariants = variants.filter((v) => !before.variants.some((b) => b._id.equals(v._id)));
      await this.assertSkusFree(
        variants.flatMap((v) => (v.sku ? [v.sku] : [])),
        before._id,
      );
      set.options = options;
      set.variants = variants;
    }
    if (input.categoryId !== undefined) {
      const categoryId = await this.assertCategory(input.categoryId);
      set.categoryId = categoryId ?? null;
    }
    if (input.name !== undefined && input.name !== before.name) set.name = input.name;
    // A new address: the one asked for, or one made from the new name when the old address
    // was made from the old name. The old address keeps working as a redirect.
    const nextSlug =
      input.slug !== undefined
        ? slugify(input.slug) !== before.slug
          ? await this.uniqueSlug(input.slug, before._id)
          : undefined
        : set.name !== undefined && this.autoSlug(before)
          ? await this.uniqueSlug(input.name!, before._id)
          : undefined;
    if (nextSlug && nextSlug !== before.slug) {
      set.slug = nextSlug;
      set.previousSlugs = this.movedSlugs(before.slug, before.previousSlugs, nextSlug);
    }
    if (input.seo !== undefined && input.seo !== null) set.seo = this.seoFields(input.seo);
    if (input.description !== undefined) set.description = input.description;
    if (input.tags !== undefined) set.tags = input.tags;
    if (input.status !== undefined && input.status !== before.status) {
      if (before.status === 'archived')
        await this.entitlements.assertWithinLimit(
          this.orgId(),
          'products',
          await this.products.count({ status: { $ne: 'archived' } }),
        );
      set.status = input.status;
    }
    const finalVariants = (set.variants as Variant[] | undefined) ?? before.variants;
    set.searchText = this.search(
      (set.name as string | undefined) ?? before.name,
      (set.tags as string[] | undefined) ?? before.tags,
      finalVariants,
    );
    const unset: Record<string, ''> = {};
    if (set.categoryId === null) {
      delete set.categoryId;
      unset.categoryId = '';
    }
    if (input.seo === null && before.seo) unset.seo = '';
    const after = await this.tx.run(async () => {
      // Stock of existing variants may have changed since we read it (orders). Write the
      // variants with the stock values read inside the transaction.
      const writeOffs: { variantId: Types.ObjectId; stock: number; note: string }[] = [];
      if (set.variants) {
        const fresh = await this.products.findById(before._id, { variants: 1 });
        const next = set.variants as Variant[];
        for (const v of next) {
          const live = fresh?.variants.find((f) => f._id.equals(v._id));
          const old = before.variants.find((b) => b._id.equals(v._id));
          if (live && old && live.trackStock === v.trackStock) v.stock = live.stock;
          else if (live?.trackStock && !v.trackStock)
            writeOffs.push({
              variantId: v._id,
              stock: live.stock,
              note: 'Stock tracking turned off',
            });
        }
        for (const live of fresh?.variants ?? []) {
          if (live.trackStock && !next.some((v) => v._id.equals(live._id)))
            writeOffs.push({ variantId: live._id, stock: live.stock, note: 'Variant removed' });
        }
      }
      if (input.images !== undefined) {
        set.images = await this.attachImages(before._id, input.images);
        const kept = new Set(input.images.flatMap((i) => (i.fileId ? [i.fileId] : [])));
        await this.files.detach(
          before.images.flatMap((i) =>
            i.fileId && !kept.has(i.fileId.toHexString()) ? [i.fileId.toHexString()] : [],
          ),
          { type: 'product', id: before._id.toHexString() },
        );
      }
      if (typeof set.slug === 'string') await this.claimSlug(set.slug, before._id);
      const updated = await this.products.findOneAndUpdate(
        { _id: before._id },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      );
      if (newVariants.length) await this.inventory.recordInitial(before._id, newVariants);
      if (writeOffs.length) await this.inventory.recordWriteOff(before._id, writeOffs);
      return updated!;
    });
    if (input.images !== undefined) {
      const now = new Set(after.images.flatMap((i) => (i.fileId ? [i.fileId.toHexString()] : [])));
      await this.releaseImages(
        before._id,
        before.images.filter((i) => i.fileId && !now.has(i.fileId.toHexString())),
      );
    }
    await this.audit.record({
      action: 'catalog.product.updated',
      orgId: this.orgId(),
      target: { type: 'product', id, label: after.name },
      metadata: {
        fields: [...Object.keys(set), ...Object.keys(unset)].filter(
          (k) => k !== 'searchText' && k !== 'previousSlugs',
        ),
        ...(typeof set.slug === 'string' ? { slug: { from: before.slug, to: set.slug } } : {}),
      },
    });
    return after;
  }

  /** Products on any order are archived rather than deleted, so order history stays intact. */
  async remove(id: string): Promise<{ deleted: boolean; archived: boolean }> {
    const p = await this.get(id);
    const sold = p.soldCount > 0 || (await this.orders.exists({ 'items.productId': p._id }));
    if (sold) {
      await this.products.updateOne({ _id: p._id }, { $set: { status: 'archived' } });
    } else {
      const fileIds = p.images.flatMap((i) => (i.fileId ? [i.fileId.toHexString()] : []));
      await this.tx.run(async () => {
        await this.products.deleteOne({ _id: p._id });
        await this.files.detach(fileIds, { type: 'product', id: p._id.toHexString() });
      });
      await this.files.removeIfUnused(fileIds);
    }
    await this.audit.record({
      action: sold ? 'catalog.product.archived' : 'catalog.product.deleted',
      orgId: this.orgId(),
      target: { type: 'product', id, label: p.name },
    });
    return { deleted: !sold, archived: sold };
  }

  // ---------------------------------------------------------------- catalog sync (ADR 0023)

  /** The product a source item became, if any. */
  async findBySource(sourceId: Types.ObjectId, externalIds: string[]): Promise<ProductDoc[]> {
    if (!externalIds.length) return [];
    return this.products.find({
      'sync.sourceId': sourceId,
      'sync.externalId': { $in: externalIds },
    });
  }

  /** The external ids of a source's products, archived ones included. */
  async sourceExternalIds(sourceId: Types.ObjectId): Promise<string[]> {
    const rows = await this.products.find(
      { 'sync.sourceId': sourceId },
      { projection: { 'sync.externalId': 1 }, limit: 20_000 },
    );
    return rows.flatMap((r) => (r.sync?.externalId ? [r.sync.externalId] : []));
  }

  /**
   * Moves products to the new external id their item has at the source (a website page that
   * moved), unless a product already has that id. Returns how many moved.
   */
  async rekeySource(
    sourceId: Types.ObjectId,
    moves: { from: string; to: string }[],
  ): Promise<number> {
    let n = 0;
    for (const m of moves) {
      if (m.from === m.to) continue;
      if (await this.products.exists({ 'sync.sourceId': sourceId, 'sync.externalId': m.to }))
        continue;
      const r = await this.products.updateOne(
        { 'sync.sourceId': sourceId, 'sync.externalId': m.from },
        { $set: { 'sync.externalId': m.to } },
      );
      n += r.modified;
    }
    return n;
  }

  /** A source's products that are not archived and whose item was not in `seen`. */
  async findBySourceMissing(sourceId: Types.ObjectId, seen: string[]): Promise<ProductDoc[]> {
    return this.products.find(
      { 'sync.sourceId': sourceId, 'sync.externalId': { $nin: seen }, status: { $ne: 'archived' } },
      { _id: 1 },
    );
  }

  /** A category by name (any case), created when missing. */
  async categoryFor(name: string): Promise<Types.ObjectId> {
    const slug = slugify(name);
    const found = await this.categories.findOne({ slug });
    if (found) return found._id;
    try {
      return (await this.categories.create({ name, slug, sortOrder: 0 }))._id;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const again = await this.categories.findOne({ slug });
      if (!again) throw err;
      return again._id;
    }
  }

  /**
   * Creates or updates the product for one item at a catalog source. The source owns the
   * name, description, tags, category, photos, options, variants and prices; stock follows it
   * when `syncStock` (through the inventory ledger). Variants keep their ids by the source's
   * variant id. A product the sync archived comes back. Throws AppError for an SKU used by
   * another product, a broken shape or the plan's product limit.
   */
  async applySourceProduct(
    existing: ProductDoc | null,
    w: SourceProductWrite,
  ): Promise<{ outcome: SourceWriteOutcome; product: ProductDoc }> {
    const restoring = Boolean(
      existing && existing.status === 'archived' && existing.sync?.archivedBySync,
    );
    if (existing && existing.sync?.hash === w.hash && !restoring)
      return { outcome: 'unchanged', product: existing };

    const map = new Map(
      (existing?.sync?.variants ?? []).map((m) => [m.externalId, m.variantId.toHexString()]),
    );
    const variants: Variant[] = w.variants.map((sv) => {
      const oldId = map.get(sv.externalId);
      const old = oldId ? existing?.variants.find((v) => v._id.toHexString() === oldId) : undefined;
      const weight = sv.weightGrams ?? old?.weightGrams;
      return {
        _id: old?._id ?? new Types.ObjectId(),
        title: sv.optionValues.length ? sv.optionValues.join(' / ') : DEFAULT_TITLE,
        optionValues: sv.optionValues,
        ...(sv.sku ? { sku: sv.sku } : {}),
        ...(sv.barcode ? { barcode: sv.barcode } : {}),
        priceMinor: sv.priceMinor,
        ...(sv.compareAtPriceMinor !== undefined
          ? { compareAtPriceMinor: sv.compareAtPriceMinor }
          : {}),
        // Cost is Sellora's own (for profit); the sources do not send it.
        ...(old?.costMinor !== undefined ? { costMinor: old.costMinor } : {}),
        trackStock: sv.trackStock,
        stock: old ? old.stock : sv.trackStock ? sv.stock : 0,
        ...(weight !== undefined ? { weightGrams: weight } : {}),
      };
    });
    this.validateShape({
      options: w.options,
      variants: variants.map((v) => ({
        optionValues: v.optionValues,
        sku: v.sku,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
        trackStock: v.trackStock,
      })),
    });
    await this.assertSkusFree(
      variants.flatMap((v) => (v.sku ? [v.sku] : [])),
      existing?._id,
    );
    const orgId = this.orgId();
    if (!existing || restoring)
      await this.entitlements.assertWithinLimit(
        orgId,
        'products',
        await this.products.count({ status: { $ne: 'archived' } }),
      );

    const sync: ProductSync = {
      sourceId: w.sourceId,
      externalId: w.externalId,
      hash: w.hash,
      variants: w.variants.map((sv, i) => ({
        externalId: sv.externalId,
        variantId: variants[i]!._id,
      })),
      archivedBySync: false,
      syncedAt: new Date(),
    };
    const note = `Synced from ${w.sourceLabel}`;
    const searchText = this.search(w.name, w.tags, variants);

    if (!existing) {
      const org = await this.orgs.get(orgId);
      const productId = new Types.ObjectId();
      const slug = await this.uniqueSlug(w.name);
      const product = await this.tx.run(async () => {
        await this.attachSyncedImages(productId, w.images);
        await this.claimSlug(slug, productId);
        const created = await this.products.create({
          _id: productId,
          name: w.name,
          slug,
          description: w.description,
          ...(w.categoryId ? { categoryId: w.categoryId } : {}),
          tags: w.tags,
          status: w.newStatus,
          currency: org.currency,
          images: w.images,
          options: w.options,
          variants,
          searchText,
          soldCount: 0,
          createdBy: w.createdBy,
          sync,
        });
        await this.inventory.recordInitial(created._id, created.variants);
        return created;
      });
      return { outcome: 'created', product };
    }

    const set: Record<string, unknown> = {
      description: w.description,
      tags: w.tags,
      images: w.images,
      options: w.options,
      searchText,
      sync,
    };
    if (w.name !== existing.name) {
      set.name = w.name;
      if (this.autoSlug(existing)) {
        const next = await this.uniqueSlug(w.name, existing._id);
        if (next !== existing.slug) {
          set.slug = next;
          set.previousSlugs = this.movedSlugs(existing.slug, existing.previousSlugs, next);
        }
      }
    }
    if (w.categoryId) set.categoryId = w.categoryId;
    if (restoring) set.status = w.newStatus;
    const after = await this.tx.run(async () => {
      // Stock read inside the transaction: orders may have changed it since.
      const fresh = await this.products.findById(existing._id, { variants: 1 });
      const writeOffs: { variantId: Types.ObjectId; stock: number; note: string }[] = [];
      const targets: { variantId: Types.ObjectId; stock: number }[] = [];
      const added: Variant[] = [];
      w.variants.forEach((sv, i) => {
        const v = variants[i]!;
        const live = fresh?.variants.find((f) => f._id.equals(v._id));
        if (!live) {
          added.push(v);
          return;
        }
        if (w.stockFrom === 'availability') {
          if (!w.syncStock || (!sv.trackStock && live.trackStock && live.stock > 0)) {
            // Sellora's own stock settings, or a count Sellora keeps above 0.
            v.trackStock = live.trackStock;
            v.stock = live.stock;
          } else if (sv.trackStock) {
            // Sold out at the source.
            v.trackStock = true;
            v.stock = live.trackStock ? live.stock : 0;
            if (live.trackStock && live.stock !== 0) targets.push({ variantId: v._id, stock: 0 });
          } else {
            // Back in stock at the source after Sellora held it at 0: no longer counted.
            v.trackStock = false;
            v.stock = 0;
          }
          return;
        }
        if (live.trackStock && !v.trackStock) {
          writeOffs.push({ variantId: v._id, stock: live.stock, note });
          v.stock = 0;
        } else if (!live.trackStock && v.trackStock) {
          v.stock = 0;
          if (w.syncStock || sv.stock > 0) targets.push({ variantId: v._id, stock: sv.stock });
        } else {
          v.stock = live.stock;
          if (v.trackStock && w.syncStock && live.stock !== sv.stock)
            targets.push({ variantId: v._id, stock: sv.stock });
        }
      });
      for (const live of fresh?.variants ?? [])
        if (live.trackStock && !variants.some((v) => v._id.equals(live._id)))
          writeOffs.push({
            variantId: live._id,
            stock: live.stock,
            note: `Removed at ${w.sourceLabel}`,
          });
      set.variants = variants;
      await this.attachSyncedImages(existing._id, w.images);
      // A source without categories leaves the one set in Sellora.
      if (typeof set.slug === 'string') await this.claimSlug(set.slug, existing._id);
      const updated = await this.products.findOneAndUpdate({ _id: existing._id }, { $set: set });
      if (added.length) await this.inventory.recordInitial(existing._id, added);
      if (writeOffs.length) await this.inventory.recordWriteOff(existing._id, writeOffs);
      if (targets.length) await this.inventory.syncTo(existing._id, targets, note);
      const kept = new Set(w.images.flatMap((i) => (i.fileId ? [i.fileId.toHexString()] : [])));
      await this.files.detach(
        existing.images.flatMap((i) =>
          i.fileId && !kept.has(i.fileId.toHexString()) ? [i.fileId.toHexString()] : [],
        ),
        { type: 'product', id: existing._id.toHexString() },
      );
      return targets.length ? ((await this.products.findById(existing._id)) ?? updated!) : updated!;
    });
    const now = new Set(after.images.flatMap((i) => (i.fileId ? [i.fileId.toHexString()] : [])));
    await this.releaseImages(
      existing._id,
      existing.images.filter((i) => i.fileId && !now.has(i.fileId.toHexString())),
    );
    return { outcome: restoring ? 'restored' : 'updated', product: after };
  }

  /** Marks the photos a sync saved as used by the product (saved unattached first). */
  private async attachSyncedImages(
    productId: Types.ObjectId,
    images: ProductImage[],
  ): Promise<void> {
    const ids = images.flatMap((i) => (i.fileId ? [i.fileId.toHexString()] : []));
    await this.files.attach(
      ids,
      { type: 'product', id: productId.toHexString() },
      'product_image',
      (i) => `images.${i}`,
    );
  }

  /**
   * Archives the products of a source that the last complete read did not find (or found
   * inactive), and marks them so a later sync may restore them. Returns how many.
   */
  async archiveFromSource(productIds: Types.ObjectId[]): Promise<number> {
    if (!productIds.length) return 0;
    return this.products.updateMany(
      { _id: { $in: productIds }, status: { $ne: 'archived' } },
      { $set: { status: 'archived', 'sync.archivedBySync': true } },
    );
  }

  /** Forgets a removed source: its products stay, as ordinary products. */
  async detachSource(sourceId: Types.ObjectId): Promise<number> {
    return this.products.updateMany({ 'sync.sourceId': sourceId }, { $unset: { sync: '' } });
  }

  // ---------------------------------------------------------------- categories

  async listCategories() {
    const [cats, counts] = await Promise.all([
      this.categories.find({}, { sort: { sortOrder: 1, name: 1 } }),
      this.products.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { status: { $ne: 'archived' }, categoryId: { $exists: true } } },
        { $group: { _id: '$categoryId', n: { $sum: 1 } } },
      ]),
    ]);
    const byId = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return cats.map((c) => toCategoryDto(c, byId.get(c._id.toHexString()) ?? 0));
  }

  async createCategory(input: { name: string; sortOrder?: number }) {
    try {
      return await this.categories.create({
        name: input.name,
        slug: slugify(input.name),
        sortOrder: input.sortOrder ?? 0,
      });
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('category_exists', 'A category with this name already exists.');
      throw err;
    }
  }

  async updateCategory(id: string, input: { name?: string; sortOrder?: number }) {
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) {
      set.name = input.name;
      set.slug = slugify(input.name);
    }
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    try {
      const c = await this.categories.findOneAndUpdate(
        { _id: new Types.ObjectId(id) },
        { $set: set },
      );
      if (!c) throw AppError.notFound('category');
      return c;
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('category_exists', 'A category with this name already exists.');
      throw err;
    }
  }

  async deleteCategory(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('category');
    const oid = new Types.ObjectId(id);
    await this.tx.run(async () => {
      const deleted = await this.categories.deleteOne({ _id: oid });
      if (!deleted) throw AppError.notFound('category');
      await this.products.updateMany({ categoryId: oid }, { $unset: { categoryId: '' } });
    });
  }
}
