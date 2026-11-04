import { Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  currencySchema,
  objectIdSchema,
  paginationQuerySchema,
} from '../../common/validation/schemas.js';
import { AllowSuspendedOrg, OrgScoped, Public, RequirePermissions } from '../auth/decorators.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import * as dto from './billing.dto.js';
import { CreditsService, toMerchantUsageDto, toPublicRateDto } from './credits.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { InvoicesService, toInvoiceDto } from './invoices.service.js';
import { GatewayConfigService } from './payments/gateway-config.service.js';
import { PaymentsService, toPaymentDto } from './payments/payments.service.js';
import { PlansService, toPlanDto } from './plans.service.js';
import { SubscriptionsService, toSubscriptionDto } from './subscriptions.service.js';
import { WalletService, toBalance, type LedgerDoc } from './wallet.service.js';
import { WithdrawalsService, toWithdrawalDto } from './withdrawals.service.js';

function toLedgerDto(e: LedgerDoc) {
  return {
    id: e._id.toHexString(),
    type: e.type,
    amountMinor: e.amountMinor,
    balanceAfterMinor: e.balanceAfterMinor,
    currency: e.currency,
    description: e.description,
    credits: e.credits ?? null,
    reference: e.reference ?? null,
    at: e.createdAt.toISOString(),
  };
}

/**
 * The business's own billing: plan, wallet, AI credit usage, payments, invoices and
 * withdrawals. Reachable while the business is suspended so it can pay to get back in.
 * Nothing here exposes provider cost, model names or platform margins.
 */
