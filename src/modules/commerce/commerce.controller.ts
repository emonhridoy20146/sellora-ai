import { Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  RequireAnyPermission,
  RequireModule,
  RequirePermissions,
} from '../auth/decorators.js';
import { OrgsService } from '../orgs/orgs.service.js';
import * as dto from './commerce.dto.js';
import { CustomersService, toCustomerDto } from './customers.service.js';
import { InventoryService, toStockMovementDto } from './inventory.service.js';
import { OrdersService, toOrderDto } from './orders.service.js';
import { ProductsService, toCategoryDto, toProductDto } from './products.service.js';
import { ShopSettingsService, toShopSettingsDto } from './shop-settings.service.js';

@ApiTags('catalog')
@OrgScoped()
@RequireModule('commerce')
@Controller({ path: 'orgs/:orgId', version: '1' })
export class CatalogController {
  constructor(
    private readonly products: ProductsService,
    private readonly inventory: InventoryService,
    private readonly settings: ShopSettingsService,
  ) {}

  private async threshold() {
    return (await this.settings.get()).lowStockThreshold;
  }

  @Get('products')
  @RequirePermissions('catalog.view')
  @ApiOperation({ summary: 'Products, newest change first. Archived ones only when asked for.' })
  async list(@ZodQuery(dto.productListQuery) q: z.infer<typeof dto.productListQuery>) {
    const lowStockThreshold = await this.threshold();
    const page = await this.products.list({ ...q, lowStockThreshold });
    return {
      items: page.items.map((p) => toProductDto(p, lowStockThreshold)),
      nextCursor: page.nextCursor,
    };
  }

  @Post('products')
  @RequirePermissions('catalog.manage')
  async create(@ZodBody(dto.createProductBody) body: z.infer<typeof dto.createProductBody>) {
    return toProductDto(await this.products.create(body), await this.threshold());
  }

  @Get('products/:productId')
  @RequirePermissions('catalog.view')
  async get(@ZodParam('productId', objectIdSchema) id: string) {
    return toProductDto(await this.products.get(id), await this.threshold());
  }

  @Patch('products/:productId')
  @RequirePermissions('catalog.manage')
  @ApiOperation({
    summary: 'Edit a product. Stock of existing variants is not changed here; use stock adjust.',
  })
  async update(
    @ZodParam('productId', objectIdSchema) id: string,
    @ZodBody(dto.updateProductBody) body: z.infer<typeof dto.updateProductBody>,
  ) {
    return toProductDto(await this.products.update(id, body), await this.threshold());
  }

  @Delete('products/:productId')
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'Delete a product, or archive it when orders refer to it' })
  remove(@ZodParam('productId', objectIdSchema) id: string) {
    return this.products.remove(id);
  }

  @Post('products/:productId/stock')
  @HttpCode(200)
  @RequirePermissions('inventory.manage')
  @ApiOperation({ summary: 'Set or change the stock of one variant (recorded in stock history)' })
  async adjust(
    @ZodParam('productId', objectIdSchema) productId: string,
    @ZodBody(dto.stockAdjustBody) body: z.infer<typeof dto.stockAdjustBody>,
  ) {
    await this.inventory.adjust({ productId, ...body });
    return toProductDto(await this.products.get(productId), await this.threshold());
  }

  @Get('stock-movements')
  @RequirePermissions('catalog.view')
  async history(@ZodQuery(dto.stockHistoryQuery) q: z.infer<typeof dto.stockHistoryQuery>) {
    const page = await this.inventory.history(q);
    return { items: page.items.map(toStockMovementDto), nextCursor: page.nextCursor };
  }

  @Get('categories')
  @RequirePermissions('catalog.view')
  categories() {
    return this.products.listCategories();
  }

  @Post('categories')
  @RequirePermissions('catalog.manage')
  async createCategory(@ZodBody(dto.categoryBody) body: z.infer<typeof dto.categoryBody>) {
    return toCategoryDto(await this.products.createCategory(body));
  }

  @Patch('categories/:categoryId')
  @RequirePermissions('catalog.manage')
  async updateCategory(
    @ZodParam('categoryId', objectIdSchema) id: string,
    @ZodBody(dto.updateCategoryBody) body: z.infer<typeof dto.updateCategoryBody>,
  ) {
    return toCategoryDto(await this.products.updateCategory(id, body));
  }

  @Delete('categories/:categoryId')
  @HttpCode(204)
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'Delete a category; its products stay, uncategorised' })
  async deleteCategory(@ZodParam('categoryId', objectIdSchema) id: string) {
    await this.products.deleteCategory(id);
  }
}

