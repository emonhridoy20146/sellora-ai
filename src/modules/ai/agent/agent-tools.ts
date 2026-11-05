import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { normalizePhone } from '../../../common/validation/schemas.js';
import { CustomersService } from '../../commerce/customers.service.js';
import { WebsitePagesService } from '../../knowledge/website-pages.js';
import { OrdersService, type OrderDoc } from '../../commerce/orders.service.js';
import { ProductsService, type ProductDoc } from '../../commerce/products.service.js';
import type { CustomerSource, Variant } from '../../commerce/schemas.js';
import { ShopSettingsService } from '../../commerce/shop-settings.service.js';
import type { ContactDoc, ConversationDoc } from '../../inbox/inbox.mappers.js';
import { ContactRepository } from '../../inbox/repositories.js';
import { MEMORY_LIMITS, type ChannelType } from '../../inbox/schemas.js';
import { OrgsService } from '../../orgs/orgs.service.js';
import type { AiToolCall, AiToolSpec } from '../provider/ai-provider.js';
import { chatMoney } from './chat-text.js';

export const HANDOVER_REASONS = [
  'customer_request',
  'complaint',
  'order_problem',
  'discount_request',
  'cannot_answer',
  'other',
] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];

export interface ToolRunContext {
  /** preview: the settings page's test chat; nothing is saved and no order is placed. */
  mode: 'live' | 'preview';
  orgId: string;
  currency: string;
  takeOrders: boolean;
  confirmOrders: boolean;
  conversation: ConversationDoc | null;
  /** Kept current: tools that change the contact replace it here. */
  contact: ContactDoc | null;
  channelType: ChannelType | null;
}

export interface ToolOutcome {
  /** Sent to the model as JSON. */
  result: Record<string, unknown>;
  isError?: boolean;
  handover?: { reason: HandoverReason; summary: string };
  order?: { id: string; number: string; preview: boolean };
}

const CUSTOMER_SOURCE: Record<ChannelType, CustomerSource> = {
  web_chat: 'webchat',
  messenger: 'messenger',
  instagram: 'instagram',
  whatsapp: 'whatsapp',
};

const SEARCH_LIMIT = 8;
const ORDER_DEDUP_MS = 15 * 60_000;
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be an id from the catalog or a tool');
const nullableText = (max: number) => z.string().trim().max(max).nullable();

const itemsSchema = z
  .array(
    z
      .object({
        product_id: objectId,
        variant_id: objectId,
        quantity: z.number().int().min(1).max(100),
      })
      .strict(),
  )
  .min(1)
  .max(20);

const inputs = {
  search_products: z.object({ query: z.string().trim().min(1).max(100) }).strict(),
  get_product: z.object({ product_id: objectId }).strict(),
  quote_order: z
    .object({ items: itemsSchema, delivery_zone_id: z.string().trim().max(64).nullable() })
    .strict(),
  create_order: z
    .object({
      items: itemsSchema,
      delivery_zone_id: z.string().trim().max(64).nullable(),
      customer_name: z.string().trim().min(1).max(100),
      phone: z.string().trim().min(5).max(30),
      address: z.string().trim().min(5).max(300),
      area: nullableText(100),
      district: nullableText(100),
      note: nullableText(500),
    })
    .strict(),
  get_my_orders: z.object({}).strict(),
  save_customer_details: z
    .object({
      name: nullableText(100),
      phone: z.string().trim().max(30).nullable(),
      email: z.string().trim().max(200).nullable(),
      address: nullableText(MEMORY_LIMITS.address),
      facts: z.array(z.string().trim().min(1).max(MEMORY_LIMITS.fact)).max(10),
    })
    .strict(),
  handover_to_human: z
    .object({ reason: z.enum(HANDOVER_REASONS), summary: z.string().trim().min(1).max(500) })
    .strict(),
  search_website: z.object({ query: z.string().trim().min(1).max(200) }).strict(),
} as const;

export type AgentToolName = keyof typeof inputs;

const nullable = (type: string, description: string) => ({
  anyOf: [{ type }, { type: 'null' }],
  description,
});

