import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { OrgScoped, Public, RequireModule, RequirePermissions } from '../auth/decorators.js';
import { KeywordsService } from './keywords.service.js';
import { SearchConsoleService } from './search-console.service.js';
import { SeoAuditService } from './seo-audit.service.js';
import { SeoWriterService } from './seo-writer.service.js';
import * as dto from './seo.dto.js';

/** The AI SEO studio and content studio (ADR 0032). */
@ApiTags('seo')
@OrgScoped()
@RequireModule('seo')
@Controller({ path: 'orgs/:orgId/seo', version: '1' })
export class SeoController {
  constructor(
    private readonly writer: SeoWriterService,
    private readonly keywords: KeywordsService,
    private readonly audit: SeoAuditService,
    private readonly console: SearchConsoleService,
  ) {}

  // ---------------------------------------------------------------- AI writing

  @Post('write/product')
  @HttpCode(200)
  @RequirePermissions('catalog.manage')
  @ApiOperation({
    summary: "Suggest a product's SEO title, address, meta, description, tags, alt texts and FAQ",
  })
  async writeProduct(@ZodBody(dto.writeProductBody) b: z.infer<typeof dto.writeProductBody>) {
    return this.writer.writeProduct(
      {
        name: b.name,
        description: b.description,
        tags: b.tags,
        categoryId: b.categoryId,
        imageCount: b.imageCount,
        priceMinor: b.priceMinor,
        currency: null,
      },
      {
        focusKeyword: b.focusKeyword,
        language: b.language,
        ...(b.productId ? { productId: b.productId } : {}),
      },
    );
  }

  @Post('write/page')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Suggest the search title and description of a store or landing page' })
  writePage(@ZodBody(dto.writePageBody) b: z.infer<typeof dto.writePageBody>) {
    return this.writer.writePage(b);
  }

  @Get('duplicates')
  @RequirePermissions('catalog.view')
  @ApiOperation({ summary: 'How many other products use this search title or meta description' })
  duplicates(@ZodQuery(dto.duplicatesQuery) q: z.infer<typeof dto.duplicatesQuery>) {
    return this.audit.duplicates(q);
  }

  // ---------------------------------------------------------------- keywords

  @Get('keywords/setup')
  @RequirePermissions('marketing.view')
  @ApiOperation({ summary: 'Whether search volumes are available, and the price of a lookup' })
  keywordSetup() {
    return this.keywords.setup();
  }

  @Post('keywords/research')
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Keyword ideas around a seed, with monthly searches when available' })
  research(@ZodBody(dto.researchBody) b: z.infer<typeof dto.researchBody>) {
    return this.keywords.run(b);
  }

  @Get('keywords/research')
  @RequirePermissions('marketing.view')
  @ApiOperation({ summary: 'Recent keyword research' })
  researchHistory() {
    return this.keywords.history();
  }

  @Get('keywords/research/:researchId')
  @RequirePermissions('marketing.view')
  researchOne(@ZodParam('researchId', objectIdSchema) id: string) {
    return this.keywords.get(id);
  }

  @Get('keyword-lists')
  @RequirePermissions('marketing.view')
  @ApiOperation({ summary: 'Keyword lists' })
  lists() {
    return this.keywords.allLists();
  }

  @Post('keyword-lists')
  @RequirePermissions('marketing.manage')
  createList(@ZodBody(dto.listNameBody) b: z.infer<typeof dto.listNameBody>) {
    return this.keywords.createList(b.name);
  }

  @Get('keyword-lists/:listId')
  @RequirePermissions('marketing.view')
  @ApiOperation({ summary: 'A list with the products that target each keyword, and the gaps' })
  list(@ZodParam('listId', objectIdSchema) id: string) {
    return this.keywords.listDetail(id);
  }

  @Patch('keyword-lists/:listId')
  @RequirePermissions('marketing.manage')
  renameList(
    @ZodParam('listId', objectIdSchema) id: string,
    @ZodBody(dto.listNameBody) b: z.infer<typeof dto.listNameBody>,
  ) {
    return this.keywords.renameList(id, b.name);
  }

  @Delete('keyword-lists/:listId')
  @HttpCode(204)
  @RequirePermissions('marketing.manage')
  async removeList(@ZodParam('listId', objectIdSchema) id: string): Promise<void> {
    await this.keywords.removeList(id);
  }

  @Post('keyword-lists/:listId/keywords')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  addKeywords(
    @ZodParam('listId', objectIdSchema) id: string,
    @ZodBody(dto.addKeywordsBody) b: z.infer<typeof dto.addKeywordsBody>,
  ) {
    return this.keywords.addKeywords(id, b.keywords);
  }

