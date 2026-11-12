import { DynamicModule, Module } from '@nestjs/common';
import { coreImports } from './app.module.js';
import type { Env } from './config/env.js';
import { AiCoreModule } from './modules/ai/ai.module.js';
import { AiRepliesListener } from './modules/ai/ai-replies.listener.js';
import { BackupsCoreModule } from './modules/backups/backups.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { CampaignsCoreModule } from './modules/campaigns/campaigns.module.js';
import { CartsCoreModule } from './modules/carts/carts.module.js';
import { CouriersCoreModule } from './modules/couriers/couriers.module.js';
import { FraudCoreModule } from './modules/fraud/fraud.module.js';
import { FilesCoreModule } from './modules/files/files.module.js';
import { LandingPagesCoreModule } from './modules/landing-pages/landing-pages.module.js';
import { MetaCoreModule } from './modules/meta/meta.module.js';
import { OrgsModule } from './modules/orgs/orgs.module.js';
import { ShopPaymentsCoreModule } from './modules/shop-payments/shop-payments.module.js';
import { AdTrackingCoreModule } from './modules/ad-tracking/ad-tracking.module.js';
import { SmsCoreModule } from './modules/sms/sms.module.js';
import { StoresCoreModule } from './modules/stores/stores.module.js';
import { TelegramCoreModule } from './modules/telegram/telegram.module.js';
import { CatalogSyncCoreModule } from './modules/catalog-sync/catalog-sync.module.js';
import { SeoCoreModule } from './modules/seo/seo.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AiProcessor } from './workers/ai.processor.js';
import { BackupsProcessor } from './workers/backups.processor.js';
import { CampaignsProcessor } from './workers/campaigns.processor.js';
import { CartsProcessor } from './workers/carts.processor.js';
import { CouriersProcessor } from './workers/couriers.processor.js';
import { MailProcessor } from './workers/mail.processor.js';
import { MaintenanceProcessor } from './workers/maintenance.processor.js';
import { MediaProcessor } from './workers/media.processor.js';
import { OutboxProcessor } from './workers/outbox.processor.js';
import { SmsProcessor } from './workers/sms.processor.js';
import { AdEventsProcessor } from './workers/ad-events.processor.js';
import { TelegramProcessor } from './workers/telegram.processor.js';
import { CatalogSyncProcessor } from './workers/catalog-sync.processor.js';
import { SeoProcessor } from './workers/seo.processor.js';
import { WebhooksProcessor } from './workers/webhooks.processor.js';

@Module({})
export class WorkerModule {
  static forRoot(env?: Env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ...coreImports(env),
        UsersModule,
        OrgsModule,
        BillingModule,
        FilesCoreModule,
        AiCoreModule,
        MetaCoreModule,
        CouriersCoreModule,
        FraudCoreModule,
        StoresCoreModule,
        ShopPaymentsCoreModule,
        AdTrackingCoreModule,
        SmsCoreModule,
        CartsCoreModule,
        CampaignsCoreModule,
        BackupsCoreModule,
        TelegramCoreModule,
        CatalogSyncCoreModule,
        LandingPagesCoreModule,
        SeoCoreModule,
      ],
      providers: [
        MailProcessor,
        MaintenanceProcessor,
        AiProcessor,
        OutboxProcessor,
        MediaProcessor,
        WebhooksProcessor,
        CouriersProcessor,
        SmsProcessor,
        AdEventsProcessor,
        CartsProcessor,
        CampaignsProcessor,
        BackupsProcessor,
        TelegramProcessor,
        CatalogSyncProcessor,
        SeoProcessor,
        // Messages that arrive by webhook are stored here, so AI replies are scheduled here too.
        AiRepliesListener,
      ],
    };
  }
}
