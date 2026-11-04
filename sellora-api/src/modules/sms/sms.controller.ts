import { Controller, Delete, Get, HttpCode, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { clientIp } from '../../common/http/client-info.js';
import { normalizePhone, objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { AppConfig } from '../../config/app-config.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import {
  OrgScoped,
  PlatformApi,
  Public,
  RequireAnyPermission,
  RequireModule,
  RequirePermissions,
  RequirePlatformPermissions,
} from '../auth/decorators.js';
import { rangeQuery, resolveRange } from '../billing/billing.dto.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { SmsAdminService } from './sms-admin.service.js';
import { SmsPlatformService } from './sms-platform.service.js';
import { SmsSettingsService } from './sms-settings.service.js';
import { SmsService } from './sms.service.js';
import * as dto from './sms.dto.js';

/** Settings › SMS, the message log and the opt-out list for one business. */
@ApiTags('sms')
@OrgScoped()
@RequireModule('commerce')
@Controller({ path: 'orgs/:orgId/sms', version: '1' })
export class SmsController {
  constructor(
    private readonly settings: SmsSettingsService,
    private readonly sms: SmsService,
    private readonly orgs: OrgsService,
  ) {}

  @Get()
  @RequireAnyPermission('org.integrations.manage', 'billing.view')
  @ApiOperation({ summary: 'How the business sends SMS, its order texts, prices and providers' })
  get() {
    return this.settings.get();
  }

  @Patch()
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Choose the route, language, shop name and order texts' })
  update(@ZodBody(dto.updateSettingsBody) body: z.infer<typeof dto.updateSettingsBody>) {
    return this.settings.update(body);
  }

  @Post('templates/reset')
  @HttpCode(200)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Put the default order texts back (in a language)' })
  reset(@ZodBody(dto.resetTemplatesBody) body: z.infer<typeof dto.resetTemplatesBody>) {
    return this.settings.resetTemplates(body.language);
  }

  @Put('gateway')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({
    summary: 'Connect (or replace) the business’s own SMS provider; credentials are checked first',
  })
  connect(@ZodBody(dto.connectGatewayBody) body: z.infer<typeof dto.connectGatewayBody>) {
    return this.settings.connectOwn(body);
  }

  @Patch('gateway')
  @RequirePermissions('org.integrations.manage')
  updateGateway(@ZodBody(dto.updateGatewayBody) body: z.infer<typeof dto.updateGatewayBody>) {
    return this.settings.updateOwn(body);
  }

  @Post('gateway/check')
  @HttpCode(200)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Check the saved provider credentials again' })
  check() {
    return this.settings.checkOwn();
  }

  @Delete('gateway')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Remove the business’s own provider (SMS turns off if it used it)' })
  removeGateway() {
    return this.settings.removeOwn();
  }

  @Put('sender-name')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Ask Sellora to approve a sender name for Sellora SMS' })
  requestSenderName(@ZodBody(dto.senderNameBody) body: z.infer<typeof dto.senderNameBody>) {
    return this.settings.requestSenderName(body.name);
  }

  @Delete('sender-name')
  @RequirePermissions('org.integrations.manage')
  cancelSenderName() {
    return this.settings.cancelSenderName();
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Send a test message now and say what the provider answered' })
  test(@ZodBody(dto.testBody) body: z.infer<typeof dto.testBody>) {
    return this.settings.sendTest(body);
  }

  @Get('summary')
  @RequireAnyPermission('org.integrations.manage', 'billing.view')
  @ApiOperation({ summary: 'The last 30 days: messages by status, parts and spend' })
  summary() {
    return this.sms.summary();
  }

  @Get('messages')
  @RequireAnyPermission('org.integrations.manage', 'billing.view', 'orders.view')
  @ApiOperation({ summary: 'Messages, newest first; filter by status, purpose, number or order' })
  async messages(@ZodQuery(dto.messagesQuery) q: z.infer<typeof dto.messagesQuery>) {
    const phone = q.phone ? await this.phone(q.phone, 'phone') : undefined;
    const page = await this.sms.list({
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.purpose ? { purpose: q.purpose } : {}),
      ...(phone ? { phone } : {}),
      ...(q.orderId ? { refType: 'order', refId: q.orderId } : {}),
    });
    return { ...page, items: page.items.map((m) => this.sms.toDto(m)) };
  }

  @Get('opt-outs')
  @RequireAnyPermission('org.integrations.manage', 'marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Numbers that must not get marketing messages' })
  async optOuts(
    @ZodQuery(dto.messagesQuery.pick({ limit: true, cursor: true }))
    q: {
      limit: number;
      cursor?: string;
    },
  ) {
    const page = await this.sms.listOptOuts(q);
    return {
      ...page,
      items: page.items.map((o) => ({
        phone: o.phone,
        source: o.source,
        at: o.createdAt.toISOString(),
      })),
    };
  }

  @Post('opt-outs')
  @HttpCode(204)
  @RequireAnyPermission('org.integrations.manage', 'marketing.manage')
  @ApiOperation({ summary: 'Stop marketing messages to a number (the customer asked by phone)' })
  async stop(@ZodBody(dto.optOutBody) body: z.infer<typeof dto.optOutBody>): Promise<void> {
    await this.sms.stop(await this.phone(body.phone, 'phone'), 'staff');
  }

  @Delete('opt-outs/:phone')
  @HttpCode(204)
  @RequireAnyPermission('org.integrations.manage', 'marketing.manage')
  @ApiOperation({ summary: 'Allow marketing messages to a number again (the customer asked)' })
  async allow(@ZodParam('phone', z.string().max(20)) raw: string): Promise<void> {
    await this.sms.allow(await this.phone(raw, 'phone'));
  }

  private async phone(raw: string, path: string): Promise<string> {
    const org = await this.orgs.get(RequestContext.tenant()!.orgId);
    const phone = normalizePhone(raw, org.country);
    if (!phone) throw AppError.validation([{ path, message: 'Invalid phone number' }]);
    return phone;
  }
}

