import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ProductDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  variants: { id: string; title: string; sku: string | null; stock: number; priceMinor: number }[];
  stock: { tracked: boolean; total: number; lowVariants: number | null };
  soldCount: number;
}

interface OrderDto {
  id: string;
  number: string;
  status: string;
  customerId: string;
  customer: { name: string; phone: string | null };
  shippingAddress: { name?: string; phone?: string; line1: string };
  items: { variantId: string; quantity: number; unitPriceMinor: number; totalMinor: number }[];
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  totalMinor: number;
  dueMinor: number;
  deliveryZone: { id: string; name: string } | null;
  payment: { method: string; status: string; paidMinor: number };
  stockCommitted: boolean;
  history: { status: string; note: string | null }[];
  allowedTransitions: string[];
}

describe('commerce: products, stock, customers and orders', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let platform: string;

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;

  const createProduct = async (body: Record<string, unknown>) =>
    (await O().post(url('/products')).send(body).expect(201)).body as ProductDto;

  const simple = (name: string, stock: number, priceMinor = 50_000, sku?: string) =>
    createProduct({
      name,
      variants: [{ priceMinor, stock, ...(sku ? { sku } : {}) }],
    });

  const stockOf = async (productId: string, variantIndex = 0) =>
    (
      (
        await O()
          .get(url(`/products/${productId}`))
          .expect(200)
      ).body as ProductDto
    ).variants[variantIndex]!.stock;

  const order = (p: ProductDto, quantity: number, extra: Record<string, unknown> = {}) =>
    O()
      .post(url('/orders'))
      .send({
        customer: { name: 'Rahim Uddin', phone: '01712345678' },
        shippingAddress: { line1: 'House 12, Road 5', area: 'Dhanmondi', city: 'Dhaka' },
        items: [{ productId: p.id, variantId: p.variants[0]!.id, quantity }],
        ...extra,
      });

  const setOverrides = (limits: Record<string, number | null>) =>
    t
      .as(platform)
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ limits, note: 'commerce test' })
      .expect(200);

  beforeAll(async () => {
    t = await TestApp.create();
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Dhaka Fashion' })).id;
    platform = (await t.platformOwner()).token;
    // Unique indexes are built in the background at boot; concurrency tests rely on them.
    await Promise.all(
      ['Product', 'Customer', 'Order', 'ShopSettings', 'Category', 'StockMovement'].map((m) =>
        t.db.model(m).init(),
      ),
    );
  });
  afterAll(async () => {
    await t.close();
  });

  describe('products', () => {
    it('creates a simple product, records its opening stock and gives it a unique slug', async () => {
      const a = await simple('Cotton Panjabi', 10, 120_000, 'PJ-001');
      expect(a).toMatchObject({
        name: 'Cotton Panjabi',
        slug: 'cotton-panjabi',
        status: 'active',
        stock: { tracked: true, total: 10, lowVariants: 0 },
      });
      expect(a.variants).toHaveLength(1);
      expect(a.variants[0]).toMatchObject({ title: 'Default', sku: 'PJ-001', stock: 10 });

      const b = await simple('Cotton Panjabi', 0);
      expect(b.slug).toBe('cotton-panjabi-2');

      const history = await O()
        .get(url(`/stock-movements?productId=${a.id}`))
        .expect(200);
      expect(history.body.items).toHaveLength(1);
      expect(history.body.items[0]).toMatchObject({ delta: 10, stockAfter: 10, reason: 'initial' });
    });

    it('creates a product with options and validates variant combinations', async () => {
      const p = await createProduct({
        name: 'Silk Saree',
        options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
        variants: [
          { optionValues: ['Red'], priceMinor: 300_000, stock: 2, sku: 'SS-R' },
          { optionValues: ['Blue'], priceMinor: 320_000, stock: 1, sku: 'SS-B' },
        ],
      });
      expect(p.variants.map((v) => v.title)).toEqual(['Red', 'Blue']);
      expect(p.stock.total).toBe(3);

      const bad = await O()
        .post(url('/products'))
        .send({
          name: 'Broken',
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [
            { optionValues: ['XL'], priceMinor: 100 },
            { optionValues: ['S'], priceMinor: 100, compareAtPriceMinor: 50 },
          ],
        })
        .expect(422);
      const paths = (bad.body.errors as { path: string }[]).map((e) => e.path);
      expect(paths).toContain('variants.0.optionValues.0');
      expect(paths).toContain('variants.1.compareAtPriceMinor');

      await O()
        .post(url('/products'))
        .send({ name: 'Two defaults', variants: [{ priceMinor: 1 }, { priceMinor: 2 }] })
        .expect(422);
    });

    it('refuses a SKU used by another product', async () => {
      const res = await O()
        .post(url('/products'))
        .send({ name: 'Copy', variants: [{ priceMinor: 100, sku: 'PJ-001' }] })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'sku_taken', sku: 'PJ-001' });
    });

    it('edits a product without touching existing stock, and adds a variant with opening stock', async () => {
      const p = await createProduct({
        name: 'T-shirt',
        options: [{ name: 'Size', values: ['M'] }],
        variants: [{ optionValues: ['M'], priceMinor: 40_000, stock: 4 }],
      });
      const res = await O()
        .patch(url(`/products/${p.id}`))
        .send({
          options: [{ name: 'Size', values: ['M', 'L'] }],
          variants: [
            // Trying to change stock through an edit is ignored for existing variants.
            { id: p.variants[0]!.id, optionValues: ['M'], priceMinor: 45_000, stock: 99 },
            { optionValues: ['L'], priceMinor: 45_000, stock: 6 },
          ],
        })
        .expect(200);
      const updated = res.body as ProductDto;
      expect(updated.variants.map((v) => [v.title, v.priceMinor, v.stock])).toEqual([
        ['M', 45_000, 4],
        ['L', 45_000, 6],
      ]);
      const history = await O()
        .get(url(`/stock-movements?productId=${p.id}`))
        .expect(200);
      expect(history.body.items.map((m: { delta: number }) => m.delta).sort()).toEqual([4, 6]);
    });

    it('lists, searches and filters by stock', async () => {
      await simple('Leather Wallet', 1, 90_000, 'LW-1');
      const all = await O().get(url('/products')).expect(200);
      expect(all.body.items.length).toBeGreaterThanOrEqual(5);
      const found = await O().get(url('/products?q=wallet')).expect(200);
      expect(found.body.items.map((p: ProductDto) => p.name)).toEqual(['Leather Wallet']);
      const bySku = await O().get(url('/products?q=lw-1')).expect(200);
      expect(bySku.body.items).toHaveLength(1);
      const low = await O().get(url('/products?stock=low')).expect(200);
      expect(low.body.items.map((p: ProductDto) => p.name)).toContain('Leather Wallet');
      const out = await O().get(url('/products?stock=out')).expect(200);
      expect(out.body.items.every((p: ProductDto) => p.variants.some((v) => v.stock <= 0))).toBe(
        true,
      );
      const page = await O().get(url('/products?limit=2')).expect(200);
      expect(page.body.items).toHaveLength(2);
      const next = await O()
        .get(url(`/products?limit=2&cursor=${page.body.nextCursor as string}`))
        .expect(200);
      expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    });

    it('manages categories and leaves products in place when one is deleted', async () => {
      const cat = (await O().post(url('/categories')).send({ name: 'Men' }).expect(201)).body as {
        id: string;
        slug: string;
      };
      expect(cat.slug).toBe('men');
      await O().post(url('/categories')).send({ name: 'Men' }).expect(409);
      const p = await createProduct({
        name: 'Formal Shirt',
        categoryId: cat.id,
        variants: [{ priceMinor: 100_000, stock: 3 }],
      });
      const list = await O().get(url('/categories')).expect(200);
      expect(list.body.find((c: { id: string }) => c.id === cat.id).productCount).toBe(1);
      const filtered = await O()
        .get(url(`/products?categoryId=${cat.id}`))
        .expect(200);
      expect(filtered.body.items.map((x: ProductDto) => x.id)).toEqual([p.id]);
      await O()
        .delete(url(`/categories/${cat.id}`))
        .expect(204);
      const after = await O()
        .get(url(`/products/${p.id}`))
        .expect(200);
      expect(after.body.categoryId).toBeNull();
      await O()
        .post(url('/products'))
        .send({ name: 'X', categoryId: cat.id, variants: [{ priceMinor: 1 }] })
        .expect(422);
    });

    it('enforces the plan product limit', async () => {
      const count = (await O().get(url('/products?limit=100')).expect(200)).body.items.length;
      await setOverrides({ products: count });
      const res = await O()
        .post(url('/products'))
        .send({ name: 'One too many', variants: [{ priceMinor: 1 }] })
        .expect(402);
      expect(res.body).toMatchObject({ code: 'plan_limit_reached', limit: 'products' });
      // Drafts that are archived do not count; archiving makes room.
      await setOverrides({ products: null });
    });
  });

  describe('stock adjustments', () => {
    it('sets and changes stock with history, and never goes below zero', async () => {
      const p = await simple('Ceramic Mug', 5);
      const v = p.variants[0]!.id;
      const set = await O()
        .post(url(`/products/${p.id}/stock`))
        .send({ variantId: v, mode: 'set', quantity: 12, note: 'Counted' })
        .expect(200);
      expect(set.body.variants[0].stock).toBe(12);
      await O()
        .post(url(`/products/${p.id}/stock`))
        .send({ variantId: v, mode: 'add', quantity: -2, reason: 'damaged' })
        .expect(200);
      const tooMany = await O()
        .post(url(`/products/${p.id}/stock`))
        .send({ variantId: v, mode: 'add', quantity: -11 })
        .expect(409);
      expect(tooMany.body).toMatchObject({
        code: 'insufficient_stock',
        available: 10,
        requested: 11,
      });
      await O()
        .post(url(`/products/${p.id}/stock`))
        .send({ variantId: v, mode: 'set', quantity: -1 })
        .expect(422);
      const history = await O()
        .get(url(`/stock-movements?productId=${p.id}`))
        .expect(200);
      expect(
        history.body.items.map((m: { delta: number; reason: string; stockAfter: number }) => [
          m.reason,
          m.delta,
          m.stockAfter,
        ]),
      ).toEqual([
        ['damaged', -2, 10],
        ['adjustment', 7, 12],
        ['initial', 5, 5],
      ]);
      const audit = await O().get(url('/audit-events?action=inventory.adjusted')).expect(200);
      expect(audit.body.items.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('shop settings', () => {
    it('saves delivery zones and picks a default', async () => {
      const res = await O()
        .patch(url('/shop-settings'))
        .send({
          deliveryZones: [
            { id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 },
            { id: 'outside', name: 'Outside Dhaka', chargeMinor: 12_000 },
          ],
          defaultZoneId: 'dhaka',
          invoiceNote: 'Thank you for shopping with us',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        defaultZoneId: 'dhaka',
        autoConfirmManualOrders: true,
        lowStockThreshold: 3,
      });
      await O().patch(url('/shop-settings')).send({ defaultZoneId: 'nowhere' }).expect(422);
    });
  });

  describe('orders', () => {
    it('creates a confirmed manual order: prices, delivery, discount, stock, customer', async () => {
      const p = await simple('Kurti', 6, 85_000);
      const res = await order(p, 2, {
        discountMinor: 10_000,
        payment: { method: 'bkash', paidMinor: 50_000, reference: 'TX123' },
      }).expect(201);
      const o = res.body as OrderDto;
      expect(o.number).toMatch(/^SL-\d+$/);
      expect(o).toMatchObject({
        status: 'confirmed',
        stockCommitted: true,
        subtotalMinor: 170_000,
        discountMinor: 10_000,
        deliveryChargeMinor: 6_000,
        totalMinor: 166_000,
        dueMinor: 116_000,
        deliveryZone: { id: 'dhaka', name: 'Inside Dhaka' },
        payment: { method: 'bkash', status: 'partial', paidMinor: 50_000 },
        customer: { name: 'Rahim Uddin', phone: '+8801712345678' },
        shippingAddress: { name: 'Rahim Uddin', phone: '+8801712345678' },
      });
      expect(await stockOf(p.id)).toBe(4);

      const product = (
        await O()
          .get(url(`/products/${p.id}`))
          .expect(200)
      ).body as ProductDto;
      expect(product.soldCount).toBe(2);
      const moves = await O()
        .get(url(`/stock-movements?productId=${p.id}`))
        .expect(200);
      expect(moves.body.items[0]).toMatchObject({
        delta: -2,
        reason: 'order',
        reference: { type: 'order', id: o.id, label: o.number },
      });

      // The same phone written another way is the same customer.
      const again = (
        await order(p, 1, {
          customer: { name: 'Rahim', phone: '+880 1712-345678' },
          deliveryZoneId: 'outside',
        }).expect(201)
      ).body as OrderDto;
      expect(again.customerId).toBe(o.customerId);
      expect(again.deliveryChargeMinor).toBe(12_000);
      expect(Number(again.number.split('-')[1])).toBe(Number(o.number.split('-')[1]) + 1);

      const customer = await O()
        .get(url(`/customers/${o.customerId}`))
        .expect(200);
      expect(customer.body).toMatchObject({
        phone: '+8801712345678',
        source: 'manual',
        stats: { orders: 2, spentMinor: 166_000 + again.totalMinor },
      });
      expect(customer.body.addresses).toHaveLength(1);
      const search = await O().get(url('/customers?q=01712345')).expect(200);
      expect(search.body.items.map((c: { id: string }) => c.id)).toEqual([o.customerId]);
    });

    it('refuses to oversell and leaves no trace of the failed order', async () => {
      const p = await simple('Limited Watch', 1, 500_000);
      const before = (await O().get(url('/orders/counts')).expect(200)).body.all as number;
      const res = await order(p, 2).expect(409);
      expect(res.body).toMatchObject({ code: 'insufficient_stock', available: 1, requested: 2 });
      expect(await stockOf(p.id)).toBe(1);
      expect((await O().get(url('/orders/counts')).expect(200)).body.all).toBe(before);
    });

    it('sells exactly the stock on hand when many orders race for it', async () => {
      const p = await simple('Flash Sale Bag', 5, 100_000);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          order(p, 1, {
            customer: { name: `Buyer ${i}`, phone: `0181100${String(i).padStart(4, '0')}` },
          }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(5);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      expect(await stockOf(p.id)).toBe(0);
      const moves = await O()
        .get(url(`/stock-movements?productId=${p.id}&limit=100`))
        .expect(200);
      expect(moves.body.items.filter((m: { reason: string }) => m.reason === 'order')).toHaveLength(
        5,
      );
      const numbers = results.filter((r) => r.status === 201).map((r) => r.body.number as string);
      expect(new Set(numbers).size).toBe(5);
    });

    it('takes stock on confirm, gives it back on cancel, and refuses bad status moves', async () => {
      const p = await simple('Hijab', 3, 30_000);
      const pending = (await order(p, 2, { status: 'pending' }).expect(201)).body as OrderDto;
      expect(pending).toMatchObject({ status: 'pending', stockCommitted: false });
      expect(await stockOf(p.id)).toBe(3);

      await O()
        .post(url(`/orders/${pending.id}/status`))
        .send({ status: 'delivered' })
        .expect(409);
      const confirmed = await O()
        .post(url(`/orders/${pending.id}/status`))
        .send({ status: 'confirmed' })
        .expect(200);
      expect(confirmed.body).toMatchObject({ status: 'confirmed', stockCommitted: true });
      expect(await stockOf(p.id)).toBe(1);

      const cancelled = await O()
        .post(url(`/orders/${pending.id}/cancel`))
        .send({ reason: 'Customer changed mind' })
        .expect(200);
      expect(cancelled.body).toMatchObject({
        status: 'cancelled',
        stockCommitted: false,
        cancelReason: 'Customer changed mind',
        allowedTransitions: [],
      });
      expect(await stockOf(p.id)).toBe(3);
      // Cancelling twice must not put stock back twice.
      await O()
        .post(url(`/orders/${pending.id}/cancel`))
        .send({})
        .expect(409);
      expect(await stockOf(p.id)).toBe(3);
      expect(cancelled.body.history.map((h: { status: string }) => h.status)).toEqual([
        'pending',
        'confirmed',
        'cancelled',
      ]);
      // Cancel goes through its own permission, not the status endpoint.
      await O()
        .post(url(`/orders/${pending.id}/status`))
        .send({ status: 'cancelled' })
        .expect(422);
    });

    it('cancelling the same order from two tabs restores stock only once', async () => {
      const p = await simple('Perfume', 4, 70_000);
      const o = (await order(p, 3).expect(201)).body as OrderDto;
      expect(await stockOf(p.id)).toBe(1);
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          O()
            .post(url(`/orders/${o.id}/cancel`))
            .send({}),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await stockOf(p.id)).toBe(4);
    });

    it('ships, delivers and handles returns with or without restocking', async () => {
      const p = await simple('Sneakers', 5, 250_000);
      const a = (await order(p, 1).expect(201)).body as OrderDto;
      const b = (await order(p, 2).expect(201)).body as OrderDto;
      expect(await stockOf(p.id)).toBe(2);
      for (const s of ['packed', 'shipped', 'delivered'])
        await O()
          .post(url(`/orders/${a.id}/status`))
          .send({ status: s })
          .expect(200);
      await O()
        .post(url(`/orders/${a.id}/status`))
        .send({ status: 'returned', note: 'Wrong size' })
        .expect(200);
      expect(await stockOf(p.id)).toBe(3);

      await O()
        .post(url(`/orders/${b.id}/status`))
        .send({ status: 'shipped' })
        .expect(200);
      const damaged = await O()
        .post(url(`/orders/${b.id}/status`))
        .send({ status: 'returned', restock: false })
        .expect(200);
      expect(damaged.body.history.at(-1)).toMatchObject({
        status: 'returned',
        note: 'Not restocked',
      });
      expect(await stockOf(p.id)).toBe(3);

      // Shipped orders can no longer be edited.
      await O()
        .put(url(`/orders/${b.id}/items`))
        .send({ items: [{ productId: p.id, variantId: p.variants[0]!.id, quantity: 1 }] })
        .expect(409);
      const product = (
        await O()
          .get(url(`/products/${p.id}`))
          .expect(200)
      ).body as ProductDto;
      expect(product.soldCount).toBe(0);
    });

    it('edits items and moves only the difference in stock', async () => {
      const shirt = await simple('Polo Shirt', 10, 60_000);
      const cap = await simple('Cap', 10, 20_000);
      const o = (await order(shirt, 3).expect(201)).body as OrderDto;
      expect(await stockOf(shirt.id)).toBe(7);

      const edited = await O()
        .put(url(`/orders/${o.id}/items`))
        .send({
          items: [
            { productId: shirt.id, variantId: shirt.variants[0]!.id, quantity: 1 },
            {
              productId: cap.id,
              variantId: cap.variants[0]!.id,
              quantity: 2,
              unitPriceMinor: 15_000,
            },
          ],
          discountMinor: 5_000,
          deliveryZoneId: null,
        })
        .expect(200);
      expect(edited.body).toMatchObject({
        subtotalMinor: 90_000,
        discountMinor: 5_000,
        deliveryChargeMinor: 0,
        totalMinor: 85_000,
        deliveryZone: null,
      });
      expect(await stockOf(shirt.id)).toBe(9);
      expect(await stockOf(cap.id)).toBe(8);
      const moves = await O()
        .get(url(`/stock-movements?productId=${shirt.id}`))
        .expect(200);
      expect(moves.body.items[0]).toMatchObject({ delta: 2, reason: 'order_edit' });

      await O()
        .put(url(`/orders/${o.id}/items`))
        .send({ items: [{ productId: cap.id, variantId: cap.variants[0]!.id, quantity: 11 }] })
        .expect(409);
      expect(await stockOf(cap.id)).toBe(8);
      expect(await stockOf(shirt.id)).toBe(9);

      await O()
        .put(url(`/orders/${o.id}/items`))
        .send({
          items: [{ productId: cap.id, variantId: cap.variants[0]!.id, quantity: 1 }],
          discountMinor: 999_999,
        })
        .expect(422);
    });

    it('records payments and refunds', async () => {
      const p = await simple('Bedsheet', 5, 150_000);
      const o = (await order(p, 1).expect(201)).body as OrderDto;
      expect(o.payment).toMatchObject({ method: 'cod', status: 'unpaid' });
      await O()
        .post(url(`/orders/${o.id}/payment`))
        .send({ paidMinor: o.totalMinor + 1 })
        .expect(422);
      const paid = await O()
        .post(url(`/orders/${o.id}/payment`))
        .send({ paidMinor: o.totalMinor, method: 'nagad', reference: 'NG-9' })
        .expect(200);
      expect(paid.body).toMatchObject({
        dueMinor: 0,
        payment: { status: 'paid', method: 'nagad', reference: 'NG-9' },
      });
      const refunded = await O()
        .post(url(`/orders/${o.id}/payment`))
        .send({ refunded: true })
        .expect(200);
      expect(refunded.body.payment.status).toBe('refunded');
    });

    it('blocks orders for blocked customers unless confirmed, and protects customers with orders', async () => {
      const p = await simple('Shawl', 5, 40_000);
      const first = (
        await order(p, 1, { customer: { name: 'Fraudster', phone: '01999888777' } }).expect(201)
      ).body as OrderDto;
      await O()
        .patch(url(`/customers/${first.customerId}`))
        .send({ blocked: true })
        .expect(200);
      const refused = await order(p, 1, {
        customer: { name: 'Fraudster', phone: '01999888777' },
      }).expect(409);
      expect(refused.body).toMatchObject({
        code: 'customer_blocked',
        customerId: first.customerId,
      });
      await order(p, 1, {
        customer: { name: 'Fraudster', phone: '01999888777' },
        allowBlockedCustomer: true,
      }).expect(201);
      const del = await O()
        .delete(url(`/customers/${first.customerId}`))
        .expect(409);
      expect(del.body.code).toBe('customer_has_orders');

      const lone = await O()
        .post(url('/customers'))
        .send({ name: 'No Orders', phone: '01555000111' })
        .expect(201);
      await O()
        .post(url('/customers'))
        .send({ name: 'Duplicate', phone: '+8801555000111' })
        .expect(409);
      await O().post(url('/customers')).send({ name: 'Bad', phone: '12345' }).expect(422);
      await O()
        .delete(url(`/customers/${lone.body.id as string}`))
        .expect(204);

      const history = await O()
        .get(url(`/customers/${first.customerId}/orders`))
        .expect(200);
      expect(history.body.items).toHaveLength(2);
    });

    it('archives a product that is on an order instead of deleting it', async () => {
      const sold = await simple('Old Model', 2, 10_000);
      await order(sold, 1).expect(201);
      const res = await O()
        .delete(url(`/products/${sold.id}`))
        .expect(200);
      expect(res.body).toEqual({ deleted: false, archived: true });
      const listed = await O().get(url('/products?limit=100')).expect(200);
      expect(listed.body.items.map((x: ProductDto) => x.id)).not.toContain(sold.id);
      await order(sold, 1).expect(422);

      const unsold = await simple('Never Sold', 2, 10_000);
      expect(
        (
          await O()
            .delete(url(`/products/${unsold.id}`))
            .expect(200)
        ).body,
      ).toEqual({
        deleted: true,
        archived: false,
      });
    });

    it('lists, searches, counts and prints orders', async () => {
      const byPhone = await O().get(url('/orders?q=01712345678')).expect(200);
      expect(byPhone.body.items.length).toBeGreaterThanOrEqual(2);
      expect(byPhone.body.items.every((o: OrderDto) => o.customer.phone === '+8801712345678')).toBe(
        true,
      );
      const first = byPhone.body.items[0] as OrderDto;
      const byNumber = await O()
        .get(url(`/orders?q=${first.number}`))
        .expect(200);
      expect(byNumber.body.items[0].id).toBe(first.id);
      const cancelled = await O().get(url('/orders?status=cancelled')).expect(200);
      expect(cancelled.body.items.every((o: OrderDto) => o.status === 'cancelled')).toBe(true);
      const counts = (await O().get(url('/orders/counts')).expect(200)).body as Record<
        string,
        number
      >;
      expect(counts.all).toBe(
        Object.entries(counts)
          .filter(([k]) => k !== 'all')
          .reduce((a, [, n]) => a + n, 0),
      );
      const print = await O()
        .post(url('/orders/print'))
        .send({ ids: [first.id, new Types.ObjectId().toHexString()] })
        .expect(200);
      expect(print.body).toMatchObject({
        business: { name: 'Dhaka Fashion' },
        invoiceNote: 'Thank you for shopping with us',
      });
      expect(print.body.orders.map((o: OrderDto) => o.id)).toEqual([first.id]);
    });

    it('enforces the monthly order limit', async () => {
      const p = await simple('Limit Probe', 5, 1_000);
      const thisMonth = (await O().get(url('/orders/counts')).expect(200)).body.all as number;
      await setOverrides({ ordersPerMonth: thisMonth });
      const res = await order(p, 1).expect(402);
      expect(res.body).toMatchObject({ code: 'plan_limit_reached', limit: 'ordersPerMonth' });
      await setOverrides({ ordersPerMonth: null });
      await order(p, 1).expect(201);
    });
  });

  describe('roles and tenants', () => {
    it('applies role permissions to catalog and order routes', async () => {
      const viewer = await t.addMember(owner, orgId, 'viewer');
      const agent = await t.addMember(owner, orgId, 'sales_agent');
      const p = await simple('Role Probe', 5, 1_000);
      await t.as(viewer.token).get(url('/products')).expect(200);
      await t
        .as(viewer.token)
        .post(url('/products'))
        .send({ name: 'x', variants: [{ priceMinor: 1 }] })
        .expect(403);
      await t
        .as(viewer.token)
        .post(url('/orders'))
        .send({
          customer: { name: 'A' },
          shippingAddress: { line1: 'x' },
          items: [{ productId: p.id, variantId: p.variants[0]!.id, quantity: 1 }],
        })
        .expect(403);
      const o = await t
        .as(agent.token)
        .post(url('/orders'))
        .send({
          customer: { name: 'From agent', phone: '01600000001' },
          shippingAddress: { line1: 'x' },
          items: [{ productId: p.id, variantId: p.variants[0]!.id, quantity: 1 }],
        })
        .expect(201);
      // Sales agents create orders but cannot cancel them or change stock.
      await t
        .as(agent.token)
        .post(url(`/orders/${o.body.id as string}/cancel`))
        .send({})
        .expect(403);
      await t
        .as(agent.token)
        .post(url(`/products/${p.id}/stock`))
        .send({ variantId: p.variants[0]!.id, mode: 'set', quantity: 1 })
        .expect(403);
      await t.as(agent.token).patch(url('/shop-settings')).send({ invoiceNote: 'x' }).expect(403);
    });

    it('never shows one business the products, customers or orders of another', async () => {
      const other = await t.registerUser({ name: 'Other' });
      const otherOrg = (await t.createOrg(other, { name: 'Other Shop' })).id;
      const mine = await simple('Secret Product', 3, 1_000);
      const myOrder = (await order(mine, 1).expect(201)).body as OrderDto;
      const as = t.as(other.token);
      const base = `/v1/orgs/${otherOrg}`;
      await as.get(`${base}/products/${mine.id}`).expect(404);
      await as.patch(`${base}/products/${mine.id}`).send({ name: 'Stolen' }).expect(404);
      await as.delete(`${base}/products/${mine.id}`).expect(404);
      await as
        .post(`${base}/products/${mine.id}/stock`)
        .send({ variantId: mine.variants[0]!.id, mode: 'set', quantity: 0 })
        .expect(404);
      await as.get(`${base}/orders/${myOrder.id}`).expect(404);
      await as.post(`${base}/orders/${myOrder.id}/cancel`).send({}).expect(404);
      await as.get(`${base}/customers/${myOrder.customerId}`).expect(404);
      // Ordering another business's product from your own shop fails validation.
      await as
        .post(`${base}/orders`)
        .send({
          customer: { name: 'X' },
          shippingAddress: { line1: 'x' },
          items: [{ productId: mine.id, variantId: mine.variants[0]!.id, quantity: 1 }],
        })
        .expect(422);
      const printed = await as
        .post(`${base}/orders/print`)
        .send({ ids: [myOrder.id] })
        .expect(200);
      expect(printed.body.orders).toEqual([]);
      expect((await as.get(`${base}/products`).expect(200)).body.items).toEqual([]);
      expect((await as.get(`${base}/customers`).expect(200)).body.items).toEqual([]);
      expect(await stockOf(mine.id)).toBe(2);
    });
  });
});