@ApiTags('billing')
@OrgScoped()
@AllowSuspendedOrg()
@Controller({ path: 'orgs/:orgId/billing', version: '1' })
export class BillingController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly entitlements: EntitlementsService,
    private readonly plans: PlansService,
    private readonly wallet: WalletService,
    private readonly credits: CreditsService,
    private readonly payments: PaymentsService,
    private readonly gateways: GatewayConfigService,
    private readonly invoices: InvoicesService,
    private readonly withdrawals: WithdrawalsService,
    private readonly settings: PlatformSettingsService,
    private readonly orgs: OrgsService,
  ) {}

  private orgId() {
    return RequestContext.tenant()!.orgId;
  }

  @Get('summary')
  @RequirePermissions('billing.view')
  @ApiOperation({ summary: 'Plan, entitlements, wallet and the AI credit price list in one call' })
  async summary() {
    const [sub, wallet] = await Promise.all([this.subscriptions.get(), this.wallet.get()]);
    const [ent, rate, settings] = await Promise.all([
      this.entitlements.forOrg(this.orgId()),
      this.credits.currentRate(wallet.currency).catch(() => null),
      this.settings.get(),
    ]);
    return {
      subscription: toSubscriptionDto(sub, ent),
      wallet: toBalance(wallet),
      creditRate: rate ? toPublicRateDto(rate) : null,
      withdrawalsEnabled: settings.billing.withdrawalsEnabled,
    };
  }

  @Get('plans')
  @RequirePermissions('billing.view')
  async plansList() {
    const currency = (await this.wallet.get()).currency;
    return (await this.plans.listPublic()).map((p) => toPlanDto(p, currency));
  }

  @Post('subscription')
  @HttpCode(200)
  @RequirePermissions('billing.manage')
  @ApiOperation({
    summary: 'Buy or switch plan, paying from the wallet (unused paid time is refunded pro rata)',
  })
  async subscribe(@ZodBody(dto.subscribeBody) body: z.infer<typeof dto.subscribeBody>) {
    const sub = await this.subscriptions.subscribe(body.planCode, body.interval);
    return toSubscriptionDto(sub, await this.entitlements.forOrg(this.orgId()));
  }

  @Post('subscription/checkout')
  @RequirePermissions('billing.manage')
  @ApiOperation({ summary: 'Pay for a plan through a payment gateway; returns the checkout URL' })
  async planCheckout(@ZodBody(dto.planCheckoutBody) body: z.infer<typeof dto.planCheckoutBody>) {
    return toPaymentDto(await this.payments.createPlanCheckout(body));
  }

  @Post('subscription/cancel')
  @HttpCode(200)
  @RequirePermissions('billing.manage')
  async cancel() {
    const sub = await this.subscriptions.cancel();
    return toSubscriptionDto(sub, await this.entitlements.forOrg(this.orgId()));
  }

  @Post('subscription/resume')
  @HttpCode(200)
  @RequirePermissions('billing.manage')
  async resume() {
    const sub = await this.subscriptions.resume();
    return toSubscriptionDto(sub, await this.entitlements.forOrg(this.orgId()));
  }

  @Get('wallet')
  @RequirePermissions('billing.view')
  wallet_() {
    return this.wallet.balance();
  }

  @Get('wallet/ledger')
  @RequirePermissions('billing.view')
  async ledger(@ZodQuery(dto.ledgerQuery) q: z.infer<typeof dto.ledgerQuery>) {
    const page = await this.wallet.history(q);
    return { items: page.items.map(toLedgerDto), nextCursor: page.nextCursor };
  }

  @Get('payment-methods')
  @RequirePermissions('billing.view')
  async paymentMethods() {
    const currency = (await this.wallet.get()).currency;
    const [list, manual, settings] = await Promise.all([
      this.gateways.list(),
      this.gateways.manualInstructions(),
      this.settings.get(),
    ]);
    return {
      currency,
      minTopupMinor: settings.billing.minTopupMinor,
      maxTopupMinor: settings.billing.maxTopupMinor,
      online: list
        .filter(
          (g) =>
            g.key !== 'manual' &&
            g.enabled &&
            g.configured &&
            (g.currencies === 'any' || g.currencies.includes(currency)),
        )
        .map((g) => ({ key: g.key, sandbox: g.sandbox })),
      manual,
    };
  }

  @Post('wallet/topups')
  @RequirePermissions('billing.manage')
  @ApiOperation({
    summary: 'Start a wallet top-up through a gateway; send the payer to checkoutUrl',
  })
  async topup(@ZodBody(dto.topupBody) body: z.infer<typeof dto.topupBody>) {
    return toPaymentDto(await this.payments.createTopup(body));
  }

  @Post('wallet/manual-topups')
  @RequirePermissions('billing.manage')
  @ApiOperation({ summary: 'Report a bKash/Nagad/bank transfer for the platform to confirm' })
  async manualTopup(@ZodBody(dto.manualTopupBody) body: z.infer<typeof dto.manualTopupBody>) {
    const { amountMinor, ...transfer } = body;
    return toPaymentDto(await this.payments.submitManual({ amountMinor, transfer }));
  }

  @Get('payments')
  @RequirePermissions('billing.view')
  async paymentsList(@ZodQuery(paginationQuerySchema) q: z.infer<typeof paginationQuerySchema>) {
    const page = await this.payments.list(q);
    return { items: page.items.map(toPaymentDto), nextCursor: page.nextCursor };
  }

  @Get('payments/:paymentId')
  @RequirePermissions('billing.view')
  async payment(@ZodParam('paymentId', objectIdSchema) paymentId: string) {
    return toPaymentDto(await this.payments.get(paymentId));
  }

  @Get('ai-usage')
  @RequirePermissions('billing.view')
  @ApiOperation({ summary: 'Credits used per day and per feature' })
  async usageSummary(@ZodQuery(dto.rangeQuery) q: z.infer<typeof dto.rangeQuery>) {
    const { from, to } = dto.resolveRange(q);
    const org = await this.orgs.get(this.orgId());
    return this.credits.usageSummary(from, to, org.timezone);
  }

  @Get('ai-usage/requests')
  @RequirePermissions('billing.view')
  async usageList(@ZodQuery(dto.usageQuery) q: z.infer<typeof dto.usageQuery>) {
    const page = await this.credits.listUsage(q);
    return { items: page.items.map(toMerchantUsageDto), nextCursor: page.nextCursor };
  }

  @Post('ai-usage/quote')
  @HttpCode(200)
  @RequirePermissions('billing.view')
  @ApiOperation({ summary: 'How many credits a call of this size would cost' })
  quote(@ZodBody(dto.quoteBody) body: z.infer<typeof dto.quoteBody>) {
    return this.credits.quote(body.tier, {
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
    });
  }

  @Get('invoices')
  @RequirePermissions('billing.view')
  async invoiceList(@ZodQuery(paginationQuerySchema) q: z.infer<typeof paginationQuerySchema>) {
    const [page, settings] = await Promise.all([this.invoices.list(q), this.settings.get()]);
    return {
      items: page.items.map((i) => toInvoiceDto(i, settings.billing.taxLabel)),
      nextCursor: page.nextCursor,
    };
  }

  @Get('invoices/:invoiceId')
  @RequirePermissions('billing.view')
  async invoice(@ZodParam('invoiceId', objectIdSchema) invoiceId: string) {
    const inv = await this.invoices.get(invoiceId);
    if (!inv) throw AppError.notFound('invoice');
    return toInvoiceDto(inv, (await this.settings.get()).billing.taxLabel);
  }

  @Get('withdrawals')
  @RequirePermissions('billing.view')
  async withdrawalList(@ZodQuery(paginationQuerySchema) q: z.infer<typeof paginationQuerySchema>) {
    const page = await this.withdrawals.list(q);
    return { items: page.items.map(toWithdrawalDto), nextCursor: page.nextCursor };
  }

  @Post('withdrawals')
  @RequirePermissions('billing.manage')
  @ApiOperation({ summary: 'Ask to withdraw unused wallet cash (free credit is not withdrawable)' })
  async withdraw(@ZodBody(dto.withdrawalBody) body: z.infer<typeof dto.withdrawalBody>) {
    return toWithdrawalDto(await this.withdrawals.request(body));
  }

  @Post('withdrawals/:withdrawalId/cancel')
  @HttpCode(200)
  @RequirePermissions('billing.manage')
  async cancelWithdrawal(@ZodParam('withdrawalId', objectIdSchema) id: string) {
    return toWithdrawalDto(await this.withdrawals.cancel(id));
  }
}

