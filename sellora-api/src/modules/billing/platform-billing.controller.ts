import { Controller, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { PlatformApi, RequirePlatformPermissions } from '../auth/decorators.js';
import * as dto from './billing.dto.js';
import { CreditsService, toAiModelDto, toPlatformRateDto } from './credits.service.js';
import type { AiModel } from './credit-schemas.js';
import { FEATURE_MODULES, LIMIT_KEYS, UNLIMITED } from './feature-modules.js';
import { GatewayConfigService } from './payments/gateway-config.service.js';
import { PaymentsService, toPlatformPaymentDto } from './payments/payments.service.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlansService, toPlatformPlanDto } from './plans.service.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { WithdrawalsService, toWithdrawalDto } from './withdrawals.service.js';

const toMicros = (usd: number) => Math.round(usd * 1_000_000);

function modelInput(body: Partial<z.infer<typeof dto.aiModelBody>>): Partial<AiModel> {
  const out: Partial<AiModel> & Record<string, unknown> = {};
  if (body.provider !== undefined) out.provider = body.provider;
  if (body.model !== undefined) out.model = body.model;
  if (body.label !== undefined) out.label = body.label;
  if (body.tier !== undefined) out.tier = body.tier;
  if (body.inputUsdPerMTok !== undefined)
    out.inputUsdMicrosPerMTok = toMicros(body.inputUsdPerMTok);
  if (body.outputUsdPerMTok !== undefined)
    out.outputUsdMicrosPerMTok = toMicros(body.outputUsdPerMTok);
  if (body.cachedInputUsdPerMTok !== undefined)
    out.cachedInputUsdMicrosPerMTok = toMicros(body.cachedInputUsdPerMTok);
  if (body.cacheWriteUsdPerMTok !== undefined)
    out.cacheWriteUsdMicrosPerMTok =
      body.cacheWriteUsdPerMTok === null ? undefined : toMicros(body.cacheWriteUsdPerMTok);
  if (body.longContext !== undefined) {
    out.longContext = body.longContext
      ? {
          thresholdTokens: body.longContext.thresholdTokens,
          inputUsdMicrosPerMTok: toMicros(body.longContext.inputUsdPerMTok),
          outputUsdMicrosPerMTok: toMicros(body.longContext.outputUsdPerMTok),
        }
      : undefined;
  }
  if (body.contextWindow !== undefined) out.contextWindow = body.contextWindow;
  if (body.imageInput !== undefined) out.imageInput = body.imageInput;
  if (body.enabled !== undefined) out.enabled = body.enabled;
  if (body.isDefaultForTier !== undefined) out.isDefaultForTier = body.isDefaultForTier;
  return out;
}

/**
 * Super-admin billing: plans and prices, the AI credit price list, the model catalogue
 * with real provider prices, gateways, payment and withdrawal review, per-business wallet
 * and plan controls, and revenue vs AI cost (profit) analytics.
 */
@PlatformApi('billing')
@Controller({ path: 'platform/billing', version: '1' })
export class PlatformBillingController {
  constructor(
    private readonly billing: PlatformBillingService,
    private readonly plans: PlansService,
    private readonly credits: CreditsService,
    private readonly gateways: GatewayConfigService,
    private readonly payments: PaymentsService,
    private readonly withdrawals: WithdrawalsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  private actorId() {
    return RequestContext.actor().id;
  }

  // ---------------------------------------------------------------- analytics

  @Get('overview')
  @RequirePlatformPermissions('platform.billing.view')
  @ApiOperation({
    summary: 'MRR, wallets, payments and AI profit for a period (default: last 30 days)',
  })
  overview(@ZodQuery(dto.rangeQuery) q: z.infer<typeof dto.rangeQuery>) {
    const { from, to } = dto.resolveRange(q);
    return this.billing.overview(from, to);
  }

  @Get('ai-profit')
  @RequirePlatformPermissions('platform.billing.view')
  @ApiOperation({
    summary:
      'AI credits billed vs real provider cost, grouped by day, business, model, feature or tier',
  })
  profit(@ZodQuery(dto.profitQuery) q: z.infer<typeof dto.profitQuery>) {
    const { from, to } = dto.resolveRange(q);
    return this.billing.profit(from, to, q.groupBy, q.orgId);
  }

  @Get('ai-usage')
  @RequirePlatformPermissions('platform.billing.view')
  usage(@ZodQuery(dto.platformUsageQuery) q: z.infer<typeof dto.platformUsageQuery>) {
    return this.billing.usageForPlatform(q);
  }

  // ---------------------------------------------------------------- plans

  @Get('modules')
  @RequirePlatformPermissions('platform.billing.view')
  @ApiOperation({ summary: 'The sellable modules and plan limit keys, for the plan editor' })
  modules() {
    return {
      modules: Object.entries(FEATURE_MODULES).map(([key, m]) => ({ key, ...m })),
      limits: LIMIT_KEYS,
    };
  }

  @Get('plans')
  @RequirePlatformPermissions('platform.billing.view')
  async plansList() {
    return (await this.plans.listAll()).map(toPlatformPlanDto);
  }

  @Post('plans')
  @RequirePlatformPermissions('platform.plans.manage')
  async createPlan(@ZodBody(dto.createPlanBody) body: z.infer<typeof dto.createPlanBody>) {
    return toPlatformPlanDto(
      await this.plans.create(
        { ...body, limits: { ...UNLIMITED, ...body.limits } },
        this.actorId(),
      ),
    );
  }

  @Patch('plans/:code')
  @RequirePlatformPermissions('platform.plans.manage')
  async updatePlan(
    @ZodParam('code', z.string().min(1).max(40)) code: string,
    @ZodBody(dto.updatePlanBody) body: z.infer<typeof dto.updatePlanBody>,
  ) {
    return toPlatformPlanDto(await this.plans.update(code, body as never, this.actorId()));
  }

  // ---------------------------------------------------------------- credits and models

  @Get('credit-rates')
  @RequirePlatformPermissions('platform.billing.view')
  async rates() {
    return (await this.credits.rateHistory()).map(toPlatformRateDto);
  }

  @Post('credit-rates')
  @RequirePlatformPermissions('platform.billing.manage')
  @ApiOperation({
    summary: 'Publish a new AI credit price list version (takes effect at effectiveFrom)',
  })
  async publishRate(@ZodBody(dto.publishRateBody) body: z.infer<typeof dto.publishRateBody>) {
    const { usdRate, ...rest } = body;
    return toPlatformRateDto(
      await this.credits.publishRate(
        { ...rest, usdRateScaled: Math.round(usdRate * 10_000) },
        this.actorId(),
      ),
    );
  }

  @Get('ai-models')
  @RequirePlatformPermissions('platform.billing.view')
  async models() {
    return (await this.credits.listModels()).map(toAiModelDto);
  }

  @Post('ai-models')
  @RequirePlatformPermissions('platform.billing.manage')
  async createModel(@ZodBody(dto.aiModelBody) body: z.infer<typeof dto.aiModelBody>) {
    return toAiModelDto(await this.credits.createModel(modelInput(body) as AiModel));
  }

  @Patch('ai-models/:id')
  @RequirePlatformPermissions('platform.billing.manage')
  async updateModel(
    @ZodParam('id', objectIdSchema) id: string,
    @ZodBody(dto.updateAiModelBody) body: z.infer<typeof dto.updateAiModelBody>,
  ) {
    return toAiModelDto(await this.credits.updateModel(id, modelInput(body)));
  }

  // ---------------------------------------------------------------- gateways

  @Get('gateways')
  @RequirePlatformPermissions('platform.billing.view')
  gatewaysList() {
    return this.gateways.list();
  }

  @Put('gateways/:gateway')
  @RequirePlatformPermissions('platform.billing.manage')
  @ApiOperation({
    summary: 'Enable a gateway and set its credentials (stored encrypted, never returned)',
  })
  setGateway(
    @ZodParam('gateway', dto.gatewayParam) gateway: z.infer<typeof dto.gatewayParam>,
    @ZodBody(dto.gatewayBody) body: z.infer<typeof dto.gatewayBody>,
  ) {
    return this.gateways.set(gateway, body, this.actorId());
  }

  // ---------------------------------------------------------------- payments and withdrawals

  @Get('payments')
  @RequirePlatformPermissions('platform.billing.view')
  paymentsList(@ZodQuery(dto.platformPaymentsQuery) q: z.infer<typeof dto.platformPaymentsQuery>) {
    return this.payments.listForPlatform(q);
  }

  @Post('payments/:paymentId/approve')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.billing.manage')
  @ApiOperation({ summary: 'Confirm a manual transfer was received; credits the wallet' })
  async approvePayment(
    @ZodParam('paymentId', objectIdSchema) id: string,
    @ZodBody(dto.reviewBody) body: z.infer<typeof dto.reviewBody>,
  ) {
    return toPlatformPaymentDto(
      await this.payments.reviewManual(id, 'approve', body.note, this.actorId()),
    );
  }

  @Post('payments/:paymentId/reject')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.billing.manage')
  async rejectPayment(
    @ZodParam('paymentId', objectIdSchema) id: string,
    @ZodBody(dto.reviewBody) body: z.infer<typeof dto.reviewBody>,
  ) {
    return toPlatformPaymentDto(
      await this.payments.reviewManual(id, 'reject', body.note, this.actorId()),
    );
  }

  @Get('withdrawals')
  @RequirePlatformPermissions('platform.billing.view')
  withdrawalsList(
    @ZodQuery(dto.platformWithdrawalsQuery) q: z.infer<typeof dto.platformWithdrawalsQuery>,
  ) {
    return this.withdrawals.listForPlatform(q);
  }

  @Post('withdrawals/:withdrawalId/approve')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.billing.manage')
  async approveWithdrawal(
    @ZodParam('withdrawalId', objectIdSchema) id: string,
    @ZodBody(dto.reviewBody) body: z.infer<typeof dto.reviewBody>,
  ) {
    return toWithdrawalDto(await this.withdrawals.review(id, 'approve', body, this.actorId()));
  }

  @Post('withdrawals/:withdrawalId/reject')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.billing.manage')
  async rejectWithdrawal(
    @ZodParam('withdrawalId', objectIdSchema) id: string,
    @ZodBody(dto.reviewBody) body: z.infer<typeof dto.reviewBody>,
  ) {
    return toWithdrawalDto(await this.withdrawals.review(id, 'reject', body, this.actorId()));
  }

  @Post('withdrawals/:withdrawalId/paid')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.billing.manage')
  @ApiOperation({ summary: 'Record that the money was sent; takes it out of the wallet' })
  async paidWithdrawal(
    @ZodParam('withdrawalId', objectIdSchema) id: string,
    @ZodBody(dto.withdrawalPaidBody) body: z.infer<typeof dto.withdrawalPaidBody>,
  ) {
    return toWithdrawalDto(await this.withdrawals.review(id, 'paid', body, this.actorId()));
  }

  // ---------------------------------------------------------------- one business

  @Get('tenants/:orgId')
  @RequirePlatformPermissions('platform.billing.view')
  tenant(@ZodParam('orgId', objectIdSchema) orgId: string) {
    return this.billing.tenantBilling(orgId);
  }

  @Post('tenants/:orgId/wallet/adjust')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.billing.manage')
  @ApiOperation({
    summary:
      'Credit or debit a wallet (bank transfer, goodwill credit, correction). Idempotent by key.',
  })
  adjust(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.walletAdjustBody) body: z.infer<typeof dto.walletAdjustBody>,
  ) {
    return this.billing.adjustWallet(orgId, body, this.actorId());
  }

  @Patch('tenants/:orgId/wallet/status')
  @RequirePlatformPermissions('platform.billing.manage')
  walletStatus(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.walletStatusBody) body: z.infer<typeof dto.walletStatusBody>,
  ) {
    return this.billing.setWalletStatus(orgId, body.status, body.note);
  }

  @Put('tenants/:orgId/subscription')
  @RequirePlatformPermissions('platform.billing.manage')
  @ApiOperation({ summary: 'Give a business a plan without payment until periodEnd' })
  async assign(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.assignPlanBody) body: z.infer<typeof dto.assignPlanBody>,
  ) {
    await this.billing.inTenant(orgId, () => this.subscriptions.assignPlan(body));
    return this.billing.tenantBilling(orgId);
  }

  @Post('tenants/:orgId/subscription/extend-trial')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.tenants.manage')
  async extendTrial(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.extendTrialBody) body: z.infer<typeof dto.extendTrialBody>,
  ) {
    await this.billing.inTenant(orgId, () => this.subscriptions.extendTrial(body.days, body.note));
    return this.billing.tenantBilling(orgId);
  }

  @Put('tenants/:orgId/subscription/overrides')
  @RequirePlatformPermissions('platform.billing.manage')
  @ApiOperation({ summary: 'Add or remove modules and override limits for one business' })
  async overrides(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.overridesBody) body: z.infer<typeof dto.overridesBody>,
  ) {
    await this.billing.inTenant(orgId, () => this.subscriptions.setOverrides(body));
    return this.billing.tenantBilling(orgId);
  }
}
