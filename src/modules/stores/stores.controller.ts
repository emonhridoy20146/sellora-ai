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
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  OwnTokenAuth,
  PlatformApi,
  Public,
  RequireModule,
  RequirePermissions,
  RequirePlatformPermissions,
} from '../auth/decorators.js';
import * as cartsDto from '../carts/carts.dto.js';
import { STORE_PAGE_KEYS } from './schemas.js';
import { StoreDomainsService } from './store-domains.service.js';
import { StoreReviewService } from './store-review.service.js';
import { StoreStatsService } from './store-stats.service.js';
import { StorefrontKeyGuard } from './storefront-key.guard.js';
import { StorefrontService, type ResolvedStore } from './storefront.service.js';
import * as dto from './stores.dto.js';
import { StoresService } from './stores.service.js';

// ---------------------------------------------------------------- merchant

@ApiTags('stores')
@OrgScoped()
@RequireModule('storefront')
@Controller({ path: 'orgs/:orgId/stores', version: '1' })
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly storeStats: StoreStatsService,
  ) {}

  @Get('themes')
  @RequirePermissions('stores.view')
  @ApiOperation({ summary: 'Store themes, with the ones that suit this business first' })
  themes() {
    return this.stores.themes();
  }

  @Get('handle-check')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Whether a store address (subdomain) can be used' })
  checkHandle(@ZodQuery(dto.handleCheckQuery) q: z.infer<typeof dto.handleCheckQuery>) {
    return this.stores.checkHandle(q.handle, q.storeId);
  }

  @Get()
  @RequirePermissions('stores.view')
  async list() {
    const { items, limit } = await this.stores.list();
    return { items: items.map((s) => this.stores.toDto(s)), limit, used: items.length };
  }

  @Post()
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Create a store (a draft) with a starter design' })
  async create(@ZodBody(dto.createStoreBody) body: z.infer<typeof dto.createStoreBody>) {
    const store = await this.stores.create(body);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Get(':storeId')
  @RequirePermissions('stores.view')
  async get(@ZodParam('storeId', dto.storeIdParam) id: string) {
    const store = await this.stores.get(id);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Get(':storeId/stats')
  @RequirePermissions('stores.view')
  @ApiOperation({ summary: 'Visitors, their steps, orders, sources and top products per day' })
  async numbers(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodQuery(dto.storeStatsQuery) q: z.infer<typeof dto.storeStatsQuery>,
  ) {
    const store = await this.stores.get(id);
    return this.storeStats.summary(store._id, q.days);
  }

  @Patch(':storeId')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Name, address, contact, social links, search text, pages, checkout' })
  async update(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodBody(dto.updateStoreBody) body: z.infer<typeof dto.updateStoreBody>,
  ) {
    const store = await this.stores.update(id, body);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Put(':storeId/theme')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Save the theme, colours, images and home page sections' })
  async setTheme(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodBody(dto.themeBody) body: z.infer<typeof dto.themeBody>,
  ) {
    const store = await this.stores.setTheme(id, body.themeKey, body.theme);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Post(':storeId/submit')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  @ApiOperation({ summary: 'Send the store for review (opens at once with automatic approval)' })
  async submit(@ZodParam('storeId', dto.storeIdParam) id: string) {
    const store = await this.stores.submit(id);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Post(':storeId/withdraw')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  async withdraw(@ZodParam('storeId', dto.storeIdParam) id: string) {
    const store = await this.stores.withdraw(id);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Post(':storeId/pause')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  async pause(@ZodParam('storeId', dto.storeIdParam) id: string) {
    const store = await this.stores.pause(id);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Post(':storeId/resume')
  @HttpCode(200)
  @RequirePermissions('stores.publish')
  async resume(@ZodParam('storeId', dto.storeIdParam) id: string) {
    const store = await this.stores.resume(id);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }

  @Delete(':storeId')
  @HttpCode(204)
  @RequirePermissions('stores.publish')
  async remove(@ZodParam('storeId', dto.storeIdParam) id: string): Promise<void> {
    await this.stores.remove(id);
  }

  @Post(':storeId/preview-link')
  @HttpCode(200)
  @RequirePermissions('stores.view')
  @ApiOperation({ summary: 'A one-hour link that shows the store before it opens' })
  previewLink(@ZodParam('storeId', dto.storeIdParam) id: string) {
    return this.stores.previewLink(id);
  }
}

@ApiTags('stores')
@OrgScoped()
@RequireModule('storefront')
@Controller({ path: 'orgs/:orgId/stores/:storeId/domains', version: '1' })
export class StoreDomainsMerchantController {
  constructor(private readonly domains: StoreDomainsService) {}

  @Get()
  @RequirePermissions('stores.view')
  @ApiOperation({ summary: "The store's custom domains, with the DNS records each needs" })
  list(@ZodParam('storeId', dto.storeIdParam) storeId: string) {
    return this.domains.list(storeId);
  }

  @Post()
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Add a custom domain (checked against DNS straight away)' })
  add(
    @ZodParam('storeId', dto.storeIdParam) storeId: string,
    @ZodBody(dto.addDomainBody) body: z.infer<typeof dto.addDomainBody>,
  ) {
    return this.domains.add(storeId, body.domain);
  }

  @Post(':domainId/check')
  @HttpCode(200)
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: "Look up the domain's DNS records now" })
  check(
    @ZodParam('storeId', dto.storeIdParam) storeId: string,
    @ZodParam('domainId', dto.domainIdParam) domainId: string,
  ) {
    return this.domains.check(storeId, domainId);
  }

  @Delete(':domainId')
  @HttpCode(204)
  @RequirePermissions('stores.manage')
  async remove(
    @ZodParam('storeId', dto.storeIdParam) storeId: string,
    @ZodParam('domainId', dto.domainIdParam) domainId: string,
  ): Promise<void> {
    await this.domains.remove(storeId, domainId);
  }
}

@ApiTags('stores')
@OrgScoped()
@RequireModule('storefront')
@Controller({ path: 'orgs/:orgId/stores/:storeId/primary-domain', version: '1' })
export class StorePrimaryDomainController {
  constructor(
    private readonly domains: StoreDomainsService,
    private readonly stores: StoresService,
  ) {}

  @Put()
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Choose the address shoppers are sent to' })
  async set(
    @ZodParam('storeId', dto.storeIdParam) storeId: string,
    @ZodBody(dto.primaryDomainBody) body: z.infer<typeof dto.primaryDomainBody>,
  ) {
    const store = await this.domains.setPrimary(storeId, body.domainId);
    return this.stores.toDto(store, await this.stores.readiness(store));
  }
}

// ---------------------------------------------------------------- super-admin

@PlatformApi('stores')
@Controller({ path: 'platform/store-domains', version: '1' })
export class PlatformStoreDomainsController {
  constructor(private readonly domains: StoreDomainsService) {}

  @Get()
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Custom domains: the review queue first come, first served' })
  list(@ZodQuery(dto.platformDomainsQuery) q: z.infer<typeof dto.platformDomainsQuery>) {
    return this.domains.platformList(q);
  }

  @Post(':domainId/approve')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  async approve(@ZodParam('domainId', dto.domainIdParam) id: string) {
    return this.domains.platformDetail(await this.domains.approve(id));
  }

  @Post(':domainId/reject')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Refuse a domain in review, or disconnect a connected one' })
  async reject(
    @ZodParam('domainId', dto.domainIdParam) id: string,
    @ZodBody(dto.reasonBody) body: z.infer<typeof dto.reasonBody>,
  ) {
    return this.domains.platformDetail(await this.domains.reject(id, body.reason));
  }
}

@PlatformApi('stores')
@Controller({ path: 'platform/stores', version: '1' })
export class PlatformStoresController {
  constructor(private readonly review: StoreReviewService) {}

  @Get()
  @RequirePlatformPermissions('platform.stores.approve')
  list(@ZodQuery(dto.platformStoresQuery) q: z.infer<typeof dto.platformStoresQuery>) {
    return this.review.list(q);
  }

  @Get(':storeId')
  @RequirePlatformPermissions('platform.stores.approve')
  detail(@ZodParam('storeId', dto.storeIdParam) id: string) {
    return this.review.detail(id);
  }

  @Post(':storeId/recheck')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Run the automatic check again' })
  recheck(@ZodParam('storeId', dto.storeIdParam) id: string) {
    return this.review.recheck(id);
  }

  @Post(':storeId/approve')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  async approve(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodBody(dto.approveBody) body: z.infer<typeof dto.approveBody>,
  ) {
    await this.review.approve(id, body.note || undefined);
    return this.review.detail(id);
  }

  @Post(':storeId/reject')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  async reject(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodBody(dto.reasonBody) body: z.infer<typeof dto.reasonBody>,
  ) {
    await this.review.reject(id, body.reason);
    return this.review.detail(id);
  }

  @Post(':storeId/suspend')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  async suspend(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodBody(dto.reasonBody) body: z.infer<typeof dto.reasonBody>,
  ) {
    await this.review.suspend(id, body.reason);
    return this.review.detail(id);
  }

  @Post(':storeId/reinstate')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  async reinstate(@ZodParam('storeId', dto.storeIdParam) id: string) {
    await this.review.reinstate(id);
    return this.review.detail(id);
  }

  @Post(':storeId/changes/accept')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Mark changes made after approval as looked at and fine' })
  async acceptChanges(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodBody(dto.acceptChangesBody) body: z.infer<typeof dto.acceptChangesBody>,
  ) {
    await this.review.acceptChanges(id, new Date(body.lastChangeAt));
    return this.review.detail(id);
  }

  @Post(':storeId/changes/ask')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Ask the business to fix something it changed (the store stays open)' })
  async askForFix(
    @ZodParam('storeId', dto.storeIdParam) id: string,
    @ZodBody(dto.reasonBody) body: z.infer<typeof dto.reasonBody>,
  ) {
    await this.review.askForFix(id, body.reason);
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
@Controller({ path: 'storefront', version: '1' })
export class StorefrontController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly stats: StoreStatsService,
  ) {}

  private host(raw: string | undefined): string {
    const parsed = dto.resolveQuery.safeParse({ host: raw ?? '' });
    if (!parsed.success)
      throw AppError.badRequest('store_host_missing', 'Send the shop address in X-Store-Host.');
    return parsed.data.host;
  }

  /** Runs `fn` for an open (or previewed) store, inside its business. */
  private open<T>(
    host: string | undefined,
    preview: string | undefined,
    fn: (r: ResolvedStore) => Promise<T>,
  ): Promise<T> {
    return this.storefront
      .requireOpen(this.host(host), preview)
      .then((r) => this.storefront.inStore(r, () => fn(r)));
  }

  @Get('resolve')
  @ApiOperation({ summary: 'The store at this address and whether it is open' })
  async resolve(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
  ) {
    const r = await this.storefront.resolve(this.host(host), preview);
    if (!r) throw AppError.notFound('store');
    return this.storefront.publicStore(r);
  }

  @Get('home')
  home(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
  ) {
    return this.open(host, preview, (r) => this.storefront.home(r));
  }

  @Get('categories')
  async categories(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
  ) {
    return { items: await this.open(host, preview, () => this.storefront.categoryList()) };
  }

  @Get('products')
  products(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
    @ZodQuery(dto.productListQuery) q: z.infer<typeof dto.productListQuery>,
  ) {
    return this.open(host, preview, () => this.storefront.productList(q));
  }

  @Get('products/:slug')
  product(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
    @ZodParam('slug', dto.productSlugParam) slug: string,
  ) {
    return this.open(host, preview, () => this.storefront.product(slug));
  }

  @Get('pages/:key')
  page(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
    @ZodParam('key', z.enum(STORE_PAGE_KEYS)) key: (typeof STORE_PAGE_KEYS)[number],
  ) {
    return this.open(host, preview, (r) => Promise.resolve(this.storefront.page(r, key)));
  }

  @Get('sitemap')
  sitemap(@Headers(STORE_HOST_HEADER) host: string | undefined) {
    // Only open stores are listed for search engines; previews never are.
    return this.open(host, undefined, (r) => this.storefront.sitemap(r));
  }

  @Post('cart')
  @HttpCode(200)
  @ApiOperation({ summary: 'Price a cart and list the delivery areas' })
  cart(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
    @ZodBody(dto.cartBody) body: z.infer<typeof dto.cartBody>,
  ) {
    return this.open(host, preview, (r) => this.storefront.cartQuote(r, body.items, body.zoneId));
  }

  @Post('carts')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the checkout cart for reminders (only while the business has them on)',
  })
  saveCart(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodBody(cartsDto.storeCartBody) body: z.infer<typeof cartsDto.storeCartBody>,
  ) {
    // Previews never save carts: a reviewer's number must not get reminders.
    return this.open(host, undefined, (r) => this.storefront.saveCart(r, body));
  }

  @Get('carts/:code')
  @ApiOperation({ summary: 'The cart behind a reminder link (items and the shopper’s details)' })
  async restoreCart(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodParam('code', cartsDto.cartCodeParam) code: string,
  ) {
    // Landing page carts come back while the rest of the shop is closed too.
    const r = await this.storefront.resolve(this.host(host));
    if (!r || r.state === 'unavailable') throw AppError.notFound('cart', 'This link is not valid.');
    return this.storefront.inStore(r, () => this.storefront.restoreCart(r, code));
  }

  @Post('events')
  @HttpCode(200)
  @ApiOperation({ summary: 'Count a shopper step (once per browser, step and day)' })
  event(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodBody(dto.storeEventBody) body: z.infer<typeof dto.storeEventBody>,
  ) {
    // Previews never count: the business and the reviewer are not shoppers.
    return this.open(host, undefined, (r) => this.stats.record(r, body));
  }

  @Post('checkout')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Place a cash-on-delivery order (pending until the business confirms)' })
  checkout(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @Headers('idempotency-key') rawKey: string | undefined,
    @ZodBody(dto.checkoutBody) body: z.infer<typeof dto.checkoutBody>,
  ) {
    const key = dto.idempotencyKey.safeParse(rawKey ?? '');
    if (!key.success)
      throw AppError.badRequest('idempotency_key_required', key.error.issues[0]!.message);
    // Previews never take orders: a reviewer must not be able to place one by accident.
    return this.open(host, undefined, (r) => this.storefront.checkout(r, body, key.data));
  }

  @Get('orders/receipt')
  receipt(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodQuery(dto.receiptQuery) q: z.infer<typeof dto.receiptQuery>,
  ) {
    return this.open(host, undefined, (r) => this.storefront.receipt(r, q.receipt));
  }

  @Post('orders/track')
  @HttpCode(200)
  @ApiOperation({ summary: 'Order status by order number and phone number' })
  track(
    @Headers(STORE_HOST_HEADER) host: string | undefined,
    @ZodBody(dto.trackBody) body: z.infer<typeof dto.trackBody>,
  ) {
    return this.open(host, undefined, (r) => this.storefront.track(r, body.number, body.phone));
  }
}

/** Asked by the web server before it gets a TLS certificate for a store's address. */
@ApiTags('storefront')
@Controller({ path: 'public/store-domains', version: '1' })
export class StoreDomainsController {
  constructor(private readonly storefront: StorefrontService) {}

  @Public()
  @Get('check')
  @ApiOperation({ summary: '200 when the domain is a store address, 404 otherwise' })
  async check(@ZodQuery(dto.domainCheckQuery) q: z.infer<typeof dto.domainCheckQuery>) {
    if (!(await this.storefront.domainIsStore(q.domain))) throw AppError.notFound('store');
    return { ok: true };
  }
}
