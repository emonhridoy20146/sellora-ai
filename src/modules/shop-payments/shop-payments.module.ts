import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { AamarPayGateway } from './gateways/aamarpay.gateway.js';
import { NagadGateway } from './gateways/nagad.gateway.js';
import { ShopGateways } from './gateways/shop-gateways.js';
import { ShurjoPayGateway } from './gateways/shurjopay.gateway.js';
import {
  ShopPaymentAccountRepository,
  ShopPaymentRepository,
  ShopPaymentSettingsRepository,
} from './repositories.js';
import {
  shopPaymentAccountSchema,
  shopPaymentSchema,
  shopPaymentSettingsSchema,
} from './schemas.js';
import { ShopPaymentAccountsService } from './shop-payment-accounts.service.js';
import {
  OrderOnlinePaymentsController,
  ShopPaymentReturnsController,
  ShopPaymentSettingsController,
} from './shop-payments.controller.js';
import { ShopPaymentsService } from './shop-payments.service.js';

/**
 * Shoppers paying businesses at checkout (ADR 0029), without HTTP routes: the store and
 * landing page checkouts use it, and the worker checks payments whose shopper never came back.
 */
@Module({
  imports: [
    BillingModule,
    CommerceCoreModule,
    MongooseModule.forFeature([
      { name: 'ShopPaymentAccount', schema: shopPaymentAccountSchema },
      { name: 'ShopPaymentSettings', schema: shopPaymentSettingsSchema },
      { name: 'ShopPayment', schema: shopPaymentSchema },
    ]),
  ],
  providers: [
    ShopPaymentAccountRepository,
    ShopPaymentSettingsRepository,
    ShopPaymentRepository,
    NagadGateway,
    AamarPayGateway,
    ShurjoPayGateway,
    ShopGateways,
    ShopPaymentAccountsService,
    ShopPaymentsService,
  ],
  exports: [ShopPaymentAccountsService, ShopPaymentsService],
})
export class ShopPaymentsCoreModule {}

/** Settings › Payments, the order's attempts, and the gateways' return addresses. */
@Module({
  imports: [ShopPaymentsCoreModule, CommerceCoreModule],
  controllers: [
    ShopPaymentSettingsController,
    OrderOnlinePaymentsController,
    ShopPaymentReturnsController,
  ],
})
export class ShopPaymentsModule {}
