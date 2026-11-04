import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { SmsLink, SmsMessage, SmsOptOut, SmsSettings } from './schemas.js';

export type SmsSettingsDoc = WithId<SmsSettings>;
export type SmsMessageDoc = WithId<SmsMessage>;

@Injectable()
export class SmsSettingsRepository extends TenantScopedRepository<SmsSettings> {
  constructor(@InjectModel('SmsSettings') model: Model<SmsSettings>) {
    super(model);
  }
}

@Injectable()
export class SmsMessageRepository extends TenantScopedRepository<SmsMessage> {
  constructor(@InjectModel('SmsMessage') model: Model<SmsMessage>) {
    super(model);
  }
}

@Injectable()
export class SmsOptOutRepository extends TenantScopedRepository<SmsOptOut> {
  constructor(@InjectModel('SmsOptOut') model: Model<SmsOptOut>) {
    super(model);
  }
}

@Injectable()
export class SmsLinkRepository extends TenantScopedRepository<SmsLink> {
  constructor(@InjectModel('SmsLink') model: Model<SmsLink>) {
    super(model);
  }
}
