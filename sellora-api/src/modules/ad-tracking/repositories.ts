import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { AdDestination, AdEventLog, AdOrderContext, AdTrackingSettings } from './schemas.js';

@Injectable()
export class AdDestinationRepository extends TenantScopedRepository<AdDestination> {
  constructor(@InjectModel('AdDestination') model: Model<AdDestination>) {
    super(model);
  }
}

@Injectable()
export class AdTrackingSettingsRepository extends TenantScopedRepository<AdTrackingSettings> {
  constructor(@InjectModel('AdTrackingSettings') model: Model<AdTrackingSettings>) {
    super(model);
  }
}

@Injectable()
export class AdOrderContextRepository extends TenantScopedRepository<AdOrderContext> {
  constructor(@InjectModel('AdOrderContext') model: Model<AdOrderContext>) {
    super(model);
  }
}

@Injectable()
export class AdEventLogRepository extends TenantScopedRepository<AdEventLog> {
  constructor(@InjectModel('AdEventLog') model: Model<AdEventLog>) {
    super(model);
  }
}
