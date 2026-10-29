import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthCoreModule } from '../auth/core/auth-core.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { CourierAccountsService } from './courier-accounts.service.js';
import { COURIER_FETCH } from './courier.types.js';
import { CourierWebhooksService } from './courier-webhooks.service.js';
import {
  CourierAccountsController,
  CourierWebhookController,
  ParcelsController,
} from './couriers.controller.js';
import { CouriersListener } from './couriers.listener.js';
import { ParcelsService } from './parcels.service.js';
import { COURIER_ADAPTERS, CourierProviders } from './providers/courier-providers.js';
import { CourierAccountRepository, ParcelRepository } from './repositories.js';
import { courierAccountSchema, parcelSchema } from './schemas.js';

/**
 * Courier accounts, booking and tracking without HTTP routes. The worker uses it for bulk
 * bookings and status checks; the feature module below adds the routes.
 */
@Module({
  imports: [
    CommerceCoreModule,
    AuthCoreModule,
    MongooseModule.forFeature([
      { name: 'CourierAccount', schema: courierAccountSchema },
      { name: 'Parcel', schema: parcelSchema },
    ]),
  ],
  providers: [
    { provide: COURIER_FETCH, useFactory: (): typeof fetch => globalThis.fetch.bind(globalThis) },
    ...COURIER_ADAPTERS,
    CourierAccountRepository,
    ParcelRepository,
    CourierAccountsService,
    ParcelsService,
    CouriersListener,
  ],
  exports: [CourierAccountsService, ParcelsService, CourierProviders],
})
export class CouriersCoreModule {}

/** Courier booking routes and the courier webhook (the `couriers` feature module). */
@Module({
  imports: [CouriersCoreModule],
  controllers: [CourierAccountsController, ParcelsController, CourierWebhookController],
  providers: [CourierWebhooksService],
})
export class CouriersModule {}
