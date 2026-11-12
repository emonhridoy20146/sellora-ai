import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { FilesService } from '../files/files.service.js';
import type { FileRef } from '../files/schemas.js';
import { contentImages, type LandingContent, type LandingLanguage } from './blocks.js';
import { LandingPageRepository, LandingTemplateRepository } from './repositories.js';
import type { LandingTemplate, LandingTemplateContent } from './schemas.js';

/** How many of its own templates a business keeps. */
export const MAX_MY_TEMPLATES = 20;

type TemplateDoc = WithId<LandingTemplate>;

/** The template's sections as page content, for the picture helpers and new pages. */
function asContent(
  t: LandingTemplateContent,
  product: { id: string; name: string } | null,
): LandingContent {
  return {
    sections: t.sections,
    offer: {
      productId: product?.id ?? null,
      packages: t.packages,
      addOn: null,
      noteField: t.noteField,
    },
    seo: { title: product?.name.slice(0, 70) ?? '', description: '', image: null, index: true },
    settings: t.settings,
  };
}

/**
 * The business's own templates (ADR 0031): a page's sections, settings and packages saved to
 * start new pages from. The product, add-on and search settings are not kept, since a new
 * page is made for another product. Pictures stay attached to the template while it exists.
 */
@Injectable()
export class LandingTemplatesService {
  constructor(
    private readonly templates: LandingTemplateRepository,
    private readonly pages: LandingPageRepository,
    private readonly files: FilesService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  private ref(id: Types.ObjectId | string): FileRef {
    return { type: 'landing_template', id: String(id) };
  }

  toDto(t: TemplateDoc) {
    const images = contentImages(asContent(t.content, null));
    const first = t.content.sections
      .flatMap((s) => ('image' in s && s.image ? [s.image.url] : []))
      .find(Boolean);
    return {
      id: t._id.toHexString(),
      name: t.name,
      description: t.description,
      language: t.language,
      sections: t.content.sections.length,
      packages: t.content.packages.length,
      pictures: images.length,
      cover: first ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  async list() {
    const items = await this.templates.find(
      {},
      { sort: { createdAt: -1 }, limit: MAX_MY_TEMPLATES },
    );
    return { items: items.map((t) => this.toDto(t)), limit: MAX_MY_TEMPLATES };
  }

  /** Saves the page's draft as a template. */
  async saveFromPage(pageId: string, input: { name: string; description?: string }) {
    const page = await this.pages.findById(pageId);
    if (!page) throw AppError.notFound('landing_page');
    if ((await this.templates.count()) >= MAX_MY_TEMPLATES)
      throw AppError.conflict(
        'template_limit',
        `You can keep up to ${MAX_MY_TEMPLATES} templates. Delete one you no longer use first.`,
      );
    const content: LandingTemplateContent = {
      sections: page.draft.sections,
      settings: page.draft.settings,
      packages: page.draft.offer.packages,
      noteField: page.draft.offer.noteField,
    };
    const images = contentImages(asContent(content, null));
    const _id = new Types.ObjectId();
    const created = await this.tx.run(async () => {
      if (images.length)
        await this.files.attach(
          images.map((i) => i.fileId),
          this.ref(_id),
          'store_asset',
          (i) => images[i]!.path,
        );
      return this.templates.create({
        _id,
        name: input.name,
        description: input.description ?? '',
        language: page.language,
        content,
        fromPageId: page._id,
        createdBy: { id: RequestContext.actor().id },
      });
    });
    await this.audit.record({
      action: 'landing_template.created',
      orgId: RequestContext.tenant()!.orgId,
      target: { type: 'landing_template', id: _id.toHexString(), label: input.name },
      metadata: { fromPage: page._id.toHexString() },
    });
    return this.toDto(created);
  }

  async remove(id: string): Promise<void> {
    const t = await this.templates.findById(id);
    if (!t) throw AppError.notFound('landing_template');
    const ids = contentImages(asContent(t.content, null)).map((i) => i.fileId);
    await this.tx.run(async () => {
      await this.files.detach(ids, this.ref(t._id));
      await this.templates.deleteOne({ _id: t._id });
    });
    await this.files.removeIfUnused(ids);
    await this.audit.record({
      action: 'landing_template.deleted',
      orgId: RequestContext.tenant()!.orgId,
      target: { type: 'landing_template', id: t._id.toHexString(), label: t.name },
    });
  }

  /** A new page's draft from one of the business's templates, for this product. */
  async contentFor(
    id: string,
    product: { id: string; name: string },
  ): Promise<{ content: LandingContent; language: LandingLanguage }> {
    const t = await this.templates.findById(id);
    if (!t)
      throw AppError.validation([
        { path: 'templateId', message: 'This template no longer exists' },
      ]);
    return { content: asContent(t.content, product), language: t.language };
  }
}