const itemsJson = {
  type: 'array',
  description: 'One entry per variant (1 to 20).',
  items: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'Product id from the catalog or a tool.' },
      variant_id: { type: 'string', description: 'Variant id from get_product.' },
      quantity: { type: 'integer', description: 'How many (1 to 100).' },
    },
    required: ['product_id', 'variant_id', 'quantity'],
    additionalProperties: false,
  },
};

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const SPECS: Record<AgentToolName, AiToolSpec> = {
  search_products: {
    name: 'search_products',
    description:
      "Search the shop's products by words. Call this when the customer asks for or describes a " +
      'product that is not in the catalog list, e.g. "red saree" or "baccha der juta". Search in ' +
      'English, and try Bangla or other words if nothing comes back.',
    inputSchema: object({
      query: { type: 'string', description: 'A few words, up to 100 characters.' },
    }),
  },
  get_product: {
    name: 'get_product',
    description:
      "Get one product's details: description, sizes or colours (variants) with their ids, prices " +
      'and whether each can be ordered. Call this before quoting or ordering, and when the ' +
      'customer asks about sizes, colours, stock or details.',
    inputSchema: object({ product_id: { type: 'string', description: 'Product id.' } }),
  },
  quote_order: {
    name: 'quote_order',
    description:
      'Work out the item total, delivery charge and total to pay for an order, and check stock. ' +
      'Call this before asking the customer to confirm, and quote its numbers exactly.',
    inputSchema: object({
      items: itemsJson,
      delivery_zone_id: nullable('string', 'Delivery zone id from the list, or null for none.'),
    }),
  },
  create_order: {
    name: 'create_order',
    description:
      'Place the order. Call this only after the customer has seen the quote and clearly ' +
      'confirmed. Payment is cash on delivery.',
    inputSchema: object({
      items: itemsJson,
      delivery_zone_id: nullable('string', 'Delivery zone id from the list, or null for none.'),
      customer_name: { type: 'string', description: 'Name for the delivery.' },
      phone: { type: 'string', description: 'Mobile number as the customer gave it.' },
      address: {
        type: 'string',
        description: 'Delivery address: house, road and area, as the customer wrote it.',
      },
      area: nullable('string', 'Area or thana, if known.'),
      district: nullable('string', 'District or city, if known.'),
      note: nullable('string', 'Anything the customer asked the shop to know, or null.'),
    }),
  },
  get_my_orders: {
    name: 'get_my_orders',
    description:
      "List this customer's recent orders with their status. Call this when they ask about an " +
      'order they placed. It only ever returns orders of the customer in this chat.',
    inputSchema: object({}),
  },
  save_customer_details: {
    name: 'save_customer_details',
    description:
      "Remember the customer's details for the team and future chats. Call this when they tell " +
      'you their name, phone, email or address, or a lasting preference. Use null for anything ' +
      'they did not give.',
    inputSchema: object({
      name: nullable('string', 'Their name.'),
      phone: nullable('string', 'Mobile number.'),
      email: nullable('string', 'Email address.'),
      address: nullable('string', 'Delivery address.'),
      facts: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Short lasting facts, e.g. "wears size M", "prefers cotton". Empty list if none. ' +
          'Never store payment details or passwords.',
      },
    }),
  },
  search_website: {
    name: 'search_website',
    description:
      "Search the pages of the business's own website: delivery and return policies, size " +
      'guides, care instructions, payment options, opening hours, about the business. Call it ' +
      'when the customer asks something the information above does not answer. Use a few key ' +
      'words, in the language the website is likely written in (often English), and try ' +
      'other words if nothing comes back. Answer only from what the pages say. Prices and ' +
      'stock always come from the catalog and product tools, never from page text.',
    inputSchema: object({
      query: { type: 'string', description: 'A few key words, up to 200 characters.' },
    }),
  },
  handover_to_human: {
    name: 'handover_to_human',
    description:
      'Hand the chat to a person on the team. The AI stops replying in this chat after your ' +
      'message. Call it when the customer asks for a person, complains, has a problem with an ' +
      'order, wants a discount, or asks something you cannot answer. Still write the customer a ' +
      'short message saying a team member will reply soon.',
    inputSchema: object({
      reason: { type: 'string', enum: [...HANDOVER_REASONS] },
      summary: {
        type: 'string',
        description: 'One or two sentences for the team: what the customer needs.',
      },
    }),
  },
};

