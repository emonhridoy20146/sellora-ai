import { DynamicModule, Module } from '@nestjs/common';
import { coreImports } from './app.module.js';
import type { Env } from './config/env.js';
import { AiCoreModule } from './modules/ai/ai.module.js';
import { AiRepliesListener } from './modules/ai/ai-replies.listener.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { CouriersCoreModule } from './modules/couriers/couriers.module.js';
import { FraudCoreModule } from './modules/fraud/fraud.module.js';
import { FilesCoreModule } from './modules/files/files.module.js';
import { MetaCoreModule } from './modules/meta/meta.module.js';
import { OrgsModule } from './modules/orgs/orgs.module.js';
import { StoresCoreModule } from './modules/stores/stores.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AiProcessor } from './workers/ai.processor.js';
import { CouriersProcessor } from './workers/couriers.processor.js';
import { MailProcessor } from './workers/mail.processor.js';
import { MaintenanceProcessor } from './workers/maintenance.processor.js';
import { MediaProcessor } from './workers/media.processor.js';
import { OutboxProcessor } from './workers/outbox.processor.js';
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
      ],
      providers: [
        MailProcessor,
        MaintenanceProcessor,
        AiProcessor,
        OutboxProcessor,
        MediaProcessor,
        WebhooksProcessor,
        CouriersProcessor,
        // Messages that arrive by webhook are stored here, so AI replies are scheduled here too.
        AiRepliesListener,
      ],
    };
  }
}
