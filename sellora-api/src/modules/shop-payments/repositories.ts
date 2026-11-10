import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { ShopPayment, ShopPaymentAccount, ShopPaymentSettings } from './schemas.js';

@Injectable()
export class ShopPaymentAccountRepository extends TenantScopedRepository<ShopPaymentAccount> {
  constructor(@InjectModel('ShopPaymentAccount') model: Model<ShopPaymentAccount>) {
    super(model);
  }
}

@Injectable()
export class ShopPaymentSettingsRepository extends TenantScopedRepository<ShopPaymentSettings> {
  constructor(@InjectModel('ShopPaymentSettings') model: Model<ShopPaymentSettings>) {
    super(model);
  }
}

@Injectable()
export class ShopPaymentRepository extends TenantScopedRepository<ShopPayment> {
  constructor(@InjectModel('ShopPayment') model: Model<ShopPayment>) {
    super(model);
  }
}