/** Admin › SMS: Sellora's own SMS account, prices, sender names, limits and profit. */
@PlatformApi('sms')
@Controller({ path: 'platform/sms', version: '1' })
export class PlatformSmsController {
  constructor(
    private readonly platform: SmsPlatformService,
    private readonly admin: SmsAdminService,
  ) {}

  @Get()
  @RequirePlatformPermissions('platform.billing.view')
  @ApiOperation({ summary: 'Sellora SMS account, prices, costs and sender names waiting' })
  overview() {
    return this.admin.overview();
  }

  @Put('gateway')
  @RequirePlatformPermissions('platform.sms.manage')
  @ApiOperation({
    summary: 'Connect Sellora’s SMS provider account; credentials are checked first',
  })
  async connect(@ZodBody(dto.connectGatewayBody) body: z.infer<typeof dto.connectGatewayBody>) {
    const { platform, summary } = await this.platform.connect(body);
    return { platform: this.platform.toDto(platform), check: { summary } };
  }

  @Delete('gateway')
  @RequirePlatformPermissions('platform.sms.manage')
  @ApiOperation({ summary: 'Disconnect Sellora’s SMS account (Sellora SMS stops)' })
  async disconnect() {
    return this.platform.toDto(await this.platform.disconnect());
  }

  @Patch()
  @RequirePlatformPermissions('platform.sms.manage')
  @ApiOperation({
    summary: 'Switch Sellora SMS on or off, set the shared sender, prices and costs',
  })
  async update(@ZodBody(dto.platformUpdateBody) body: z.infer<typeof dto.platformUpdateBody>) {
    return this.platform.toDto(await this.platform.update(body));
  }

