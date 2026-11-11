import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  OwnTokenAuth,
  PlatformApi,
  RequireModule,
  RequirePermissions,
  RequirePlatformPermissions,
} from '../auth/decorators.js';
import * as cartsDto from '../carts/carts.dto.js';
import { StorefrontKeyGuard } from '../stores/storefront-key.guard.js';
import { idempotencyKey } from '../stores/stores.dto.js';
import * as dto from './landing-pages.dto.js';
import { LandingPagesService } from './landing-pages.service.js';
import { LandingReviewService } from './landing-review.service.js';
import { LandingStorefrontService, type ResolvedLanding } from './landing-storefront.service.js';
import { STARTER_TEXTS, TEMPLATES } from './templates.js';
import * as payDto from '../shop-payments/shop-payments.dto.js';
import * as adDto from '../ad-tracking/ad-tracking.dto.js';

// ---------------------------------------------------------------- merchant

@ApiTags('landing-pages')
@OrgScoped()
@RequireModule('landing_pages')
@Controller({ path: 'orgs/:orgId/landing-pages', version: '1' })
export class LandingPagesController {
  constructor(private readonly pages: LandingPagesService) {}

  @Get('templates')
  @RequirePermissions('stores.view')
  @ApiOperation({ summary: 'Templates a new page can start from' })
  templates() {
    return { items: TEMPLATES, starterTexts: [...STARTER_TEXTS] };
  }

  @Get('slug-check')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Whether a page address is free on a store' })
  slugCheck(@ZodQuery(dto.slugCheckQuery) q: z.infer<typeof dto.slugCheckQuery>) {
    return this.pages.slugCheck(q.storeId, q.slug);
  }

  @Get()
  @RequirePermissions('stores.view')
  list() {
    return this.pages.list();
  }

  @Post()
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Create a page (a draft) for a product from a template' })
  create(@ZodBody(dto.createBody) body: z.infer<typeof dto.createBody>) {
    return this.pages.create(body);
  }

  @Get(':pageId')
  @RequirePermissions('stores.view')
  get(@ZodParam('pageId', dto.pageIdParam) id: string) {
    return this.pages.detail(id);
  }

  @Patch(':pageId')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Rename the page or change its address (before it is published)' })
  settings(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodBody(dto.settingsBody) body: z.infer<typeof dto.settingsBody>,
  ) {
    return this.pages.updateSettings(id, body);
  }

  @Put(':pageId/draft')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Save the draft (shoppers do not see it until it is published)' })
  save(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodBody(dto.saveBody) body: z.infer<typeof dto.saveBody>,
  ) {
    return this.pages.saveDraft(id, body.content, body.revision);
  }

  @Post(':pageId/submit')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  @ApiOperation({ summary: 'Publish the draft: sends it for review, or publishes at once' })
  submit(@ZodParam('pageId', dto.pageIdParam) id: string) {
    return this.pages.submit(id);
  }

  @Post(':pageId/withdraw')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  withdraw(@ZodParam('pageId', dto.pageIdParam) id: string) {
    return this.pages.withdraw(id);
  }

  @Post(':pageId/pause')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  pause(@ZodParam('pageId', dto.pageIdParam) id: string) {
    return this.pages.pause(id);
  }

  @Post(':pageId/resume')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  resume(@ZodParam('pageId', dto.pageIdParam) id: string) {
    return this.pages.resume(id);
  }

  @Post(':pageId/duplicate')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Copy the page’s draft into a new page' })
  duplicate(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodBody(dto.duplicateBody) body: z.infer<typeof dto.duplicateBody>,
  ) {
    return this.pages.duplicate(id, body);
  }

  @Get(':pageId/versions')
  @RequirePermissions('stores.view')
  versions(@ZodParam('pageId', dto.pageIdParam) id: string) {
    return this.pages.listVersions(id);
  }

  @Post(':pageId/versions/:version/restore')
  @HttpCode(200)
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Copy a published version back into the draft' })
  restore(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodParam('version', dto.versionParam) version: number,
  ) {
    return this.pages.restore(id, version);
  }

  @Get(':pageId/stats')
  @RequirePermissions('stores.view')
  @ApiOperation({ summary: 'Visitors, orders and order value per day' })
  stats(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodQuery(dto.statsQuery) q: z.infer<typeof dto.statsQuery>,
  ) {
    return this.pages.daily(id, q.days);
  }

  @Post(':pageId/preview')
  @HttpCode(200)
  @RequirePermissions('stores.view')
  @ApiOperation({ summary: 'A one-hour link showing the draft as shoppers would see it' })
  preview(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodBody(dto.previewBody) body: z.infer<typeof dto.previewBody>,
  ) {
    return this.pages.previewLink(id, body.kind);
  }

  @Delete(':pageId')
  @HttpCode(204)
  @RequirePermissions('stores.publish')
  async remove(@ZodParam('pageId', dto.pageIdParam) id: string) {
    await this.pages.remove(id);
  }
}

// ---------------------------------------------------------------- platform

@PlatformApi('landing-pages')
@Controller({ path: 'platform/landing-pages', version: '1' })
export class PlatformLandingPagesController {
  constructor(private readonly review: LandingReviewService) {}

  @Get()
  @RequirePlatformPermissions('platform.stores.approve')
  list(@ZodQuery(dto.platformListQuery) q: z.infer<typeof dto.platformListQuery>) {
    return this.review.list(q);
  }

