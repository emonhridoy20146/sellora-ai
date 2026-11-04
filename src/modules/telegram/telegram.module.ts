import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TELEGRAM_FETCH, TelegramClient } from '../../infra/telegram/telegram.client.js';
import { BillingModule } from '../billing/billing.module.js';
import { platformUserSchema } from '../platform/platform-user.schema.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AlertsService } from './alerts.service.js';
import { ReportsService } from './reports.service.js';
import { PlatformCountSchema, TelegramMessageSchema, TelegramSettingsSchema } from './schemas.js';
import { TelegramWatchService } from './telegram-watch.service.js';
import { PlatformTelegramController, TelegramWebhookController } from './telegram.controller.js';
import { TelegramListener } from './telegram.listener.js';
import { TelegramService } from './telegram.service.js';

/**
 * Owner reports and alerts on Telegram without HTTP routes (ADR 0022). In the API and the
 * worker, so alerts raised in either reach the owners; the worker sends and sweeps.
 */
@Module({
  imports: [
    BillingModule,
    MongooseModule.forFeature([
      { name: 'TelegramSettings', schema: TelegramSettingsSchema },
      { name: 'TelegramMessage', schema: TelegramMessageSchema },
      { name: 'PlatformCount', schema: PlatformCountSchema },
      // The same schema object as the platform module's, so Mongoose shares one model.
      { name: 'PlatformUser', schema: platformUserSchema },
    ]),
  ],
  providers: [
    { provide: TELEGRAM_FETCH, useValue: globalThis.fetch.bind(globalThis) },
    TelegramClient,
    TelegramService,
    AlertsService,
    ReportsService,
    TelegramWatchService,
    TelegramListener,
  ],
  exports: [TelegramService, AlertsService, ReportsService, TelegramWatchService],
})
export class TelegramCoreModule {}

/** Admin › Telegram and Telegram's webhook. */
@Module({
  imports: [TelegramCoreModule, PlatformModule],
  controllers: [PlatformTelegramController, TelegramWebhookController],
})
export class TelegramModule {}
