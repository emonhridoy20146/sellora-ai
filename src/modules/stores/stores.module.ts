import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { CouriersCoreModule } from '../couriers/couriers.module.js';
import { FilesCoreModule } from '../files/files.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersModule } from '../users/users.module.js';
import { DNS_LOOKUP, NodeDnsLookup } from './dns-lookup.js';
import { StoreDomainRepository, StoreRepository } from './repositories.js';
import { storeDomainSchema, storeSchema } from './schemas.js';
import { StoreDomainsService } from './store-domains.service.js';
import { StoreLinksService } from './store-links.service.js';
import { StoreNotifier } from './store-notifier.service.js';
import { StoreReviewService } from './store-review.service.js';
import { StorefrontKeyGuard } from './storefront-key.guard.js';
import { StorefrontService } from './storefront.service.js';
import {
  PlatformStoreDomainsController,
  PlatformStoresController,
  StoreDomainsController,
  StoreDomainsMerchantController,
  StorefrontController,
  StorePrimaryDomainController,
  StoresController,
} from './stores.controller.js';
import { StoresService } from './stores.service.js';

/**
 * Stores and their custom domains without HTTP routes. The worker uses it for the
 * scheduled domain checks; the feature module below adds the routes.
 */
@Module({
  imports: [
    BillingModule,
    CommerceCoreModule,
    CouriersCoreModule,
    FilesCoreModule,
    OrgsModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: 'Store', schema: storeSchema },
      { name: 'StoreDomain', schema: storeDomainSchema },
    ]),
  ],
  providers: [
    { provide: DNS_LOOKUP, useClass: NodeDnsLookup },
    StoreRepository,
    StoreDomainRepository,
    StoreLinksService,
    StoreNotifier,
    StoresService,
    StoreDomainsService,
    StoreReviewService,
    StorefrontService,
  ],
  exports: [
    StoreLinksService,
    StoresService,
    StoreDomainsService,
    StoreReviewService,
    StorefrontService,
  ],
})
export class StoresCoreModule {}

/**
 * Online stores (the `storefront` feature module): the merchant's store setup and custom
 * domains, the super-admin's review queues, and the shop routes the storefront app calls.
 */
@Module({
  imports: [StoresCoreModule],
  controllers: [
    StoresController,
    StoreDomainsMerchantController,
    StorePrimaryDomainController,
    PlatformStoresController,
    PlatformStoreDomainsController,
    StorefrontController,
    StoreDomainsController,
  ],
  providers: [StorefrontKeyGuard],
})
export class StoresModule {}
