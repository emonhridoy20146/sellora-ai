import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfig } from '../../config/app-config.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersModule } from '../users/users.module.js';
import { BillingJobsService } from './billing-jobs.service.js';
import {
  BillingController,
  PaymentCallbacksController,
  PublicBillingController,
} from './billing.controller.js';
import { aiModelSchema, aiUsageSchema, creditRateSchema } from './credit-schemas.js';
import { AiUsageRepository, CreditsService } from './credits.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { InvoiceRepository, InvoicesService } from './invoices.service.js';
import {
  gatewayConfigSchema,
  invoiceSchema,
  paymentSchema,
  withdrawalSchema,
} from './payment-schemas.js';
import { BkashGateway } from './payments/bkash.gateway.js';
import { GatewayConfigService } from './payments/gateway-config.service.js';
import { GATEWAY_FETCH } from './payments/gateway.types.js';
import { PaymentRepository, PaymentsService } from './payments/payments.service.js';
import { SslCommerzGateway } from './payments/sslcommerz.gateway.js';
import { StripeGateway } from './payments/stripe.gateway.js';
import { PlatformBillingController } from './platform-billing.controller.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlansService } from './plans.service.js';
import { ledgerEntrySchema, planSchema, subscriptionSchema, walletSchema } from './schemas.js';
import { SubscriptionRepository, SubscriptionsService } from './subscriptions.service.js';
import { LedgerRepository, WalletRepository, WalletService } from './wallet.service.js';
import { WithdrawalRepository, WithdrawalsService } from './withdrawals.service.js';

/** Inserts starter plans, AI models and the first credit price list when they are missing. */
@Injectable()
export class BillingSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingSeeder.name);

  constructor(
    private readonly config: AppConfig,
    private readonly plans: PlansService,
    private readonly credits: CreditsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('BILLING_SEED_DEFAULTS')) return;
    await this.plans.seedDefaults();
    await this.credits.seedDefaults();
    this.logger.log('Billing defaults present');
  }
}

@Module({
  imports: [
    OrgsModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: 'Plan', schema: planSchema },
      { name: 'Subscription', schema: subscriptionSchema },
      { name: 'Wallet', schema: walletSchema },
      { name: 'LedgerEntry', schema: ledgerEntrySchema },
      { name: 'CreditRate', schema: creditRateSchema },
      { name: 'AiModel', schema: aiModelSchema },
      { name: 'AiUsage', schema: aiUsageSchema },
      { name: 'Payment', schema: paymentSchema },
      { name: 'Withdrawal', schema: withdrawalSchema },
      { name: 'Invoice', schema: invoiceSchema },
      { name: 'GatewayConfig', schema: gatewayConfigSchema },
    ]),
  ],
  controllers: [
    BillingController,
    PublicBillingController,
    PaymentCallbacksController,
    PlatformBillingController,
  ],
  providers: [
    { provide: GATEWAY_FETCH, useValue: globalThis.fetch.bind(globalThis) },
    WalletRepository,
    LedgerRepository,
    AiUsageRepository,
    SubscriptionRepository,
    InvoiceRepository,
    PaymentRepository,
    WithdrawalRepository,
    WalletService,
    CreditsService,
    PlansService,
    EntitlementsService,
    InvoicesService,
    SubscriptionsService,
    GatewayConfigService,
    SslCommerzGateway,
    BkashGateway,
    StripeGateway,
    PaymentsService,
    WithdrawalsService,
    PlatformBillingService,
    BillingJobsService,
    BillingSeeder,
  ],
  exports: [
    BillingJobsService,
    EntitlementsService,
    CreditsService,
    WalletService,
    SubscriptionsService,
    PlansService,
    MongooseModule,
  ],
})
export class BillingModule {}
