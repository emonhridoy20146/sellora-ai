import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { OrgScoped, RequireModule, RequirePermissions } from '../auth/decorators.js';
import * as dto from './catalog-sync.dto.js';
import { CatalogSyncService, toRunDto } from './catalog-sync.service.js';

/** Products › Import and sync (ADR 0023). Writes products, so `catalog.manage` throughout. */
@ApiTags('catalog-sync')
@OrgScoped()
@RequireModule('commerce')
@Controller({ path: 'orgs/:orgId/catalog-sources', version: '1' })
export class CatalogSyncController {
  constructor(private readonly sync: CatalogSyncService) {}

  @Get()
  @RequirePermissions('catalog.view')
  async list() {
    return { items: await this.sync.list() };
  }

  @Post('check')
  @HttpCode(200)
  @RequirePermissions('catalog.manage')
  @ApiOperation({
    summary: 'Read a little of a source to show what would be imported. Saves nothing.',
  })
  check(@ZodBody(dto.sourceInput) body: dto.SourceInput) {
    return this.sync.check(body);
  }

  @Get('website/search')
  @RequirePermissions('catalog.view')
  @ApiOperation({
    summary: 'What the AI agent’s search_website tool finds in the kept website pages (ADR 0024).',
  })
  searchPages(@ZodQuery(dto.pageSearchQuery) q: z.infer<typeof dto.pageSearchQuery>) {
    return this.sync.searchPages(q.q);
  }

  @Post()
  @RequirePermissions('catalog.manage')
  @ApiOperation({
    summary: 'Add a source; its first sync starts at once (a website’s after it is verified).',
  })
  create(@ZodBody(dto.createSourceBody) body: dto.CreateSourceBody) {
    return this.sync.create(body);
  }

  @Get(':sourceId')
  @RequirePermissions('catalog.view')
  async get(@ZodParam('sourceId', objectIdSchema) id: string) {
    return this.sync.dto(await this.sync.get(id));
  }

  @Patch(':sourceId')
  @RequirePermissions('catalog.manage')
  update(
    @ZodParam('sourceId', objectIdSchema) id: string,
    @ZodBody(dto.updateSourceBody) body: dto.UpdateSourceBody,
  ) {
    return this.sync.update(id, body);
  }

  @Delete(':sourceId')
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'Remove a source. Its products stay, as ordinary products.' })
  remove(@ZodParam('sourceId', objectIdSchema) id: string) {
    return this.sync.remove(id);
  }

  @Post(':sourceId/sync')
  @HttpCode(202)
  @RequirePermissions('catalog.manage')
  async syncNow(@ZodParam('sourceId', objectIdSchema) id: string) {
    return toRunDto(await this.sync.syncNow(id));
  }

  @Post(':sourceId/verify')
  @HttpCode(200)
  @RequirePermissions('catalog.manage')
  @ApiOperation({
    summary: 'Check a website’s ownership proof (DNS TXT or meta tag); starts a crawl when found.',
  })
  verify(@ZodParam('sourceId', objectIdSchema) id: string) {
    return this.sync.verify(id);
  }

  @Post(':sourceId/held')
  @HttpCode(200)
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'Apply or keep a large change waiting for the merchant.' })
  decide(
    @ZodParam('sourceId', objectIdSchema) id: string,
    @ZodBody(dto.heldDecisionBody) body: dto.HeldDecisionBody,
  ) {
    return this.sync.decideHeld(id, body);
  }

  @Get(':sourceId/pages')
  @RequirePermissions('catalog.view')
  pages(
    @ZodParam('sourceId', objectIdSchema) id: string,
    @ZodQuery(dto.runsQuery) q: z.infer<typeof dto.runsQuery>,
  ) {
    return this.sync.listPages(id, q);
  }

  @Get(':sourceId/pages/:pageId')
  @RequirePermissions('catalog.view')
  page(
    @ZodParam('sourceId', objectIdSchema) id: string,
    @ZodParam('pageId', objectIdSchema) pageId: string,
  ) {
    return this.sync.getPage(id, pageId);
  }

  @Post(':sourceId/upload')
  @HttpCode(202)
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'A new version of a CSV source’s file.' })
  async upload(
    @ZodParam('sourceId', objectIdSchema) id: string,
    @ZodBody(dto.uploadCsvBody) body: z.infer<typeof dto.uploadCsvBody>,
  ) {
    return toRunDto(await this.sync.uploadCsv(id, body));
  }

  @Get(':sourceId/runs')
  @RequirePermissions('catalog.view')
  runs(
    @ZodParam('sourceId', objectIdSchema) id: string,
    @ZodQuery(dto.runsQuery) q: z.infer<typeof dto.runsQuery>,
  ) {
    return this.sync.listRuns(id, q);
  }

  @Get(':sourceId/runs/:runId')
  @RequirePermissions('catalog.view')
  run(
    @ZodParam('sourceId', objectIdSchema) id: string,
    @ZodParam('runId', objectIdSchema) runId: string,
  ) {
    return this.sync.getRun(id, runId);
  }
}
