import { Schema, type Types } from 'mongoose';
import { tenantSchema, uniquePerTenant } from '../../infra/database/schema-helpers.js';

// ---------------------------------------------------------------- catalog

export const PRODUCT_STATUSES = ['active', 'draft', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface Category {
  orgId: Types.ObjectId;
  name: string;
  slug: string;
  sortOrder: number;
}

export const categorySchema = tenantSchema<Category>({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true },
  sortOrder: { type: Number, default: 0 },
});
categorySchema.index({ orgId: 1, slug: 1 }, { unique: true });

export interface ProductOption {
  name: string;
  values: string[];
}

export interface ProductImage {
  url: string;
  fileId?: Types.ObjectId;
  alt?: string;
}

/**
 * A sellable variant. A product without options has exactly one variant. `stock` is the
 * quantity on hand that can still be sold; it only changes through InventoryService, which
 * writes a stock movement for every change.
 */
export interface Variant {
  _id: Types.ObjectId;
  title: string;
  optionValues: string[];
  sku?: string;
  barcode?: string;
  priceMinor: number;
  compareAtPriceMinor?: number;
  costMinor?: number;
  trackStock: boolean;
  stock: number;
  weightGrams?: number;
}

export interface Product {
  orgId: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  categoryId?: Types.ObjectId;
  tags: string[];
  status: ProductStatus;
  currency: string;
  images: ProductImage[];
  options: ProductOption[];
  variants: Variant[];
  /** Lower-cased name, SKUs and tags for simple search. */
  searchText: string;
  soldCount: number;
  createdBy: Types.ObjectId;
}

const variantSchema = new Schema<Variant>(
  {
    title: { type: String, required: true },
    optionValues: { type: [String], default: [] },
    sku: String,
    barcode: String,
    priceMinor: { type: Number, required: true, min: 0 },
    compareAtPriceMinor: { type: Number, min: 0 },
    costMinor: { type: Number, min: 0 },
    trackStock: { type: Boolean, default: true },
    stock: { type: Number, default: 0 },
    weightGrams: { type: Number, min: 0 },
  },
  { strict: 'throw' },
);

export const productSchema = tenantSchema<Product>({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true },
  description: { type: String, default: '' },
  categoryId: Schema.Types.ObjectId,
  tags: { type: [String], default: [] },
  status: { type: String, enum: PRODUCT_STATUSES, default: 'active' },
  currency: { type: String, required: true },
  images: {
    type: [
      new Schema(
        { url: { type: String, required: true }, fileId: Schema.Types.ObjectId, alt: String },
        { _id: false, strict: 'throw' },
      ),
    ],
    default: [],
  },
  options: {
    type: [
      new Schema(
        { name: { type: String, required: true }, values: { type: [String], default: [] } },
        { _id: false, strict: 'throw' },
      ),
    ],
    default: [],
  },
  variants: { type: [variantSchema], default: [] },
  searchText: { type: String, default: '' },
  soldCount: { type: Number, default: 0 },
  createdBy: { type: Schema.Types.ObjectId, required: true },
});
productSchema.index({ orgId: 1, slug: 1 }, { unique: true });
productSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
productSchema.index({ orgId: 1, categoryId: 1 });
// Online store listings: newest, best sellers, and one category's newest.
productSchema.index({ orgId: 1, status: 1, createdAt: -1 });
productSchema.index({ orgId: 1, status: 1, soldCount: -1 });
productSchema.index({ orgId: 1, status: 1, categoryId: 1, createdAt: -1 });
// SKUs are unique per business. Enforced in ProductsService: a unique multikey index would
// also collide on variants that have no SKU.
productSchema.index({ orgId: 1, 'variants.sku': 1 });

export const STOCK_REASONS = [
  'initial',
  'adjustment',
  'received',
  'damaged',
  'order',
  'order_cancel',
  'order_edit',
  'return',
] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

