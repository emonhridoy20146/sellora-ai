import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { Category, Customer, Order, Product, ShopSettings, StockMovement } from './schemas.js';

@Injectable()
export class CategoryRepository extends TenantScopedRepository<Category> {
  constructor(@InjectModel('Category') model: Model<Category>) {
    super(model);
  }
}

@Injectable()
export class ProductRepository extends TenantScopedRepository<Product> {
  constructor(@InjectModel('Product') model: Model<Product>) {
    super(model);
  }
}

@Injectable()
export class StockMovementRepository extends TenantScopedRepository<StockMovement> {
  constructor(@InjectModel('StockMovement') model: Model<StockMovement>) {
    super(model);
  }
}

@Injectable()
export class CustomerRepository extends TenantScopedRepository<Customer> {
  constructor(@InjectModel('Customer') model: Model<Customer>) {
    super(model);
  }
}

@Injectable()
export class OrderRepository extends TenantScopedRepository<Order> {
  constructor(@InjectModel('Order') model: Model<Order>) {
    super(model);
  }
}

@Injectable()
export class ShopSettingsRepository extends TenantScopedRepository<ShopSettings> {
  constructor(@InjectModel('ShopSettings') model: Model<ShopSettings>) {
    super(model);
  }
}
