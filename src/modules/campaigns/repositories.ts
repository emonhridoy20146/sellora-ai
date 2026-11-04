import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type {
  AutomationSend,
  AutomationSettings,
  Campaign,
  CampaignRecipient,
  MarketingLink,
} from './schemas.js';

export type CampaignDoc = WithId<Campaign>;
export type CampaignRecipientDoc = WithId<CampaignRecipient>;
export type MarketingLinkDoc = WithId<MarketingLink>;
export type AutomationSettingsDoc = WithId<AutomationSettings>;
export type AutomationSendDoc = WithId<AutomationSend>;

@Injectable()
export class CampaignRepository extends TenantScopedRepository<Campaign> {
  constructor(@InjectModel('Campaign') model: Model<Campaign>) {
    super(model);
  }
}

@Injectable()
export class CampaignRecipientRepository extends TenantScopedRepository<CampaignRecipient> {
  constructor(@InjectModel('CampaignRecipient') model: Model<CampaignRecipient>) {
    super(model);
  }
}

@Injectable()
export class MarketingLinkRepository extends TenantScopedRepository<MarketingLink> {
  constructor(@InjectModel('MarketingLink') model: Model<MarketingLink>) {
    super(model);
  }
}

@Injectable()
export class AutomationSettingsRepository extends TenantScopedRepository<AutomationSettings> {
  constructor(@InjectModel('AutomationSettings') model: Model<AutomationSettings>) {
    super(model);
  }
}

@Injectable()
export class AutomationSendRepository extends TenantScopedRepository<AutomationSend> {
  constructor(@InjectModel('AutomationSend') model: Model<AutomationSend>) {
    super(model);
  }
}