/** Append-only record of every stock change, so on-hand counts can always be explained. */
export interface StockMovement {
  orgId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  delta: number;
  stockAfter: number;
  reason: StockReason;
  reference?: { type: string; id: string; label?: string };
  note?: string;
  actor: { type: string; id: string };
}

export const stockMovementSchema = tenantSchema<StockMovement>(
  {
    productId: { type: Schema.Types.ObjectId, required: true },
    variantId: { type: Schema.Types.ObjectId, required: true },
    delta: { type: Number, required: true },
    stockAfter: { type: Number, required: true },
    reason: { type: String, enum: STOCK_REASONS, required: true },
    reference: new Schema(
      { type: String, id: String, label: String },
      { _id: false, strict: 'throw' },
    ),
    note: String,
    actor: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }),
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
stockMovementSchema.index({ orgId: 1, productId: 1, createdAt: -1 });
stockMovementSchema.index({ orgId: 1, createdAt: -1 });

// ---------------------------------------------------------------- customers

export const CUSTOMER_SOURCES = [
  'manual',
  'messenger',
  'instagram',
  'whatsapp',
  'webchat',
  'store',
  'import',
] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

export interface Address {
  label?: string;
  name?: string;
  phone?: string;
  line1: string;
  area?: string;
  city?: string;
  district?: string;
  postcode?: string;
}

export interface Customer {
  orgId: Types.ObjectId;
  name: string;
  phone?: string;
  email?: string;
  addresses: Address[];
  notes: string;
  tags: string[];
  source: CustomerSource;
  blocked: boolean;
  searchText: string;
  stats: {
    orders: number;
    delivered: number;
    cancelled: number;
    returned: number;
    spentMinor: number;
    lastOrderAt?: Date;
  };
  createdBy?: Types.ObjectId;
}

export const addressSchema = new Schema<Address>(
  {
    label: String,
    name: String,
    phone: String,
    line1: { type: String, required: true },
    area: String,
    city: String,
    district: String,
    postcode: String,
  },
  { _id: false, strict: 'throw' },
);

