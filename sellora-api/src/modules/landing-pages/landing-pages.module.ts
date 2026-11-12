import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { CartsCoreModule } from '../carts/carts.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { CouponsCoreModule } from '../coupons/coupons.module.js';
import { FilesCoreModule } from '../files/files.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { ShopPaymentsCoreModule } from '../shop-payments/shop-payments.module.js';
import { StorefrontKeyGuard } from '../stores/storefront-key.guard.js';
import { StoresCoreModule } from '../stores/stores.module.js';
import { AdTrackingCoreModule } from '../ad-tracking/ad-tracking.module.js';
import {
  LandingPagesController,
  LandingStorefrontController,
  PlatformLandingPagesController,
} from './landing-pages.controller.js';
import { LandingAbTestsService } from './landing-ab-tests.service.js';
import { LandingPagesService } from './landing-pages.service.js';
import { LandingTemplatesService } from './landing-templates.service.js';
import { LandingReviewService } from './landing-review.service.js';
import { LandingStorefrontService } from './landing-storefront.service.js';
import {
  LandingAbTestRepository,
  LandingPageRepository,
  LandingTemplateRepository,
  LandingPageStatRepository,
  LandingPageVersionRepository,
} from './repositories.js';
import {
  landingAbTestSchema,
  landingPageSchema,
  landingPageStatSchema,
  landingPageVersionSchema,
  landingTemplateSchema,
} from './schemas.js';

/**
 * Landing pages without HTTP routes: the builder, the review, the storefront side and the
 * A/B tests. The worker imports it for the minute sweep (scheduled versions, offer ends and
 * automatic A/B winners, ADR 0031).
 */
@Module({
  imports: [
    BillingModule,
    CartsCoreModule,
    CommerceCoreModule,
    CouponsCoreModule,
    FilesCoreModule,
    OrgsModule,
    ShopPaymentsCoreModule,
    AdTrackingCoreModule,
    StoresCoreModule,
    MongooseModule.forFeature([
      { name: 'LandingPage', schema: landingPageSchema },
      { name: 'LandingPageVersion', schema: landingPageVersionSchema },
      { name: 'LandingPageStat', schema: landingPageStatSchema },
      { name: 'LandingAbTest', schema: landingAbTestSchema },
      { name: 'LandingTemplate', schema: landingTemplateSchema },
    ]),
  ],
  providers: [
    LandingPageRepository,
    LandingPageVersionRepository,
    LandingPageStatRepository,
    LandingAbTestRepository,
    LandingTemplateRepository,
    LandingAbTestsService,
    LandingTemplatesService,
    LandingPagesService,
    LandingReviewService,
    LandingStorefrontService,
  ],
  exports: [
    LandingPagesService,
    LandingReviewService,
    LandingStorefrontService,
    LandingAbTestsService,
    LandingTemplatesService,
  ],
})
export class LandingPagesCoreModule {}

/**
 * Landing pages (the `landing_pages` feature module, ADR 0016): the merchant's page
 * builder, the super-admin's review, and the page and order form the storefront app shows.
 */
@Module({
  imports: [LandingPagesCoreModule, OrgsModule, StoresCoreModule],
  controllers: [
    LandingPagesController,
    PlatformLandingPagesController,
    LandingStorefrontController,
  ],
  providers: [StorefrontKeyGuard],
})
export class LandingPagesModule {}