  @Post('keyword-lists/:listId/keywords/remove')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  removeKeywords(
    @ZodParam('listId', objectIdSchema) id: string,
    @ZodBody(dto.removeKeywordsBody) b: z.infer<typeof dto.removeKeywordsBody>,
  ) {
    return this.keywords.removeKeywords(id, b.keywords);
  }

  @Post('keyword-lists/:listId/volumes')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Look up monthly searches for keywords in the list that have none' })
  refreshVolumes(@ZodParam('listId', objectIdSchema) id: string) {
    return this.keywords.refreshVolumes(id);
  }

  // ---------------------------------------------------------------- audit and bulk

  @Get('audit')
  @RequirePermissions('marketing.view')
  @ApiOperation({ summary: 'SEO score of every active product, and the store checks' })
  runAudit() {
    return this.audit.run();
  }

  @Post('bulk')
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Write AI suggestions for up to 50 products (applied after review)' })
  startBulk(@ZodBody(dto.bulkBody) b: z.infer<typeof dto.bulkBody>) {
    return this.audit.startBulk(b);
  }

  @Get('bulk')
  @RequirePermissions('marketing.view')
  bulkRuns() {
    return this.audit.bulkRuns();
  }

  @Get('bulk/:runId')
  @RequirePermissions('marketing.view')
  bulkRun(@ZodParam('runId', objectIdSchema) id: string) {
    return this.audit.bulkRun(id);
  }

  @Post('bulk/:runId/cancel')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  cancelBulk(@ZodParam('runId', objectIdSchema) id: string) {
    return this.audit.cancelBulk(id);
  }

  @Post('bulk/:runId/items/:productId/apply')
  @HttpCode(200)
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: "Save a suggestion's chosen fields to the product" })
  apply(
    @ZodParam('runId', objectIdSchema) runId: string,
    @ZodParam('productId', objectIdSchema) productId: string,
    @ZodBody(dto.applyBody) b: z.infer<typeof dto.applyBody>,
  ) {
    return this.audit.applyItem(runId, productId, b.fields);
  }

  // ---------------------------------------------------------------- Search Console

  @Get('search-console')
  @RequirePermissions('marketing.view')
  @ApiOperation({ summary: 'Connection, clicks and impressions, top phrases and opportunities' })
  async searchConsole(@ZodQuery(dto.reportQuery) q: z.infer<typeof dto.reportQuery>) {
    const [status, report] = await Promise.all([
      this.console.status(),
      this.console.report(q.days),
    ]);
    return { ...status, report: report.connection ? report : null };
  }

  @Post('search-console/connect')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: "Google's consent page, to connect Search Console for a store" })
  connect(@ZodBody(dto.connectBody) b: z.infer<typeof dto.connectBody>) {
    return this.console.connectUrl(b.storeId, RequestContext.actor().id);
  }

  @Post('search-console/retry')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Try the setup again, or fetch the numbers now' })
  retry() {
    return this.console.retry();
  }

  @Delete('search-console')
  @HttpCode(204)
  @RequirePermissions('marketing.manage')
  async disconnect(): Promise<void> {
    await this.console.disconnect();
  }

  // ---------------------------------------------------------------- content studio

  @Post('content')
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Write ad copy, captions, descriptions or a translation' })
  writeContent(@ZodBody(dto.contentBody) b: z.infer<typeof dto.contentBody>) {
    return this.writer.writeContent({
      ...b,
      productName: b.productName?.trim() || null,
    });
  }

  @Get('content')
  @RequirePermissions('marketing.view')
  drafts() {
    return this.writer.listDrafts();
  }

  @Delete('content/:draftId')
  @HttpCode(204)
  @RequirePermissions('marketing.manage')
  async removeDraft(@ZodParam('draftId', objectIdSchema) id: string): Promise<void> {
    await this.writer.removeDraft(id);
  }
}

/** Google's redirect after the Search Console consent page (no session). */
@ApiTags('seo')
@Controller({ path: 'seo', version: '1' })
export class SeoPublicController {
  constructor(private readonly console: SearchConsoleService) {}

  @Get('google/callback')
  @Public()
  @ApiOperation({ summary: "Google's redirect after the consent page (checks the signed state)" })
  async googleCallback(
    @ZodQuery(dto.googleCallbackQuery) q: z.infer<typeof dto.googleCallbackQuery>,
    @Res() res: Response,
  ): Promise<void> {
    const to = await this.console.callback(q);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, to);
  }
}
