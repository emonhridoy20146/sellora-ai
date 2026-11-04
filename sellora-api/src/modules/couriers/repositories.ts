import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { CourierAccount, Parcel } from './schemas.js';

@Injectable()
export class CourierAccountRepository extends TenantScopedRepository<CourierAccount> {
  constructor(@InjectModel('CourierAccount') model: Model<CourierAccount>) {
    super(model);
  }
}

@Injectable()
export class ParcelRepository extends TenantScopedRepository<Parcel> {
  constructor(@InjectModel('Parcel') model: Model<Parcel>) {
    super(model);
  }
}
