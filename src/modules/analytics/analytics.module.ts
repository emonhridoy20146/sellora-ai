import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { CartsCoreModule } from '../carts/carts.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { FraudCoreModule } from '../fraud/fraud.module.js';
import { InboxCoreModule } from '../inbox/inbox.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

/** Reports: the value dashboard and first analytics (ADR 0026). Read-only. */
@Module({
  imports: [
    OrgsModule,
    BillingModule,
    InboxCoreModule,
    CommerceCoreModule,
    CartsCoreModule,
    FraudCoreModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
