import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { AdDestinationsService } from './ad-destinations.service.js';
import { AdEventsService } from './ad-events.service.js';
import { AdTrackingController } from './ad-tracking.controller.js';
import { AdTrackingListener } from './ad-tracking.listener.js';
import { AD_FETCH } from './ad-tracking.types.js';
import { AdPlatforms } from './platforms/ad-platforms.js';
import { Ga4AdPlatform } from './platforms/ga4.platform.js';
import { MetaAdPlatform } from './platforms/meta.platform.js';
import { TikTokAdPlatform } from './platforms/tiktok.platform.js';
import {
  AdDestinationRepository,
  AdEventLogRepository,
  AdOrderContextRepository,
  AdTrackingSettingsRepository,
} from './repositories.js';
import {
  adDestinationSchema,
  adEventLogSchema,
  adOrderContextSchema,
  adTrackingSettingsSchema,
} from './schemas.js';

/**
 * Ad tracking without HTTP routes (ADR 0030): the stores and landing pages use it at
 * checkout and for the browser tags, the worker sends the server events, and order events
 * queue purchases counted on delivery and refunds.
 */
@Module({
  imports: [
    CommerceCoreModule,
    OrgsModule,
    MongooseModule.forFeature([
      { name: 'AdDestination', schema: adDestinationSchema },
      { name: 'AdTrackingSettings', schema: adTrackingSettingsSchema },
      { name: 'AdOrderContext', schema: adOrderContextSchema },
      { name: 'AdEventLog', schema: adEventLogSchema },
    ]),
  ],
  providers: [
    { provide: AD_FETCH, useFactory: (): typeof fetch => globalThis.fetch.bind(globalThis) },
    AdDestinationRepository,
    AdTrackingSettingsRepository,
    AdOrderContextRepository,
    AdEventLogRepository,
    MetaAdPlatform,
    TikTokAdPlatform,
    Ga4AdPlatform,
    AdPlatforms,
    AdDestinationsService,
    AdEventsService,
    AdTrackingListener,
  ],
  exports: [AdDestinationsService, AdEventsService],
})
export class AdTrackingCoreModule {}

/** Settings › Ad tracking. */
@Module({
  imports: [AdTrackingCoreModule],
  controllers: [AdTrackingController],
})
export class AdTrackingModule {}