export const customerSchema = tenantSchema<Customer>({
  name: { type: String, required: true, trim: true },
  phone: String,
  email: { type: String, lowercase: true, trim: true },
  addresses: { type: [addressSchema], default: [] },
  notes: { type: String, default: '' },
  tags: { type: [String], default: [] },
  source: { type: String, enum: CUSTOMER_SOURCES, default: 'manual' },
  blocked: { type: Boolean, default: false },
  searchText: { type: String, default: '' },
  stats: {
    type: new Schema(
      {
        orders: { type: Number, default: 0 },
        delivered: { type: Number, default: 0 },
        cancelled: { type: Number, default: 0 },
        returned: { type: Number, default: 0 },
        spentMinor: { type: Number, default: 0 },
        lastOrderAt: Date,
      },
      { _id: false, strict: 'throw' },
    ),
    default: () => ({}),
  },
  createdBy: Schema.Types.ObjectId,
});
customerSchema.index(
  { orgId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
customerSchema.index({ orgId: 1, updatedAt: -1 });

// ---------------------------------------------------------------- orders

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = [
  'cod',
  'bkash',
  'nagad',
  'rocket',
  'bank',
  'card',
  'cash',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded'] as const;
export type OrderPaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ORDER_SOURCES = ['manual', 'inbox', 'store', 'landing_page', 'api'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/**
 * Where an order's parcel is, in words that do not depend on the courier. The couriers
 * module translates each courier's own statuses into these.
 */
export const SHIPMENT_STATUSES = [
  /** Waiting to be sent to the courier (bulk booking). */
  'queued',
  /** Being sent, or sent without an answer from the courier (a lost reply). */
  'sending',
  /** The courier accepted the booking; waiting for pickup. */
  'booked',
  'picked_up',
  'in_transit',
  'on_hold',
  'delivered',
  'partly_delivered',
  /** On its way back to the business. */
  'returning',
  'returned',
  'cancelled',
  /** The courier refused the booking. */
  'failed',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Parcels that tie up the order: it cannot be cancelled or edited until they are settled. */
export const SHIPMENT_IN_PROGRESS: readonly ShipmentStatus[] = ['queued', 'sending', 'booked'];

/** The order's current parcel, copied from the parcel so order lists need no join. */
export interface OrderShipment {
  parcelId: Types.ObjectId;
  provider: string;
  accountName: string;
  consignmentId?: string;
  trackingCode?: string;
  status: ShipmentStatus;
  /** Something staff should look at (a return to confirm, a booking to check). */
  attention?: string;
  updatedAt: Date;
}

export interface OrderItem {
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  name: string;
  variantTitle: string;
  sku?: string;
  imageUrl?: string;
  unitPriceMinor: number;
  unitCostMinor?: number;
  quantity: number;
  totalMinor: number;
  trackStock: boolean;
}

export interface Order {
  orgId: Types.ObjectId;
  number: string;
  seq: number;
  status: OrderStatus;
  source: OrderSource;
  customerId: Types.ObjectId;
  customer: { name: string; phone?: string; email?: string };
  shippingAddress: Address;
  items: OrderItem[];
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  totalMinor: number;
  deliveryZone?: { id: string; name: string };
  payment: {
    method: PaymentMethod;
    status: OrderPaymentStatus;
    paidMinor: number;
    reference?: string;
  };
  /** True while the items' quantities are taken out of stock. */
  stockCommitted: boolean;
  customerNote: string;
  internalNote: string;
  cancelReason?: string;
  history: {
    status: OrderStatus;
    at: Date;
    actor: { type: string; id: string; label?: string };
    note?: string;
  }[];
  createdBy?: Types.ObjectId;
  /** The inbox conversation the order was taken in. */
  conversationId?: Types.ObjectId;
  /** The online store the order was placed in (also set for its landing pages). */
  storeId?: Types.ObjectId;
  /** The landing page the order was placed on, as it was named then (ADR 0016). */
  landingPage?: { id: Types.ObjectId; name: string; slug: string };
  /** Where the shopper came from, as the page saw it (ads, links). */
  attribution?: OrderAttribution;
  /** The latest parcel booked with a courier for this order. */
  shipment?: OrderShipment;
  placedAt: Date;
}

export const ATTRIBUTION_KEYS = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'fbclid',
  'gclid',
  'ttclid',
  'referrer',
] as const;
/** UTM tags, ad click ids and the referring site's host, each at most 200 characters. */
export type OrderAttribution = Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>>;

const orderItemSchema = new Schema<OrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, required: true },
    variantId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    variantTitle: { type: String, default: '' },
    sku: String,
    imageUrl: String,
    unitPriceMinor: { type: Number, required: true, min: 0 },
    unitCostMinor: { type: Number, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    totalMinor: { type: Number, required: true, min: 0 },
    trackStock: { type: Boolean, required: true },
  },
  { _id: false, strict: 'throw' },
);

export const orderSchema = tenantSchema<Order>({
  number: { type: String, required: true },
  seq: { type: Number, required: true },
  status: { type: String, enum: ORDER_STATUSES, required: true },
  source: { type: String, enum: ORDER_SOURCES, default: 'manual' },
  customerId: { type: Schema.Types.ObjectId, required: true },
  customer: new Schema(
    { name: { type: String, required: true }, phone: String, email: String },
    { _id: false, strict: 'throw' },
  ),
  shippingAddress: { type: addressSchema, required: true },
  items: { type: [orderItemSchema], default: [] },
  currency: { type: String, required: true },
  subtotalMinor: { type: Number, required: true, min: 0 },
  discountMinor: { type: Number, default: 0, min: 0 },
  deliveryChargeMinor: { type: Number, default: 0, min: 0 },
  totalMinor: { type: Number, required: true, min: 0 },
  deliveryZone: new Schema({ id: String, name: String }, { _id: false, strict: 'throw' }),
  payment: new Schema(
    {
      method: { type: String, enum: PAYMENT_METHODS, default: 'cod' },
      status: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid' },
      paidMinor: { type: Number, default: 0, min: 0 },
      reference: String,
    },
    { _id: false, strict: 'throw' },
  ),
  stockCommitted: { type: Boolean, default: false },
  customerNote: { type: String, default: '' },
  internalNote: { type: String, default: '' },
  cancelReason: String,
  history: {
    type: [
      new Schema(
        {
          status: { type: String, enum: ORDER_STATUSES, required: true },
          at: { type: Date, required: true },
          actor: new Schema(
            { type: String, id: String, label: String },
            { _id: false, strict: 'throw' },
          ),
          note: String,
        },
        { _id: false, strict: 'throw' },
      ),
    ],
    default: [],
  },
  createdBy: Schema.Types.ObjectId,
  conversationId: Schema.Types.ObjectId,
  storeId: Schema.Types.ObjectId,
  landingPage: new Schema(
    {
      id: { type: Schema.Types.ObjectId, required: true },
      name: { type: String, required: true },
      slug: { type: String, required: true },
    },
    { _id: false, strict: 'throw' },
  ),
  attribution: new Schema(Object.fromEntries(ATTRIBUTION_KEYS.map((k) => [k, String])), {
    _id: false,
    strict: 'throw',
  }),
  shipment: new Schema(
    {
      parcelId: { type: Schema.Types.ObjectId, required: true },
      provider: { type: String, required: true },
      accountName: { type: String, required: true },
      consignmentId: String,
      trackingCode: String,
      status: { type: String, enum: SHIPMENT_STATUSES, required: true },
      attention: String,
      updatedAt: { type: Date, required: true },
    },
    { _id: false, strict: 'throw' },
  ),
  placedAt: { type: Date, required: true },
});
orderSchema.index({ orgId: 1, number: 1 }, { unique: true });
orderSchema.index({ orgId: 1, placedAt: -1 });
orderSchema.index({ orgId: 1, status: 1, placedAt: -1 });
orderSchema.index({ orgId: 1, customerId: 1, placedAt: -1 });
orderSchema.index({ orgId: 1, 'customer.phone': 1 });
orderSchema.index({ orgId: 1, 'items.productId': 1 });
orderSchema.index(
  { orgId: 1, 'shipment.status': 1, placedAt: -1 },
  { partialFilterExpression: { shipment: { $type: 'object' } } },
);
orderSchema.index(
  { orgId: 1, conversationId: 1, placedAt: -1 },
  { partialFilterExpression: { conversationId: { $type: 'objectId' } } },
);
orderSchema.index(
  { orgId: 1, 'landingPage.id': 1, placedAt: -1 },
  { partialFilterExpression: { landingPage: { $type: 'object' } } },
);

// ---------------------------------------------------------------- shop settings

export interface DeliveryZone {
  id: string;
  name: string;
  chargeMinor: number;
}

/** Per-business selling settings: delivery charges and what prints on invoices. */
export interface ShopSettings {
  orgId: Types.ObjectId;
  deliveryZones: DeliveryZone[];
  defaultZoneId?: string;
  invoiceNote: string;
  lowStockThreshold: number;
  /** Confirm manual orders straight away (and take stock) instead of starting as pending. */
  autoConfirmManualOrders: boolean;
}

export const shopSettingsSchema = tenantSchema<ShopSettings>({
  deliveryZones: {
    type: [
      new Schema(
        {
          id: { type: String, required: true },
          name: { type: String, required: true },
          chargeMinor: { type: Number, required: true, min: 0 },
        },
        { _id: false, strict: 'throw' },
      ),
    ],
    default: [],
  },
  defaultZoneId: String,
  invoiceNote: { type: String, default: '' },
  lowStockThreshold: { type: Number, default: 3, min: 0 },
  autoConfirmManualOrders: { type: Boolean, default: true },
});
shopSettingsSchema.path('orgId').index(false);
uniquePerTenant(shopSettingsSchema);
