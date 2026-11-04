import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthCoreModule } from '../auth/core/auth-core.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { landingPageSchema } from '../landing-pages/schemas.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { SmsCoreModule } from '../sms/sms.module.js';
import { StorefrontKeyGuard } from '../stores/storefront-key.guard.js';
import { StoresCoreModule } from '../stores/stores.module.js';
import { UsersModule } from '../users/users.module.js';
import { AutomationsService } from './automations.service.js';
import {
  AutomationsController,
  CampaignsController,
  StorefrontLinksController,
} from './campaigns.controller.js';
import { CampaignsListener } from './campaigns.listener.js';
import { CampaignsService } from './campaigns.service.js';
import { MarketingLinksService } from './links.service.js';
import {
  AutomationSendRepository,
  AutomationSettingsRepository,
  CampaignRecipientRepository,
  CampaignRepository,
  MarketingLinkRepository,
} from './repositories.js';
import {
  automationSendSchema,
  automationSettingsSchema,
  campaignRecipientSchema,
  campaignSchema,
  marketingLinkSchema,
} from './schemas.js';

/**
 * SMS campaigns, automations and their short links without HTTP routes (ADR 0019). The worker
 * uses it for the sending sweep; the feature module below adds the routes.
 */
@Module({
  imports: [
    AuthCoreModule,
    BillingModule,
    CommerceCoreModule,
    OrgsModule,
    SmsCoreModule,
    StoresCoreModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: 'Campaign', schema: campaignSchema },
      { name: 'CampaignRecipient', schema: campaignRecipientSchema },
      { name: 'MarketingLink', schema: marketingLinkSchema },
      { name: 'AutomationSettings', schema: automationSettingsSchema },
      { name: 'AutomationSend', schema: automationSendSchema },
      // Read to offer and check live pages as link targets (owned by the landing pages module).
      { name: 'LandingPage', schema: landingPageSchema },
    ]),
  ],
  providers: [
    CampaignRepository,
    CampaignRecipientRepository,
    MarketingLinkRepository,
    AutomationSettingsRepository,
    AutomationSendRepository,
    MarketingLinksService,
    CampaignsService,
    AutomationsService,
    CampaignsListener,
  ],
  exports: [CampaignsService, AutomationsService, MarketingLinksService],
})
export class CampaignsCoreModule {}

/** Marketing › Campaigns and Automations (the `marketing` feature module). */
@Module({
  imports: [CampaignsCoreModule, StoresCoreModule],
  controllers: [CampaignsController, AutomationsController, StorefrontLinksController],
  providers: [StorefrontKeyGuard],
})
export class CampaignsModule {}
