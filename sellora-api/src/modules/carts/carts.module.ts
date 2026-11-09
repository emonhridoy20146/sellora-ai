import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthCoreModule } from '../auth/core/auth-core.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { SmsCoreModule } from '../sms/sms.module.js';
import { CartsController } from './carts.controller.js';
import { CartsListener } from './carts.listener.js';
import { CartsService } from './carts.service.js';
import { CartRepository, CartSettingsRepository } from './repositories.js';
import { cartSchema, cartSettingsSchema } from './schemas.js';

/**
 * Abandoned carts without HTTP routes (ADR 0018). The storefront services save and restore
 * carts through it, and the worker sends the reminders. It must not import the stores
 * module: the stores module imports this one.
 */
@Module({
  imports: [
    AuthCoreModule,
    BillingModule,
    CommerceCoreModule,
    OrgsModule,
    SmsCoreModule,
    MongooseModule.forFeature([
      { name: 'Cart', schema: cartSchema },
      { name: 'CartSettings', schema: cartSettingsSchema },
    ]),
  ],
  providers: [CartRepository, CartSettingsRepository, CartsService, CartsListener],
  // The repository is read by Reports (ADR 0026).
  exports: [CartsService, CartRepository],
})
export class CartsCoreModule {}

/** Marketing › Abandoned carts (the `marketing` feature module). */
@Module({
  imports: [CartsCoreModule, OrgsModule],
  controllers: [CartsController],
})
export class CartsModule {}
