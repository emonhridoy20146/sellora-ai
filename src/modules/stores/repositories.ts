import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { Store } from './schemas.js';

@Injectable()
export class StoreRepository extends TenantScopedRepository<Store> {
  constructor(@InjectModel('Store') model: Model<Store>) {
    super(model);
  }
}
