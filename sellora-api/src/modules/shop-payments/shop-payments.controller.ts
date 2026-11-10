import { Controller, Delete, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam } from '../../common/validation/zod.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import {
  GatewayCallback,
  OrgScoped,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators.js';
import { ShopSettingsService } from '../commerce/shop-settings.service.js';
import { ShopPaymentAccountsService } from './shop-payment-accounts.service.js';
import * as dto from './shop-payments.dto.js';
import { ShopPaymentsService, type ReturnOutcome } from './shop-payments.service.js';

/** Settings › Payments: the business's own gateways and how shoppers may pay (ADR 0029). */
@ApiTags('payments at checkout')
@OrgScoped()
@Controller({ path: 'orgs/:orgId/shop-payments', version: '1' })
export class ShopPaymentSettingsController {
  constructor(
    private readonly accounts: ShopPaymentAccountsService,
    private readonly shopSettings: ShopSettingsService,
  ) {}

  private async overview() {
    const [list, settings, shop] = await Promise.all([
      this.accounts.list(),
      this.accounts.settings(),
      this.shopSettings.get(),
    ]);
    return {
      gateways: this.accounts.descriptors(),
      accounts: list.map((a) => this.accounts.toDto(a)),
      settings: this.accounts.settingsDto(settings),
      zones: shop.deliveryZones.map((z) => ({
        id: z.id,
        name: z.name,
        chargeMinor: z.chargeMinor,
      })),
    };
  }

  @Get()
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Gateways, connected accounts (nothing secret) and payment options' })
  get() {
    return this.overview();
  }

  @Post('accounts')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Connect a gateway with the business’s own keys (checked first)' })
  async create(@ZodBody(dto.createAccountBody) body: z.infer<typeof dto.createAccountBody>) {
    const account = await this.accounts.create(body);
    return { account: this.accounts.toDto(account) };
  }

  @Patch('accounts/:accountId')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'New keys, sandbox or live, on or off' })
  async update(
    @ZodParam('accountId', objectIdSchema) id: string,
    @ZodBody(dto.updateAccountBody) body: z.infer<typeof dto.updateAccountBody>,
  ) {
    const account = await this.accounts.update(id, body);
    return { account: this.accounts.toDto(account) };
  }

  @Delete('accounts/:accountId')
  @HttpCode(204)
  @RequirePermissions('org.integrations.manage')
  async remove(@ZodParam('accountId', objectIdSchema) id: string): Promise<void> {
    await this.accounts.remove(id);
  }

  @Patch('settings')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Cash on delivery, full online payment and the advance' })
  async settings(@ZodBody(dto.settingsBody) body: z.infer<typeof dto.settingsBody>) {
    const s = await this.accounts.updateSettings(body);
    return { settings: this.accounts.settingsDto(s) };
  }
}

/** The online payment attempts of an order, for staff. */
@ApiTags('payments at checkout')
@OrgScoped()
@Controller({ path: 'orgs/:orgId/orders/:orderId/online-payments', version: '1' })
export class OrderOnlinePaymentsController {
  constructor(private readonly payments: ShopPaymentsService) {}

  @Get()
  @RequireAnyPermission('orders.view', 'orders.manage')
  async list(@ZodParam('orderId', objectIdSchema) orderId: string) {
    return { items: await this.payments.forOrder(orderId) };
  }
}

/** Single text values from a gateway's query or form; anything else is dropped. */
function params(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of [
    req.query as Record<string, unknown>,
    (req.body ?? {}) as Record<string, unknown>,
  ]) {
    for (const [k, v] of Object.entries(source ?? {}))
      if (typeof v === 'string' && v.length <= 2_000 && k.length <= 60) out[k] = v;
  }
  return out;
}

/**
 * Where gateways send shoppers back, and SSLCommerz's server notice. Nothing here is trusted
 * on its own: the service asks the gateway with the business's keys before money moves.
 */
@ApiTags('payments at checkout')
@Controller({ path: 'shop-payments', version: '1' })
export class ShopPaymentReturnsController {
  constructor(
    private readonly payments: ShopPaymentsService,
    private readonly limits: RateLimitService,
  ) {}

  private async back(ref: string, outcome: ReturnOutcome | 'notify', req: Request) {
    const ip = RequestContext.current()?.ip;
    if (ip) await this.limits.consume('shop-pay:return', ip);
    const url = await this.payments.handleReturn(ref, outcome, params(req));
    if (!url) throw AppError.notFound('payment');
    return url;
  }

  @GatewayCallback()
  @Get(':ref/return/:outcome')
  @ApiExcludeEndpoint()
  async returnGet(
    @ZodParam('ref', dto.refParam) ref: string,
    @ZodParam('outcome', dto.outcomeParam) outcome: ReturnOutcome,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.redirect(303, await this.back(ref, outcome, req));
  }

  @GatewayCallback()
  @Post(':ref/return/:outcome')
  @ApiExcludeEndpoint()
  async returnPost(
    @ZodParam('ref', dto.refParam) ref: string,
    @ZodParam('outcome', dto.outcomeParam) outcome: ReturnOutcome,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.redirect(303, await this.back(ref, outcome, req));
  }

  @GatewayCallback()
  @Post(':ref/notify')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async notify(@ZodParam('ref', dto.refParam) ref: string, @Req() req: Request) {
    await this.back(ref, 'notify', req);
    return { received: true };
  }
}
