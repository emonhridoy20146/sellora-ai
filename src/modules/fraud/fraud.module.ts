import { Injectable, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { PARCEL_OUTCOME, type ParcelOutcomeEvent } from '../couriers/parcels.service.js';
import { PlatformSettingsModule } from '../platform/platform-settings.module.js';
import { FraudController } from './fraud.controller.js';
import { FraudService, FraudSettingsRepository } from './fraud.service.js';
import { deliveryOutcomeSchema, fraudSettingsSchema } from './schemas.js';

/** Couriers report a parcel's end; businesses that share add it to the network. */
@Injectable()
export class FraudListener {
  constructor(private readonly fraud: FraudService) {}

  @OnEvent(PARCEL_OUTCOME, { async: true, promisify: true, suppressErrors: true })
  async onParcelOutcome(e: ParcelOutcomeEvent): Promise<void> {
    await this.fraud.recordOutcome(e);
  }
}

/** The fraud check without routes (the worker records outcomes from courier tracking). */
@Module({
  imports: [
    CommerceCoreModule,
    PlatformSettingsModule,
    MongooseModule.forFeature([
      { name: 'FraudSettings', schema: fraudSettingsSchema },
      { name: 'DeliveryOutcome', schema: deliveryOutcomeSchema },
    ]),
  ],
  providers: [FraudSettingsRepository, FraudService, FraudListener],
  exports: [FraudService],
})
export class FraudCoreModule {}

/** The fraud check routes (the `fraud` feature module). */
@Module({ imports: [FraudCoreModule], controllers: [FraudController] })
export class FraudModule {}
