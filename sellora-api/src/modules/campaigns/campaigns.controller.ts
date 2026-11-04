import { Controller, Delete, Get, Headers, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  OwnTokenAuth,
  RequireAnyPermission,
  RequireModule,
  RequirePermissions,
} from '../auth/decorators.js';
import { StorefrontKeyGuard } from '../stores/storefront-key.guard.js';
import { StorefrontService } from '../stores/storefront.service.js';
import { AutomationsService } from './automations.service.js';
import * as dto from './campaigns.dto.js';
import { CampaignsService } from './campaigns.service.js';
import { MarketingLinksService } from './links.service.js';

type CampaignBody = z.infer<typeof dto.createBody>;

/** Marketing › Campaigns for one business (ADR 0019). */
@ApiTags('campaigns')
@OrgScoped()
@RequireModule('marketing')
@Controller({ path: 'orgs/:orgId/campaigns', version: '1' })
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('options')
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({
    summary: 'What the editor needs: stores, live pages, tags, the SMS route, cash and limits',
  })
  options() {
    return this.campaigns.options();
  }

  @Post('audience')
  @HttpCode(200)
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'How many customers an audience reaches now, and who is left out' })
  audience(@ZodBody(dto.audienceBody) body: z.infer<typeof dto.audienceBody>) {
    return this.campaigns.count(body);
  }

  @Post('check')
  @HttpCode(200)
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Problems with a text and its preview, without saving' })
  check(@ZodBody(dto.checkBody) body: z.infer<typeof dto.checkBody>) {
    return this.campaigns.check(body);
  }

  @Get()
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Campaigns, newest first' })
  list(@ZodQuery(dto.listQuery) q: z.infer<typeof dto.listQuery>) {
    return this.campaigns.list({
      limit: q.limit,
      ...(q.status ? { status: q.status } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  }

  @Post()
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Save a draft campaign' })
  create(@ZodBody(dto.createBody) body: CampaignBody) {
    return this.campaigns.create(body);
  }

  @Get(':campaignId')
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'A campaign with its progress, messages, clicks and orders' })
  get(@ZodParam('campaignId', dto.campaignIdParam) id: string) {
    return this.campaigns.get(id);
  }

  @Patch(':campaignId')
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Change a draft, or a scheduled campaign before it starts' })
  update(
    @ZodParam('campaignId', dto.campaignIdParam) id: string,
    @ZodBody(dto.updateBody) body: CampaignBody,
  ) {
    return this.campaigns.update(id, body);
  }

  @Delete(':campaignId')
  @HttpCode(204)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Delete a draft' })
  async remove(@ZodParam('campaignId', dto.campaignIdParam) id: string): Promise<void> {
    await this.campaigns.remove(id);
  }

  @Post(':campaignId/duplicate')
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'A new draft with the same name, text, audience and link' })
  duplicate(@ZodParam('campaignId', dto.campaignIdParam) id: string) {
    return this.campaigns.duplicate(id);
  }

  @Post(':campaignId/test')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Send the text to one number (at most 5 per campaign)' })
  test(
    @ZodParam('campaignId', dto.campaignIdParam) id: string,
    @ZodBody(dto.testBody) body: z.infer<typeof dto.testBody>,
  ) {
    return this.campaigns.test(id, body.to);
  }

  @Post(':campaignId/start')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Send now, or at a time in the sending hours' })
  start(
    @ZodParam('campaignId', dto.campaignIdParam) id: string,
    @ZodBody(dto.startBody) body: z.infer<typeof dto.startBody>,
  ) {
    return this.campaigns.start(id, body.at ? { at: new Date(body.at) } : {});
  }

  @Post(':campaignId/pause')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  pause(@ZodParam('campaignId', dto.campaignIdParam) id: string) {
    return this.campaigns.pause(id);
  }

  @Post(':campaignId/resume')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  resume(@ZodParam('campaignId', dto.campaignIdParam) id: string) {
    return this.campaigns.resume(id);
  }

  @Post(':campaignId/cancel')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Stop for good (messages already handed to SMS still go)' })
  cancel(@ZodParam('campaignId', dto.campaignIdParam) id: string) {
    return this.campaigns.cancel(id);
  }

  @Get(':campaignId/recipients')
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Who the campaign went to, with each message and any order after' })
  recipients(
    @ZodParam('campaignId', dto.campaignIdParam) id: string,
    @ZodQuery(dto.recipientsQuery) q: z.infer<typeof dto.recipientsQuery>,
  ) {
    return this.campaigns.listRecipients(id, {
      limit: q.limit,
      ...(q.status ? { status: q.status } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  }
}

/** Marketing › Automations: the after-delivery and win-back texts (ADR 0019). */
@ApiTags('campaigns')
@OrgScoped()
@RequireModule('marketing')
@Controller({ path: 'orgs/:orgId/automations', version: '1' })
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Both automations with previews and the last 30 days' })
  get() {
    return this.automations.get();
  }

  @Patch()
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Switch an automation on or off, set its days, text and link' })
  update(@ZodBody(dto.automationsBody) body: z.infer<typeof dto.automationsBody>) {
    return this.automations.update(body);
  }

  @Get('sends')
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Texts planned, sent and skipped, newest first' })
  sends(@ZodQuery(dto.automationSendsQuery) q: z.infer<typeof dto.automationSendsQuery>) {
    return this.automations.listSends({
      limit: q.limit,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  }
}

/** Short links in campaign and automation texts, for the storefront app (ADR 0019). */
@ApiTags('storefront')
@ApiHeader({ name: 'X-Storefront-Key', required: true, description: 'STOREFRONT_API_KEY' })
@ApiHeader({ name: 'X-Store-Host', required: true, description: 'The Host the shopper used' })
@OwnTokenAuth()
@UseGuards(StorefrontKeyGuard)
@Controller({ path: 'storefront/links', version: '1' })
export class StorefrontLinksController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly links: MarketingLinksService,
  ) {}

  @Get(':code')
  @ApiOperation({ summary: 'Where a short link goes, with its tracking tags (counts the click)' })
  async open(
    @Headers('x-store-host') rawHost: string | undefined,
    @ZodParam('code', dto.linkCodeParam) code: string,
  ) {
    const host = rawHost?.trim() ?? '';
    if (host.length < 3 || host.length > 260)
      throw AppError.badRequest('store_host_missing', 'Send the shop address in X-Store-Host.');
    // Landing pages stay open while the rest of the shop is closed, so links do too.
    const r = await this.storefront.resolve(host);
    if (!r || r.state === 'unavailable') throw AppError.notFound('link', 'This link is not valid.');
    const found = await this.storefront.inStore(r, () => this.links.open(r.store._id, code));
    if (!found) throw AppError.notFound('link', 'This link is not valid.');
    return found;
  }
}
