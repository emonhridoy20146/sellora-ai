import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { Coupon, CouponUse } from './schemas.js';

@Injectable()
export class CouponRepository extends TenantScopedRepository<Coupon> {
  constructor(@InjectModel('Coupon') model: Model<Coupon>) {
    super(model);
  }
}

@Injectable()
export class CouponUseRepository extends TenantScopedRepository<CouponUse> {
  constructor(@InjectModel('CouponUse') model: Model<CouponUse>) {
    super(model);
  }
}
