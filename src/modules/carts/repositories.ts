import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { Cart, CartSettings } from './schemas.js';

export type CartDoc = WithId<Cart>;
export type CartSettingsDoc = WithId<CartSettings>;

@Injectable()
export class CartRepository extends TenantScopedRepository<Cart> {
  constructor(@InjectModel('Cart') model: Model<Cart>) {
    super(model);
  }
}

@Injectable()
export class CartSettingsRepository extends TenantScopedRepository<CartSettings> {
  constructor(@InjectModel('CartSettings') model: Model<CartSettings>) {
    super(model);
  }
}