@ApiTags('customers')
@OrgScoped()
@RequireModule('commerce')
@Controller({ path: 'orgs/:orgId/customers', version: '1' })
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
  ) {}

  @Get()
  @RequirePermissions('customers.view')
  async list(@ZodQuery(dto.customerListQuery) q: z.infer<typeof dto.customerListQuery>) {
    const page = await this.customers.list(q);
    return { items: page.items.map(toCustomerDto), nextCursor: page.nextCursor };
  }

  @Post()
  @RequirePermissions('customers.manage')
  async create(@ZodBody(dto.createCustomerBody) body: z.infer<typeof dto.createCustomerBody>) {
    return toCustomerDto(await this.customers.create(body));
  }

  @Get(':customerId')
  @RequirePermissions('customers.view')
  async get(@ZodParam('customerId', objectIdSchema) id: string) {
    return toCustomerDto(await this.customers.get(id));
  }

  @Patch(':customerId')
  @RequirePermissions('customers.manage')
  async update(
    @ZodParam('customerId', objectIdSchema) id: string,
    @ZodBody(dto.updateCustomerBody) body: z.infer<typeof dto.updateCustomerBody>,
  ) {
    return toCustomerDto(await this.customers.update(id, body));
  }

  @Delete(':customerId')
  @HttpCode(204)
  @RequirePermissions('customers.manage')
  async remove(@ZodParam('customerId', objectIdSchema) id: string) {
    await this.customers.remove(id);
  }

  @Get(':customerId/orders')
  @RequirePermissions('customers.view', 'orders.view')
  async customerOrders(
    @ZodParam('customerId', objectIdSchema) id: string,
    @ZodQuery(dto.orderListQuery) q: z.infer<typeof dto.orderListQuery>,
  ) {
    const page = await this.orders.list({ ...q, customerId: id });
    return { items: page.items.map(toOrderDto), nextCursor: page.nextCursor };
  }
}