function optionsText(p: ProductDoc): string {
  return p.options.map((o) => `${o.name}: ${o.values.join(', ')}`).join('; ');
}

function canSell(v: Variant): boolean {
  return !v.trackStock || v.stock > 0;
}

/** Problems a field error list describes, worded for the model. */
function fieldProblems(err: AppError): string[] {
  return (err.details?.errors ?? []).map((e) => `${e.path}: ${e.message}`);
}

/**
 * The tools the AI sales agent may call. Every lookup runs in the business's tenant scope,
 * ids from the model are validated, prices always come from the catalog, and order
 * lookups are limited to the customer in the chat, whatever the model asks for.
 */
@Injectable()
export class AgentTools {
  constructor(
    private readonly products: ProductsService,
    private readonly orders: OrdersService,
    private readonly customers: CustomersService,
    private readonly shopSettings: ShopSettingsService,
    private readonly contacts: ContactRepository,
    private readonly orgs: OrgsService,
    private readonly website: WebsitePagesService,
  ) {}

  /** The tools for this business: no create_order without ordering, no search_website without pages. */
  specs(ctx: { takeOrders: boolean; websitePages?: boolean }): AiToolSpec[] {
    return (Object.keys(SPECS) as AgentToolName[])
      .filter((n) => ctx.takeOrders || n !== 'create_order')
      .filter((n) => ctx.websitePages || n !== 'search_website')
      .map((n) => SPECS[n]);
  }

