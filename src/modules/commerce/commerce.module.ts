import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { FilesModule } from '../files/files.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import {
  CatalogController,
  CustomersController,
  OrdersController,
  ShopSettingsController,
} from './commerce.controller.js';
import { CustomersService } from './customers.service.js';
import { InventoryService } from './inventory.service.js';
import { OrdersService } from './orders.service.js';
import { ProductsService } from './products.service.js';
import {
  CategoryRepository,
  CustomerRepository,
  OrderRepository,
  ProductRepository,
  ShopSettingsRepository,
  StockMovementRepository,
} from './repositories.js';
import {
  categorySchema,
  customerSchema,
  orderSchema,
  productSchema,
  shopSettingsSchema,
  stockMovementSchema,
} from './schemas.js';
import { ShopSettingsService } from './shop-settings.service.js';

/** Products, stock, customers, manual orders and printing (the `commerce` feature module). */
@Module({
  imports: [
    OrgsModule,
    BillingModule,
    FilesModule,
    MongooseModule.forFeature([
      { name: 'Category', schema: categorySchema },
      { name: 'Product', schema: productSchema },
      { name: 'StockMovement', schema: stockMovementSchema },
      { name: 'Customer', schema: customerSchema },
      { name: 'Order', schema: orderSchema },
      { name: 'ShopSettings', schema: shopSettingsSchema },
    ]),
  ],
  controllers: [CatalogController, CustomersController, OrdersController, ShopSettingsController],
  providers: [
    CategoryRepository,
    ProductRepository,
    StockMovementRepository,
    CustomerRepository,
    OrderRepository,
    ShopSettingsRepository,
    ShopSettingsService,
    InventoryService,
    ProductsService,
    CustomersService,
    OrdersService,
  ],
  exports: [
    ProductsService,
    CustomersService,
    OrdersService,
    InventoryService,
    ShopSettingsService,
  ],
})
export class CommerceModule {}
