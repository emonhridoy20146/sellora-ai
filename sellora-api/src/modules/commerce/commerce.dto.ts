import { z } from 'zod';
import {
  emailSchema,
  moneyMinorSchema,
  objectIdSchema,
  paginationQuerySchema,
  rawPhoneSchema,
} from '../../common/validation/schemas.js';
import {
  ORDER_SOURCES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PRODUCT_STATUSES,
  SHIPMENT_STATUSES,
} from './schemas.js';

const text = (max: number) => z.string().trim().max(max);
const label = (max: number) => z.string().trim().min(1).max(max);
const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
const quantity = z.number().int().min(1).max(100_000);
/** Staff record how an order was paid; "online" is set only by a checkout payment (ADR 0029). */
const staffPaymentMethod = z.enum(PAYMENT_METHODS.filter((m) => m !== 'online') as [
  Exclude<(typeof PAYMENT_METHODS)[number], 'online'>,
  ...Exclude<(typeof PAYMENT_METHODS)[number], 'online'>[],
]);

// ---------------------------------------------------------------- catalog

const optionValue = label(60);

const variantBody = z
  .object({
    id: objectIdSchema.optional(),
    optionValues: z.array(optionValue).max(3).default([]),
    sku: text(64).nullable().optional(),
    barcode: text(64).nullable().optional(),
    priceMinor: moneyMinorSchema,
    compareAtPriceMinor: moneyMinorSchema.nullable().optional(),
    costMinor: moneyMinorSchema.nullable().optional(),
    trackStock: z.boolean().default(true),
    /** Opening stock for a new variant. Later changes go through stock adjustments. */
    stock: z.number().int().min(0).max(10_000_000).optional(),
    weightGrams: z.number().int().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();

/** An uploaded photo (fileId; its URL comes from storage) or a link to one hosted elsewhere. */
const imageBody = z
  .object({
    url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .optional(),
    fileId: objectIdSchema.optional(),
    alt: text(200).optional(),
  })
  .strict()
  .refine((i) => i.url !== undefined || i.fileId !== undefined, {
    message: 'Give an uploaded file or a link',
    path: ['url'],
  });

const optionBody = z
  .object({ name: label(40), values: z.array(optionValue).min(1).max(50) })
  .strict();

const productFields = {
  name: label(200),
  description: z.string().max(20_000),
  categoryId: objectIdSchema.nullable(),
  tags: z.array(label(40)).max(30),
  status: z.enum(PRODUCT_STATUSES),
  images: z.array(imageBody).max(20),
  options: z.array(optionBody).max(3),
  variants: z.array(variantBody).min(1).max(100),
};

export const createProductBody = z
  .object({
    ...productFields,
    description: productFields.description.default(''),
    categoryId: productFields.categoryId.default(null),
    tags: productFields.tags.default([]),
    status: productFields.status.default('active'),
    images: productFields.images.default([]),
    options: productFields.options.default([]),
  })
  .strict();

export const updateProductBody = z.object(productFields).partial().strict();

export const productListQuery = paginationQuerySchema.extend({
  q: text(100).optional(),
  status: z.enum([...PRODUCT_STATUSES, 'all']).optional(),
  categoryId: objectIdSchema.optional(),
  stock: z.enum(['low', 'out']).optional(),
});

export const categoryBody = z
  .object({ name: label(80), sortOrder: z.number().int().min(0).max(10_000).optional() })
  .strict();
export const updateCategoryBody = categoryBody.partial().strict();

export const stockAdjustBody = z
  .object({
    variantId: objectIdSchema,
    mode: z.enum(['set', 'add']),
    /** For `set` the new count; for `add` the change, negative to remove. */
    quantity: z.number().int().min(-10_000_000).max(10_000_000),
    reason: z.enum(['adjustment', 'received', 'damaged']).default('adjustment'),
    note: text(300).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'set' && v.quantity < 0)
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Stock cannot be negative' });
    if (v.mode === 'add' && v.quantity === 0)
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Enter a change other than 0' });
  });

export const stockHistoryQuery = paginationQuerySchema.extend({
  productId: objectIdSchema.optional(),
});

// ---------------------------------------------------------------- customers

export const addressBody = z
  .object({
    label: text(40).optional(),
    name: text(120).optional(),
    phone: rawPhoneSchema.optional(),
    line1: label(300),
    area: text(120).optional(),
    city: text(120).optional(),
    district: text(120).optional(),
    postcode: text(20).optional(),
  })
  .strict();

const customerFields = {
  name: label(120),
  phone: rawPhoneSchema.nullable().optional(),
  email: emailSchema.nullable().optional(),
  addresses: z.array(addressBody).max(10).optional(),
  notes: text(5000).optional(),
  tags: z.array(label(40)).max(30).optional(),
  blocked: z.boolean().optional(),
};

export const createCustomerBody = z.object(customerFields).strict();
export const updateCustomerBody = z.object(customerFields).partial().strict();

export const customerListQuery = paginationQuerySchema.extend({
  q: text(100).optional(),
  tag: text(40).optional(),
  blocked: queryBool.optional(),
});

// ---------------------------------------------------------------- orders

const orderItemBody = z
  .object({
    productId: objectIdSchema,
    variantId: objectIdSchema,
    quantity,
    unitPriceMinor: moneyMinorSchema.optional(),
  })
  .strict();

const zoneId = text(40).nullable().optional();

export const createOrderBody = z
  .object({
    customer: z
      .object({
        id: objectIdSchema.optional(),
        name: label(120),
        phone: rawPhoneSchema.optional(),
        email: emailSchema.optional(),
      })
      .strict(),
    shippingAddress: addressBody,
    items: z.array(orderItemBody).min(1).max(100),
    deliveryZoneId: zoneId,
    deliveryChargeMinor: moneyMinorSchema.optional(),
    discountMinor: moneyMinorSchema.optional(),
    payment: z
      .object({
        method: staffPaymentMethod,
        paidMinor: moneyMinorSchema.optional(),
        reference: text(120).optional(),
      })
      .strict()
      .optional(),
    customerNote: text(2000).optional(),
    internalNote: text(2000).optional(),
    status: z.enum(['pending', 'confirmed']).optional(),
    allowBlockedCustomer: z.boolean().optional(),
  })
  .strict();

export const orderListQuery = paginationQuerySchema.extend({
  q: text(100).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  customerId: objectIdSchema.optional(),
  /** none = not sent to a courier yet; attention = the parcel needs a look. */
  shipment: z.enum([...SHIPMENT_STATUSES, 'none', 'ready', 'attention']).optional(),
  source: z.enum(ORDER_SOURCES).optional(),
  /** Orders placed in one online store. */
  storeId: objectIdSchema.optional(),
  /** Orders placed on one landing page. */
  landingPageId: objectIdSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const orderStatusBody = z
  .object({
    status: z.enum(ORDER_STATUSES).exclude(['pending', 'cancelled']),
    note: text(300).optional(),
    /** Returns only: put the items back into stock (default true). */
    restock: z.boolean().optional(),
  })
  .strict();

export const cancelOrderBody = z.object({ reason: text(300).optional() }).strict();

export const updateOrderItemsBody = z
  .object({
    items: z.array(orderItemBody).min(1).max(100),
    discountMinor: moneyMinorSchema.optional(),
    deliveryZoneId: zoneId,
    deliveryChargeMinor: moneyMinorSchema.optional(),
  })
  .strict();

export const updateOrderBody = z
  .object({
    shippingAddress: addressBody.optional(),
    customerNote: text(2000).optional(),
    internalNote: text(2000).optional(),
  })
  .strict();

export const orderPaymentBody = z
  .object({
    method: z.enum(PAYMENT_METHODS).optional(),
    paidMinor: moneyMinorSchema.optional(),
    reference: text(120).nullable().optional(),
    refunded: z.boolean().optional(),
  })
  .strict();

export const printOrdersBody = z.object({ ids: z.array(objectIdSchema).min(1).max(50) }).strict();

// ---------------------------------------------------------------- shop settings

export const shopSettingsBody = z
  .object({
    deliveryZones: z
      .array(
        z
          .object({ id: text(40).optional(), name: label(60), chargeMinor: moneyMinorSchema })
          .strict(),
      )
      .max(30)
      .optional(),
    defaultZoneId: text(40).nullable().optional(),
    invoiceNote: text(1000).optional(),
    lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
    autoConfirmManualOrders: z.boolean().optional(),
  })
  .strict();