  @Get(':pageId')
  @RequirePlatformPermissions('platform.stores.approve')
  detail(@ZodParam('pageId', dto.pageIdParam) id: string) {
    return this.review.detail(id);
  }

  @Post(':pageId/approve')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Publish the snapshot waiting for review' })
  async approve(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodBody(dto.approveBody) body: z.infer<typeof dto.approveBody>,
  ) {
    await this.review.approve(id, body.revision, body.note || undefined);
    return this.review.detail(id);
  }

  @Post(':pageId/reject')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Ask for changes, with a reason the business sees' })
  async reject(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodBody(dto.rejectBody) body: z.infer<typeof dto.rejectBody>,
  ) {
    await this.review.reject(id, body.revision, body.reason);
    return this.review.detail(id);
  }

  @Post(':pageId/takedown')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Take the page off its store, with a reason' })
  async takedown(
    @ZodParam('pageId', dto.pageIdParam) id: string,
    @ZodBody(dto.reasonBody) body: z.infer<typeof dto.reasonBody>,
  ) {
    await this.review.takedown(id, body.reason);
    return this.review.detail(id);
  }

  @Post(':pageId/reinstate')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  async reinstate(@ZodParam('pageId', dto.pageIdParam) id: string) {
    await this.review.reinstate(id);
    return this.review.detail(id);
  }
}

// ---------------------------------------------------------------- shoppers (storefront app)

const STORE_HOST_HEADER = 'x-store-host';
const PREVIEW_HEADER = 'x-store-preview';

@ApiTags('storefront')
@ApiHeader({ name: 'X-Storefront-Key', required: true, description: 'STOREFRONT_API_KEY' })
@ApiHeader({ name: 'X-Store-Host', required: true, description: 'The Host the shopper used' })
@ApiHeader({ name: 'X-Shopper-Ip', required: false, description: "The shopper's IP address" })
@OwnTokenAuth()
@UseGuards(StorefrontKeyGuard)
@Controller({ path: 'storefront/landing-pages', version: '1' })
export class LandingStorefrontController {
  constructor(private readonly landing: LandingStorefrontService) {}

  private host(raw: string | undefined): string {
    const host = raw?.trim() ?? '';
    if (host.length < 3 || host.length > 260)
      throw AppError.badRequest('store_host_missing', 'Send the shop address in X-Store-Host.');
    return host;
  }

  private page(host: string | undefined, slug: string, preview?: string): Promise<ResolvedLanding> {
    return this.landing.require(this.host(host), slug, preview);
  }

  @Get()
  @ApiOperation({ summary: 'Live pages of the store that search engines may list' })
  sitemap(@Headers(STORE_HOST_HEADER) host: string | undefined) {
    return this.landing.sitemap(this.host(host));
  }

  @Get(':slug')
  @ApiOperation({ summary: 'The page at this address, or what to show instead' })
  async view(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
    @ZodParam('slug', dto.slugParam) slug: string,
  ) {
    return this.landing.view(await this.page(host, slug, preview));
  }

  @Post(':slug/visit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Count a visitor (once per browser and day)' })
  async visit(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodParam('slug', dto.slugParam) slug: string,
    @ZodBody(dto.visitBody) body: z.infer<typeof dto.visitBody>,
  ) {
    return this.landing.visit(await this.page(host, slug), body.visitorId);
  }

  @Post(':slug/ad-events')
  @HttpCode(200)
  @ApiOperation({ summary: 'Copy a shopper step to the business’s ad platforms (ADR 0030)' })
  async adEvent(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodParam('slug', dto.slugParam) slug: string,
    @ZodBody(adDto.browserEventBody) body: z.infer<typeof adDto.browserEventBody>,
  ) {
    // Previews never send anything: `page` is resolved without the preview token.
    return this.landing.adEvent(await this.page(host, slug), body);
  }

  @Post(':slug/orders')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Place an order from the page (pending until confirmed); online payment starts',
  })
  async order(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers('idempotency-key') rawKey: string | undefined,
    @ZodParam('slug', dto.slugParam) slug: string,
    @ZodBody(dto.orderBody) body: z.infer<typeof dto.orderBody>,
  ) {
    const key = idempotencyKey.safeParse(rawKey ?? '');
    if (!key.success)
      throw AppError.badRequest('idempotency_key_required', key.error.issues[0]!.message);
    // Previews never take orders: `page` is resolved without the preview token.
    return this.landing.order(await this.page(host, slug), body, key.data);
  }

  @Post(':slug/carts')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the order form’s choice for reminders (only while the business has them on)',
  })
  async saveCart(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodParam('slug', dto.slugParam) slug: string,
    @ZodBody(cartsDto.landingCartBody) body: z.infer<typeof cartsDto.landingCartBody>,
  ) {
    // Previews never save carts: `page` is resolved without the preview token.
    return this.landing.saveCart(await this.page(host, slug), body);
  }

  @Post(':slug/pay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start paying what is still due online, from the thank-you page' })
  async pay(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodParam('slug', dto.slugParam) slug: string,
    @ZodBody(payDto.payBody) body: z.infer<typeof payDto.payBody>,
  ) {
    return this.landing.pay(await this.page(host, slug), body.receipt, body.gateway);
  }

  @Get(':slug/receipt')
  async receipt(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodParam('slug', dto.slugParam) slug: string,
    @ZodQuery(dto.receiptQuery) q: z.infer<typeof dto.receiptQuery>,
  ) {
    return this.landing.receipt(await this.page(host, slug), q.receipt);
  }
}
