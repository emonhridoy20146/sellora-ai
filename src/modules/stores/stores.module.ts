import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { CouriersCoreModule } from '../couriers/couriers.module.js';
import { FilesCoreModule } from '../files/files.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersModule } from '../users/users.module.js';
import { StoreRepository } from './repositories.js';
import { storeSchema } from './schemas.js';
import { StoreLinksService } from './store-links.service.js';
import { StoreReviewService } from './store-review.service.js';
import { StorefrontKeyGuard } from './storefront-key.guard.js';
import { StorefrontService } from './storefront.service.js';
import {
  PlatformStoresController,
  StoreDomainsController,
  StorefrontController,
  StoresController,
} from './stores.controller.js';
import { StoresService } from './stores.service.js';

/**
 * Online stores (the `storefront` feature module): the merchant's store setup, the
 * super-admin's review queue, and the shop routes the storefront app calls.
 */
@Module({
  imports: [
    BillingModule,
    CommerceCoreModule,
    CouriersCoreModule,
    FilesCoreModule,
    OrgsModule,
    UsersModule,
    MongooseModule.forFeature([{ name: 'Store', schema: storeSchema }]),
  ],
  controllers: [
    StoresController,
    PlatformStoresController,
    StorefrontController,
    StoreDomainsController,
  ],
  providers: [
    StoreRepository,
    StoreLinksService,
    StoresService,
    StoreReviewService,
    StorefrontService,
    StorefrontKeyGuard,
  ],
})
export class StoresModule {}