@ApiTags('orders')
@OrgScoped()
@RequireModule('commerce')
@Controller({ path: 'orgs/:orgId/orders', version: '1' })
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly settings: ShopSettingsService,
    private readonly orgs: OrgsService,
  ) {}

  @Get()
  @RequirePermissions('orders.view')
  async list(@ZodQuery(dto.orderListQuery) q: z.infer<typeof dto.orderListQuery>) {
    const page = await this.orders.list(q);
    return { items: page.items.map(toOrderDto), nextCursor: page.nextCursor };
  }

  @Get('counts')
  @RequirePermissions('orders.view')
  @ApiOperation({ summary: 'Number of orders in each status' })
  counts() {
    return this.orders.statusCounts();
  }

  @Get('summary')
  @RequirePermissions('orders.view')
  @ApiOperation({
    summary: 'Overview numbers: order value today and this month, orders to handle, COD to collect',
  })
  summary() {
    return this.orders.summary();
  }

  @Post()
  @RequirePermissions('orders.create')
  @ApiOperation({
    summary: 'Create a manual order. Confirmed orders take stock straight away.',
  })
  async create(@ZodBody(dto.createOrderBody) body: z.infer<typeof dto.createOrderBody>) {
    return toOrderDto(await this.orders.create({ ...body, source: 'manual' }));
  }

  @Post('print')
  @HttpCode(200)
  @RequirePermissions('orders.print')
  @ApiOperation({ summary: 'Orders plus business details for invoices and packing slips' })
  async print(@ZodBody(dto.printOrdersBody) body: z.infer<typeof dto.printOrdersBody>) {
    const [orders, settings, org] = await Promise.all([
      this.orders.getMany(body.ids),
      this.settings.get(),
      this.orgs.get(RequestContext.tenant()!.orgId),
    ]);
    return {
      business: {
        name: org.name,
        legalName: org.legalName ?? null,
        phone: org.contact?.phone ?? null,
        email: org.contact?.email ?? null,
        address: org.contact?.address ?? null,
        website: org.contact?.website ?? null,
        timezone: org.timezone,
        locale: org.locale,
      },
      invoiceNote: settings.invoiceNote,
      orders: orders.map(toOrderDto),
    };
  }

  @Get(':orderId')
  @RequirePermissions('orders.view')
  async get(@ZodParam('orderId', objectIdSchema) id: string) {
    return toOrderDto(await this.orders.get(id));
  }

  @Patch(':orderId')
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Change the delivery address or notes' })
  async update(
    @ZodParam('orderId', objectIdSchema) id: string,
    @ZodBody(dto.updateOrderBody) body: z.infer<typeof dto.updateOrderBody>,
  ) {
    return toOrderDto(await this.orders.updateDetails(id, body));
  }

  @Put(':orderId/items')
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Replace the items, discount or delivery charge before shipping' })
  async updateItems(
    @ZodParam('orderId', objectIdSchema) id: string,
    @ZodBody(dto.updateOrderItemsBody) body: z.infer<typeof dto.updateOrderItemsBody>,
  ) {
    return toOrderDto(await this.orders.updateItems(id, body));
  }

  @Post(':orderId/status')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Move the order forward (confirm, pack, ship, deliver, return)' })
  async status(
    @ZodParam('orderId', objectIdSchema) id: string,
    @ZodBody(dto.orderStatusBody) body: z.infer<typeof dto.orderStatusBody>,
  ) {
    return toOrderDto(
      await this.orders.changeStatus(id, body.status, {
        ...(body.note ? { note: body.note } : {}),
        ...(body.restock !== undefined ? { restock: body.restock } : {}),
      }),
    );
  }

  @Post(':orderId/cancel')
  @HttpCode(200)
  @RequirePermissions('orders.cancel')
  @ApiOperation({ summary: 'Cancel the order and put its items back into stock' })
  async cancel(
    @ZodParam('orderId', objectIdSchema) id: string,
    @ZodBody(dto.cancelOrderBody) body: z.infer<typeof dto.cancelOrderBody>,
  ) {
    return toOrderDto(
      await this.orders.changeStatus(id, 'cancelled', body.reason ? { reason: body.reason } : {}),
    );
  }

  @Post(':orderId/payment')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Record the amount paid, the method, or a refund' })
  async payment(
    @ZodParam('orderId', objectIdSchema) id: string,
    @ZodBody(dto.orderPaymentBody) body: z.infer<typeof dto.orderPaymentBody>,
  ) {
    return toOrderDto(await this.orders.updatePayment(id, body));
  }
}

@ApiTags('shop settings')
@OrgScoped()
@RequireModule('commerce')
@Controller({ path: 'orgs/:orgId/shop-settings', version: '1' })
export class ShopSettingsController {
  constructor(private readonly settings: ShopSettingsService) {}

  @Get()
  @RequireAnyPermission('orders.view', 'catalog.view', 'org.settings.manage')
  async get() {
    return toShopSettingsDto(await this.settings.get());
  }

  @Patch()
  @RequirePermissions('org.settings.manage')
  @ApiOperation({ summary: 'Delivery zones and charges, invoice note, low-stock level' })
  async update(@ZodBody(dto.shopSettingsBody) body: z.infer<typeof dto.shopSettingsBody>) {
    return toShopSettingsDto(await this.settings.update(body));
  }
}