/** Plan catalogue for the marketing site and sign-up. */
@ApiTags('catalogs')
@Controller({ path: 'public', version: '1' })
export class PublicBillingController {
  constructor(private readonly plans: PlansService) {}

  @Public()
  @Get('plans')
  async list(
    @ZodQuery(z.object({ currency: currencySchema.optional() })) q: { currency?: string },
  ) {
    return (await this.plans.listPublic()).map((p) => toPlanDto(p, q.currency));
  }
}

/**
 * Where payment gateways call back. Nothing here is trusted on its own: every success is
 * re-verified with the gateway (SSLCommerz validation API, bKash execute/query, Stripe
 * signed webhooks) before money moves.
 */
@ApiTags('payment callbacks')
@Controller({ path: 'payments', version: '1' })
export class PaymentCallbacksController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post('sslcommerz/ipn')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async sslcommerzIpn(@Req() req: Request) {
    await this.payments.handleSslcommerzIpn((req.body ?? {}) as Record<string, unknown>);
    return { received: true };
  }

  @Public()
  @Post('sslcommerz/return/:paymentId/:outcome')
  @ApiExcludeEndpoint()
  async sslcommerzReturn(
    @Param('paymentId') paymentId: string,
    @Param('outcome') outcome: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result =
      outcome === 'success' || outcome === 'fail' || outcome === 'cancel' ? outcome : 'fail';
    const url = await this.payments.handleSslcommerzReturn(
      paymentId,
      result,
      (req.body ?? {}) as Record<string, unknown>,
    );
    res.redirect(303, url);
  }

  @Public()
  @Get('bkash/callback/:paymentId')
  @ApiExcludeEndpoint()
  async bkashCallback(
    @Param('paymentId') paymentId: string,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const url = await this.payments.handleBkashCallback(paymentId, {
      ...(typeof query.paymentID === 'string' ? { paymentID: query.paymentID } : {}),
      ...(typeof query.status === 'string' ? { status: query.status } : {}),
    });
    res.redirect(302, url);
  }

  @Public()
  @Post('stripe/webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  stripeWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.payments.handleStripeWebhook(req.rawBody, signature);
  }
}
