import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { formatMoney } from '../../common/money/money.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { AiWriterService } from '../ai/writer/ai-writer.service.js';
import { CategoryRepository } from '../commerce/repositories.js';
import type { ProductDoc } from '../commerce/products.service.js';
import { slugify } from '../commerce/text.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { ContentDraftRepository } from './repositories.js';
import type { ContentDraft, SeoSuggestion } from './schemas.js';
import {
  contentAnswer,
  contentPrompt,
  contentSchema,
  fitProductSeo,
  pageSeoAnswer,
  pageSeoPrompt,
  pageSeoSchema,
  productSeoAnswer,
  productSeoPrompt,
  productSeoSchema,
  type ContentInput,
  type PageSeoInput,
  type WriterLanguage,
} from './writer-tasks.js';

/** Usage history names of what the studios write. */
export const SEO_FEATURES = {
  product: 'seo_product_writer',
  page: 'seo_page_writer',
  keywords: 'seo_keyword_ideas',
  content: 'content_writer',
} as const;

/** Content drafts kept per business (older ones are removed). */
const DRAFTS_KEPT = 200;

export interface ProductMaterial {
  name: string;
  description: string;
  tags: string[];
  categoryId?: string | null;
  imageCount: number;
  priceMinor?: number | null;
  currency?: string | null;
}

export function toDraftDto(d: ContentDraft & { _id: Types.ObjectId; createdAt: Date }) {
  return {
    id: d._id.toHexString(),
    kind: d.kind,
    productId: d.productId?.toHexString() ?? null,
    productName: d.productName ?? null,
    language: d.language,
    tone: d.tone,
    translateTo: d.translateTo ?? null,
    notes: d.notes,
    source: d.source,
    variants: d.variants,
    credits: d.credits,
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * AI writing for the SEO studio and the content studio (ADR 0032). Nothing here saves to a
 * product or page: the business reviews the suggestion and saves it themselves.
 */
@Injectable()
export class SeoWriterService {
  constructor(
    private readonly writer: AiWriterService,
    private readonly categories: CategoryRepository,
    private readonly drafts: ContentDraftRepository,
    private readonly limits: RateLimitService,
    private readonly orgs: OrgsService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  /** The product's text as the writer reads it. */
  material(p: ProductDoc): ProductMaterial {
    return {
      name: p.name,
      description: p.description,
      tags: p.tags,
      categoryId: p.categoryId?.toHexString() ?? null,
      imageCount: p.images.length,
      priceMinor: Math.min(...p.variants.map((v) => v.priceMinor)),
      currency: p.currency,
    };
  }

  /** SEO title, address, meta description, description, tags, photo alt texts and FAQ. */
  async writeProduct(
    m: ProductMaterial,
    opts: {
      focusKeyword: string | null;
      language: WriterLanguage;
      productId?: string;
      /** Skips the per-business hourly limit (the bulk optimiser has its own). */
      bulk?: boolean;
    },
  ): Promise<{ suggestion: SeoSuggestion; credits: number }> {
    if (!opts.bulk) await this.limits.consume('seo-write:org', this.orgId());
    const category = m.categoryId ? await this.categories.findById(m.categoryId) : null;
    const currency =
      m.currency ?? (m.priceMinor != null ? (await this.orgs.get(this.orgId())).currency : null);
    const focus = opts.focusKeyword?.trim() || null;
    const { system, prompt } = productSeoPrompt({
      name: m.name,
      description: m.description.slice(0, 6000),
      tags: m.tags,
      category: category?.name ?? null,
      imageCount: m.imageCount,
      priceText:
        m.priceMinor != null && currency ? `from ${formatMoney(m.priceMinor, currency)}` : null,
      focusKeyword: focus,
      language: opts.language,
    });
    const { value, credits } = await this.writer.write({
      feature: SEO_FEATURES.product,
      tier: 'standard',
      system,
      prompt,
      schema: productSeoSchema,
      parse: productSeoAnswer,
      maxOutputTokens: 4_000,
      ...(opts.productId ? { reference: { type: 'product', id: opts.productId } } : {}),
    });
    const fitted = fitProductSeo(value, m.imageCount, focus);
    return {
      suggestion: {
        ...fitted,
        // An address the shop can use: lower case words joined by hyphens.
        slug: fitted.slug ? slugify(fitted.slug) : slugify(fitted.focusKeyword),
      },
      credits,
    };
  }

  /** Search title and description of the store's home page or a landing page. */
  async writePage(input: PageSeoInput) {
    await this.limits.consume('seo-write:org', this.orgId());
    const { system, prompt } = pageSeoPrompt({ ...input, about: input.about.slice(0, 4000) });
    const { value, credits } = await this.writer.write({
      feature: SEO_FEATURES.page,
      tier: 'standard',
      system,
      prompt,
      schema: pageSeoSchema,
      parse: pageSeoAnswer,
      maxOutputTokens: 800,
    });
    return { ...value, credits };
  }

  /** Ad copy, captions, descriptions and translations; each result is kept as a draft. */
  async writeContent(input: ContentInput & { productId?: string }) {
    await this.limits.consume('seo-write:org', this.orgId());
    const { system, prompt } = contentPrompt({ ...input, source: input.source.slice(0, 6000) });
    const { value, credits } = await this.writer.write({
      feature: SEO_FEATURES.content,
      tier: 'standard',
      system,
      prompt,
      schema: contentSchema,
      parse: contentAnswer,
      maxOutputTokens: input.kind === 'translate' ? 3_000 : 2_500,
      ...(input.productId ? { reference: { type: 'product', id: input.productId } } : {}),
    });
    const variants = value.variants.slice(0, input.kind === 'translate' ? 1 : input.variants);
    const draft = await this.drafts.create({
      kind: input.kind,
      ...(input.productId ? { productId: new Types.ObjectId(input.productId) } : {}),
      ...(input.productName ? { productName: input.productName } : {}),
      language: input.language,
      tone: input.tone,
      ...(input.kind === 'translate' ? { translateTo: input.translateTo } : {}),
      notes: input.notes,
      source: input.source.slice(0, 2000),
      variants,
      credits,
      createdBy: new Types.ObjectId(RequestContext.actor().id),
    });
    const old = await this.drafts.find(
      {},
      { sort: { createdAt: -1 }, skip: DRAFTS_KEPT, projection: { _id: 1 } },
    );
    if (old.length) await this.drafts.deleteMany({ _id: { $in: old.map((d) => d._id) } });
    return toDraftDto(draft);
  }

  async listDrafts(limit = 50) {
    const items = await this.drafts.find({}, { sort: { createdAt: -1 }, limit });
    return { items: items.map(toDraftDto) };
  }

  async removeDraft(id: string): Promise<void> {
    if (!(await this.drafts.deleteOne({ _id: new Types.ObjectId(id) })))
      throw AppError.notFound('draft');
  }
}
