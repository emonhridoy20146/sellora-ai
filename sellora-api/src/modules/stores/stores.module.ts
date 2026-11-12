import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { CartsCoreModule } from '../carts/carts.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { CouponsCoreModule } from '../coupons/coupons.module.js';
import { CouriersCoreModule } from '../couriers/couriers.module.js';
import { FilesCoreModule } from '../files/files.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { ShopPaymentsCoreModule } from '../shop-payments/shop-payments.module.js';
import { UsersModule } from '../users/users.module.js';
import { DNS_LOOKUP, NodeDnsLookup } from './dns-lookup.js';
import {
  StoreDomainRepository,
  StoreProductStatRepository,
  StoreRepository,
  StoreStatRepository,
} from './repositories.js';
import {
  storeDomainSchema,
  storeProductStatSchema,
  storeSchema,
  storeStatSchema,
} from './schemas.js';
import { StoreChangesService } from './store-changes.service.js';
import { StoreDomainsService } from './store-domains.service.js';
import { StoreLinksService } from './store-links.service.js';
import { StoreNotifier } from './store-notifier.service.js';
import { StoreReviewService } from './store-review.service.js';
import { StoreStatsService } from './store-stats.service.js';
import { StorefrontKeyGuard } from './storefront-key.guard.js';
import { AdTrackingCoreModule } from '../ad-tracking/ad-tracking.module.js';
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
    CartsCoreModule,
    CommerceCoreModule,
    CouponsCoreModule,
    CouriersCoreModule,
    FilesCoreModule,
    OrgsModule,
    ShopPaymentsCoreModule,
    AdTrackingCoreModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: 'Store', schema: storeSchema },
      { name: 'StoreDomain', schema: storeDomainSchema },
      { name: 'StoreStat', schema: storeStatSchema },
      { name: 'StoreProductStat', schema: storeProductStatSchema },
    ]),
  ],
  providers: [
    { provide: DNS_LOOKUP, useClass: NodeDnsLookup },
    StoreRepository,
    StoreDomainRepository,
    StoreStatRepository,
    StoreProductStatRepository,
    StoreLinksService,
    StoreNotifier,
    StoreChangesService,
    StoresService,
    StoreDomainsService,
    StoreReviewService,
    StoreStatsService,
    StorefrontService,
  ],
  exports: [
    StoreRepository,
    StoreLinksService,
    StoreNotifier,
    StoresService,
    StoreDomainsService,
    StoreReviewService,
    StoreStatsService,
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
