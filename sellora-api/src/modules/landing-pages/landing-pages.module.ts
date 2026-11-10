import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { CartsCoreModule } from '../carts/carts.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { FilesCoreModule } from '../files/files.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { ShopPaymentsCoreModule } from '../shop-payments/shop-payments.module.js';
import { StorefrontKeyGuard } from '../stores/storefront-key.guard.js';
import { StoresCoreModule } from '../stores/stores.module.js';
import {
  LandingPagesController,
  LandingStorefrontController,
  PlatformLandingPagesController,
} from './landing-pages.controller.js';
import { LandingPagesService } from './landing-pages.service.js';
import { LandingReviewService } from './landing-review.service.js';
import { LandingStorefrontService } from './landing-storefront.service.js';
import {
  LandingPageRepository,
  LandingPageStatRepository,
  LandingPageVersionRepository,
} from './repositories.js';
import { landingPageSchema, landingPageStatSchema, landingPageVersionSchema } from './schemas.js';

/**
 * Landing pages (the `landing_pages` feature module, ADR 0016): the merchant's page
 * builder, the super-admin's review, and the page and order form the storefront app shows.
 */
@Module({
  imports: [
    BillingModule,
    CartsCoreModule,
    CommerceCoreModule,
    FilesCoreModule,
    OrgsModule,
    ShopPaymentsCoreModule,
    StoresCoreModule,
    MongooseModule.forFeature([
      { name: 'LandingPage', schema: landingPageSchema },
      { name: 'LandingPageVersion', schema: landingPageVersionSchema },
      { name: 'LandingPageStat', schema: landingPageStatSchema },
    ]),
  ],
  controllers: [
    LandingPagesController,
    PlatformLandingPagesController,
    LandingStorefrontController,
  ],
  providers: [
    LandingPageRepository,
    LandingPageVersionRepository,
    LandingPageStatRepository,
    LandingPagesService,
    LandingReviewService,
    LandingStorefrontService,
    StorefrontKeyGuard,
  ],
})
export class LandingPagesModule {}