  async execute(call: AiToolCall, ctx: ToolRunContext): Promise<ToolOutcome> {
    const name = call.name as AgentToolName;
    const schema = inputs[name] as z.ZodType | undefined;
    if (!schema || (name === 'create_order' && !ctx.takeOrders))
      return { result: { error: 'unknown_tool', tool: call.name }, isError: true };
    const parsed = schema.safeParse(call.input);
    if (!parsed.success)
      return {
        result: {
          error: 'invalid_input',
          problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`),
        },
        isError: true,
      };
    const input = parsed.data as never;
    switch (name) {
      case 'search_products':
        return this.search(input, ctx);
      case 'get_product':
        return this.product(input, ctx);
      case 'quote_order':
        return this.quote(input, ctx);
      case 'create_order':
        return this.createOrder(input, ctx);
      case 'get_my_orders':
        return this.myOrders(ctx);
      case 'save_customer_details':
        return this.saveDetails(input, ctx);
      case 'search_website':
        return this.searchWebsite(input);
      case 'handover_to_human': {
        const h = input as z.infer<(typeof inputs)['handover_to_human']>;
        return {
          result: {
            ok: true,
            next: 'Tell the customer, in their language, that a team member will reply soon.',
          },
          handover: { reason: h.reason, summary: h.summary },
        };
      }
    }
  }

  // ---------------------------------------------------------------- website

  private async searchWebsite(
    input: z.infer<(typeof inputs)['search_website']>,
  ): Promise<ToolOutcome> {
    const hits = await this.website.search(input.query, 3);
    return {
      result: {
        results: hits.map((h) => ({ page: h.title, url: h.url, text: h.passages })),
        ...(hits.length === 0
          ? { hint: 'No page matched. Try other or fewer words, or say you will check.' }
          : {}),
      },
    };
  }

  // ---------------------------------------------------------------- catalog

  private async search(
    input: z.infer<(typeof inputs)['search_products']>,
    ctx: ToolRunContext,
  ): Promise<ToolOutcome> {
    const found = await this.products.searchActive([input.query], SEARCH_LIMIT);
    return {
      result: {
        results: found.map((p) => {
          const prices = p.variants.map((v) => v.priceMinor);
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          return {
            id: p._id.toHexString(),
            name: p.name,
            price:
              min === max
                ? chatMoney(min, ctx.currency)
                : `${chatMoney(min, ctx.currency)}–${chatMoney(max, ctx.currency)}`,
            available: p.variants.some(canSell),
            ...(p.options.length ? { options: optionsText(p) } : {}),
          };
        }),
        ...(found.length === 0 ? { hint: 'Nothing matched. Try other or fewer words.' } : {}),
      },
    };
  }

  private async product(
    input: z.infer<(typeof inputs)['get_product']>,
    ctx: ToolRunContext,
  ): Promise<ToolOutcome> {
    const [p] = await this.products.getMany([input.product_id]);
    if (!p || p.status !== 'active')
      return {
        result: { error: 'not_found', message: 'No product for sale has this id.' },
        isError: true,
      };
    const { lowStockThreshold } = await this.shopSettings.get();
    return {
      result: {
        id: p._id.toHexString(),
        name: p.name,
        description: p.description.length > 700 ? `${p.description.slice(0, 700)}…` : p.description,
        ...(p.options.length ? { options: optionsText(p) } : {}),
        variants: p.variants.map((v) => ({
          id: v._id.toHexString(),
          title: v.title,
          price: chatMoney(v.priceMinor, ctx.currency),
          ...(v.compareAtPriceMinor && v.compareAtPriceMinor > v.priceMinor
            ? { regular_price: chatMoney(v.compareAtPriceMinor, ctx.currency) }
            : {}),
          available: canSell(v),
          ...(v.trackStock && v.stock > 0 && v.stock <= lowStockThreshold
            ? { few_left: true, max_quantity: v.stock }
            : {}),
        })),
        photos: p.images.length,
      },
    };
  }

  // ---------------------------------------------------------------- orders

  /** Prices the items from the catalog and checks they can be sold in these quantities. */
  private async price(items: z.infer<typeof itemsSchema>, currency: string) {
    const products = await this.products.getMany(items.map((i) => i.product_id));
    const byId = new Map(products.map((p) => [p._id.toHexString(), p]));
    const problems: string[] = [];
    const seen = new Set<string>();
    const lines: {
      productId: string;
      variantId: string;
      name: string;
      variant: string;
      unitMinor: number;
      quantity: number;
      totalMinor: number;
    }[] = [];
    for (const item of items) {
      const p = byId.get(item.product_id);
      const v = p?.variants.find((x) => x._id.toHexString() === item.variant_id);
      if (!p || !v || p.status !== 'active') {
        problems.push(`${item.product_id}/${item.variant_id}: no product for sale with these ids`);
        continue;
      }
      if (p.currency !== currency) {
        problems.push(`${p.name}: priced in ${p.currency}, which this shop cannot sell in`);
        continue;
      }
      if (seen.has(item.variant_id)) {
        problems.push(`${p.name} ${v.title}: listed twice; combine the quantities`);
        continue;
      }
      seen.add(item.variant_id);
      if (v.trackStock && v.stock < item.quantity) {
        problems.push(
          v.stock > 0
            ? `${p.name} ${v.title}: only ${v.stock} available`
            : `${p.name} ${v.title}: out of stock`,
        );
        continue;
      }
      lines.push({
        productId: item.product_id,
        variantId: item.variant_id,
        name: p.name,
        variant: v.title === 'Default' ? '' : v.title,
        unitMinor: v.priceMinor,
        quantity: item.quantity,
        totalMinor: v.priceMinor * item.quantity,
      });
    }
    return { lines, problems };
  }

  private async zone(zoneId: string | null) {
    if (!zoneId) return { zone: null, problem: null };
    const settings = await this.shopSettings.get();
    const zone = settings.deliveryZones.find((z) => z.id === zoneId) ?? null;
    return { zone, problem: zone ? null : `${zoneId}: not one of the delivery zone ids` };
  }

  private async quote(
    input: z.infer<(typeof inputs)['quote_order']>,
    ctx: ToolRunContext,
  ): Promise<ToolOutcome> {
    const [{ lines, problems }, { zone, problem }] = await Promise.all([
      this.price(input.items, ctx.currency),
      this.zone(input.delivery_zone_id),
    ]);
    if (problem) problems.push(problem);
    const itemsMinor = lines.reduce((a, l) => a + l.totalMinor, 0);
    const deliveryMinor = zone?.chargeMinor ?? 0;
    const money = (m: number) => chatMoney(m, ctx.currency);
    return {
      result: {
        lines: lines.map((l) => ({
          product: l.name,
          ...(l.variant ? { variant: l.variant } : {}),
          unit_price: money(l.unitMinor),
          quantity: l.quantity,
          line_total: money(l.totalMinor),
        })),
        item_total: money(itemsMinor),
        delivery: zone ? `${zone.name}: ${money(deliveryMinor)}` : 'no delivery zone',
        total_to_pay: money(itemsMinor + deliveryMinor),
        payment: 'cash on delivery',
        ...(problems.length ? { problems, can_order: false } : { can_order: true }),
      },
      ...(problems.length && !lines.length ? { isError: true } : {}),
    };
  }

  private sameItems(order: OrderDoc, items: z.infer<typeof itemsSchema>): boolean {
    if (order.items.length !== items.length) return false;
    const want = new Map(items.map((i) => [i.variant_id, i.quantity]));
    return order.items.every((i) => want.get(i.variantId.toHexString()) === i.quantity);
  }

  private async createOrder(
    input: z.infer<(typeof inputs)['create_order']>,
    ctx: ToolRunContext,
  ): Promise<ToolOutcome> {
    const { lines, problems } = await this.price(input.items, ctx.currency);
    const { zone, problem } = await this.zone(input.delivery_zone_id);
    if (problem) problems.push(problem);
    if (problems.length || !lines.length)
      return { result: { error: 'cannot_order', problems }, isError: true };

    const org = await this.orgs.get(ctx.orgId);
    const phone = normalizePhone(input.phone, org.country);
    if (!phone)
      return {
        result: { error: 'invalid_phone', message: 'The mobile number looks wrong; ask again.' },
        isError: true,
      };
    const total = lines.reduce((a, l) => a + l.totalMinor, 0) + (zone?.chargeMinor ?? 0);

    if (ctx.mode === 'preview')
      return {
        result: {
          ok: true,
          preview: true,
          order_number: 'TEST-ORDER',
          total_to_pay: chatMoney(total, ctx.currency),
          note: 'Test chat: no order was saved.',
        },
        order: { id: '', number: 'TEST-ORDER', preview: true },
      };

    const conv = ctx.conversation!;
    // The same order placed again (a repeated tool call or a retried job) is not doubled.
    const recent = await this.orders.recentForConversation(
      conv._id,
      new Date(Date.now() - ORDER_DEDUP_MS),
    );
    const existing = recent.find((o) => o.status !== 'cancelled' && this.sameItems(o, input.items));
    if (existing)
      return {
        result: {
          ok: true,
          already_placed: true,
          order_number: existing.number,
          status: existing.status,
          total_to_pay: chatMoney(existing.totalMinor, ctx.currency),
        },
        order: { id: existing._id.toHexString(), number: existing.number, preview: false },
      };

    let order: OrderDoc;
    try {
      order = await this.orders.create({
        customer: { name: input.customer_name, phone },
        shippingAddress: {
          name: input.customer_name,
          phone,
          line1: input.address,
          ...(input.area ? { area: input.area } : {}),
          ...(input.district ? { district: input.district } : {}),
        },
        items: lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
        })),
        deliveryZoneId: zone ? zone.id : null,
        payment: { method: 'cod' },
        ...(input.note ? { customerNote: input.note } : {}),
        internalNote: 'Placed by the AI sales agent in a chat.',
        status: ctx.confirmOrders ? 'confirmed' : 'pending',
        source: 'inbox',
        ...(ctx.channelType ? { customerSource: CUSTOMER_SOURCE[ctx.channelType] } : {}),
        conversationId: conv._id.toHexString(),
      });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (err.status === HttpStatus.UNPROCESSABLE_ENTITY)
        return { result: { error: 'invalid_order', problems: fieldProblems(err) }, isError: true };
      if (err.status === HttpStatus.PAYMENT_REQUIRED)
        return {
          result: {
            error: 'shop_cannot_take_orders',
            message: 'The shop cannot take more orders in chat right now. Hand over to a person.',
          },
          isError: true,
        };
      if (err.code === 'customer_blocked')
        return {
          result: {
            error: 'needs_team',
            message:
              'The team must handle this order. Hand over to a person; do not give a reason.',
          },
          isError: true,
        };
      throw err;
    }

    if (ctx.contact) {
      const set: Record<string, unknown> = { customerId: order.customerId };
      if (!ctx.contact.name) set.name = input.customer_name;
      if (!ctx.contact.phone) set.phone = phone;
      ctx.contact =
        (await this.contacts.findOneAndUpdate({ _id: ctx.contact._id }, { $set: set })) ??
        ctx.contact;
    }
    return {
      result: {
        ok: true,
        order_number: order.number,
        status: order.status,
        total_to_pay: chatMoney(order.totalMinor, ctx.currency),
      },
      order: { id: order._id.toHexString(), number: order.number, preview: false },
    };
  }

  /** The customer in this chat: the linked customer, else the one with the contact's phone. */
  async customerOf(contact: ContactDoc | null) {
    if (!contact) return null;
    if (contact.customerId) {
      const c = await this.customers.get(contact.customerId.toHexString()).catch(() => null);
      if (c) return c;
    }
    return contact.phone ? this.customers.findByPhone(contact.phone) : null;
  }

  private async myOrders(ctx: ToolRunContext): Promise<ToolOutcome> {
    const customer = ctx.mode === 'live' ? await this.customerOf(ctx.contact) : null;
    if (!customer)
      return {
        result: {
          orders: [],
          note:
            'No orders are linked to this chat. If they ordered with another phone number, ' +
            'ask for it and save it with save_customer_details, then try again.',
        },
      };
    const orders = await this.orders.recentForCustomer(customer._id, 5);
    return {
      result: {
        orders: orders.map((o) => ({
          number: o.number,
          status: o.status,
          placed: o.placedAt.toISOString().slice(0, 10),
          items: o.items
            .map((i) => `${i.quantity}× ${i.name}${i.variantTitle ? ` (${i.variantTitle})` : ''}`)
            .join(', '),
          total: chatMoney(o.totalMinor, o.currency),
          payment: o.payment.status,
        })),
      },
    };
  }

  // ---------------------------------------------------------------- memory

  private async saveDetails(
    input: z.infer<(typeof inputs)['save_customer_details']>,
    ctx: ToolRunContext,
  ): Promise<ToolOutcome> {
    const problems: string[] = [];
    const set: Record<string, unknown> = {};
    let phone: string | null = null;
    if (input.phone) {
      const org = await this.orgs.get(ctx.orgId);
      phone = normalizePhone(input.phone, org.country);
      if (phone) set.phone = phone;
      else problems.push('phone: the number looks wrong; ask again');
    }
    if (input.email) {
      if (z.email().safeParse(input.email).success) set.email = input.email.toLowerCase();
      else problems.push('email: the address looks wrong');
    }
    if (input.name) set.name = input.name;

    if (ctx.mode === 'preview' || !ctx.contact)
      return {
        result: {
          ok: problems.length === 0,
          preview: true,
          ...(problems.length ? { problems } : {}),
        },
      };

    const memory = ctx.contact.memory ?? { facts: [] };
    const facts = [...memory.facts];
    for (const f of input.facts)
      if (!facts.some((x) => x.toLowerCase() === f.toLowerCase())) facts.push(f);
    set.memory = {
      // The newest facts win when the list is full.
      facts: facts.slice(-MEMORY_LIMITS.facts),
      ...(input.address || memory.address ? { address: input.address ?? memory.address } : {}),
      updatedAt: new Date(),
    };
    ctx.contact =
      (await this.contacts.findOneAndUpdate({ _id: ctx.contact._id }, { $set: set })) ??
      ctx.contact;
    if (phone && !ctx.contact.customerId) {
      const customer = await this.customers.findByPhone(phone);
      if (customer)
        ctx.contact =
          (await this.contacts.findOneAndUpdate(
            { _id: ctx.contact._id },
            { $set: { customerId: customer._id } },
          )) ?? ctx.contact;
    }
    return { result: { ok: problems.length === 0, ...(problems.length ? { problems } : {}) } };
  }
}
