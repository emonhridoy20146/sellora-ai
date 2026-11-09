import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { Store, StoreDomain, StoreProductStat, StoreStat } from './schemas.js';

@Injectable()
export class StoreRepository extends TenantScopedRepository<Store> {
  constructor(@InjectModel('Store') model: Model<Store>) {
    super(model);
  }
}

@Injectable()
export class StoreDomainRepository extends TenantScopedRepository<StoreDomain> {
  constructor(@InjectModel('StoreDomain') model: Model<StoreDomain>) {
    super(model);
  }
}

@Injectable()
export class StoreStatRepository extends TenantScopedRepository<StoreStat> {
  constructor(@InjectModel('StoreStat') model: Model<StoreStat>) {
    super(model);
  }
}

@Injectable()
export class StoreProductStatRepository extends TenantScopedRepository<StoreProductStat> {
  constructor(@InjectModel('StoreProductStat') model: Model<StoreProductStat>) {
    super(model);
  }
}
