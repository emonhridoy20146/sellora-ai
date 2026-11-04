import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthCoreModule } from '../auth/core/auth-core.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { CouriersCoreModule } from '../couriers/couriers.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersModule } from '../users/users.module.js';
import { OrderSmsListener } from './order-sms.listener.js';
import { SMS_ADAPTERS } from './providers/sms-providers.js';
import {
  SmsLinkRepository,
  SmsMessageRepository,
  SmsOptOutRepository,
  SmsSettingsRepository,
} from './repositories.js';
import {
  smsLinkSchema,
  smsMessageSchema,
  smsOptOutSchema,
  smsPlatformSchema,
  smsSettingsSchema,
} from './schemas.js';
import { SmsAdminService } from './sms-admin.service.js';
import { SmsPlatformService } from './sms-platform.service.js';
import { SmsSettingsService } from './sms-settings.service.js';
import { PlatformSmsController, PublicSmsController, SmsController } from './sms.controller.js';
import { SmsService } from './sms.service.js';
import { SMS_FETCH } from './sms.types.js';

/**
 * SMS without HTTP routes (ADR 0017): providers, sending and order messages. The worker
 * uses it to send queued messages and to text customers about courier updates.
 */
@Module({
  imports: [
    AuthCoreModule,
    BillingModule,
    CommerceCoreModule,
    CouriersCoreModule,
    OrgsModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: 'SmsSettings', schema: smsSettingsSchema },
      { name: 'SmsMessage', schema: smsMessageSchema },
      { name: 'SmsOptOut', schema: smsOptOutSchema },
      { name: 'SmsLink', schema: smsLinkSchema },
      { name: 'SmsPlatform', schema: smsPlatformSchema },
    ]),
  ],
  providers: [
    { provide: SMS_FETCH, useFactory: (): typeof fetch => globalThis.fetch.bind(globalThis) },
    ...SMS_ADAPTERS,
    SmsSettingsRepository,
    SmsMessageRepository,
    SmsOptOutRepository,
    SmsLinkRepository,
    SmsPlatformService,
    SmsService,
    SmsSettingsService,
    SmsAdminService,
    OrderSmsListener,
  ],
  exports: [SmsService, SmsSettingsService, SmsPlatformService, SmsAdminService],
})
export class SmsCoreModule {}

/** Settings › SMS, Admin › SMS, the opt-out page and delivery reports. */
@Module({
  imports: [SmsCoreModule, OrgsModule, AuthCoreModule],
  controllers: [SmsController, PlatformSmsController, PublicSmsController],
})
export class SmsModule {}