  @Post('test')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.sms.manage')
  @ApiOperation({ summary: 'Send a test from Sellora’s account (no business is charged)' })
  test(@ZodBody(dto.platformTestBody) body: z.infer<typeof dto.platformTestBody>) {
    return this.admin.testSend(body);
  }

  @Get('stats')
  @RequirePlatformPermissions('platform.billing.view')
  @ApiOperation({ summary: 'Sellora SMS by day: messages, revenue, cost and profit' })
  stats(@ZodQuery(rangeQuery) q: z.infer<typeof rangeQuery>) {
    const { from, to } = resolveRange(q);
    return this.admin.stats(from, to);
  }

  @Get('businesses')
  @RequirePlatformPermissions('platform.billing.view')
  @ApiOperation({ summary: 'Businesses that set SMS up, with 30 days of use and their limit' })
  businesses() {
    return this.admin.businesses();
  }

  @Put('businesses/:orgId/daily-limit')
  @RequirePlatformPermissions('platform.sms.manage')
  dailyLimit(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.dailyLimitBody) body: z.infer<typeof dto.dailyLimitBody>,
  ) {
    return this.admin.setDailyLimit(orgId, body.dailyLimit);
  }

  @Get('sender-names')
  @RequirePlatformPermissions('platform.stores.approve')
  @ApiOperation({ summary: 'Sender names to review, oldest first' })
  senderNames(@ZodQuery(dto.senderNamesQuery) q: z.infer<typeof dto.senderNamesQuery>) {
    return this.admin.senderNames(q);
  }

  @Post('sender-names/:orgId/approve')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  approve(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.approveSenderNameBody) body: z.infer<typeof dto.approveSenderNameBody>,
  ) {
    return this.admin.decideSenderName(orgId, { approve: true, name: body.name });
  }

  @Post('sender-names/:orgId/reject')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.stores.approve')
  reject(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.rejectSenderNameBody) body: z.infer<typeof dto.rejectSenderNameBody>,
  ) {
    return this.admin.decideSenderName(orgId, {
      approve: false,
      name: body.name,
      reason: body.reason,
    });
  }
}

/** The shopper's opt-out page and providers' delivery reports. No session. */
@ApiTags('sms')
@Controller({ path: 'public/sms', version: '1' })
export class PublicSmsController {
  constructor(
    private readonly sms: SmsService,
    private readonly rateLimit: RateLimitService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('opt-out/:code')
  @ApiOperation({ summary: 'What the opt-out page shows: the shop and a masked number' })
  async optOut(@ZodParam('code', dto.linkCode) code: string, @Req() req: Request) {
    await this.rateLimit.consume('sms-optout:ip', clientIp(req) ?? 'unknown');
    const link = await this.sms.publicLink(code);
    if (!link) throw AppError.notFound('link', 'This link is not valid.');
    return link;
  }

  /** A POST, so link previews and scanners that open the link stop nothing. */
  @Public()
  @Post('opt-out/:code')
  @HttpCode(200)
  async stop(@ZodParam('code', dto.linkCode) code: string, @Req() req: Request) {
    await this.rateLimit.consume('sms-optout:ip', clientIp(req) ?? 'unknown');
    if (!(await this.sms.publicStop(code)))
      throw AppError.notFound('link', 'This link is not valid.');
    return { stopped: true };
  }

  @Public()
  @Post('callbacks/:provider/:messageId')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  async callback(
    @ZodParam('provider', dto.providerParam) provider: z.infer<typeof dto.providerParam>,
    @ZodParam('messageId', z.string().max(40)) messageId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const base = this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
    const params = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k.toLowerCase(),
        Array.isArray(v) ? v.join(',') : (v ?? ''),
      ]),
    );
    // Providers retry until they get a 2xx; a report Sellora cannot use is answered the same way.
    await this.sms.applyCallback(provider, messageId, {
      url: `${base}${req.originalUrl}`,
      params,
      headers,
    });
    res.status(204).end();
  }
}
