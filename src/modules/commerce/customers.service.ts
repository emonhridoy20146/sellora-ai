import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { nationalDigits, normalizePhone } from '../../common/validation/schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { CustomerRepository, OrderRepository } from './repositories.js';
import type { Address, Customer, CustomerSource } from './schemas.js';
import { escapeRegex, searchText } from './text.js';

export type CustomerDoc = WithId<Customer>;

export interface CustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  addresses?: Address[];
  notes?: string;
  tags?: string[];
  blocked?: boolean;
}

export function toCustomerDto(c: CustomerDoc) {
  return {
    id: c._id.toHexString(),
    name: c.name,
    phone: c.phone ?? null,
    email: c.email ?? null,
    addresses: c.addresses,
    notes: c.notes,
    tags: c.tags,
    source: c.source,
    blocked: c.blocked,
    stats: {
      orders: c.stats.orders,
      delivered: c.stats.delivered,
      cancelled: c.stats.cancelled,
      returned: c.stats.returned,
      spentMinor: c.stats.spentMinor,
      lastOrderAt: c.stats.lastOrderAt?.toISOString() ?? null,
    },
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function sameAddress(a: Address, b: Address): boolean {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  return (
    norm(a.line1) === norm(b.line1) &&
    norm(a.area) === norm(b.area) &&
    norm(a.city) === norm(b.city) &&
    norm(a.district) === norm(b.district)
  );
}

/**
 * The business's customer book. A phone number identifies a customer within a business,
 * so orders from the inbox, the store and manual entry land on the same person.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly orders: OrderRepository,
    private readonly orgs: OrgsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Normalises phone numbers to E.164 using the business's country, so "01712345678" and
   * "+8801712345678" are the same customer. Reports invalid numbers at `path`.
   */
  async normalizePhones<T extends Record<string, string | null | undefined>>(
    values: T,
    pathPrefix = '',
  ): Promise<T> {
    const entries = Object.entries(values).filter(([, v]) => typeof v === 'string' && v);
    if (!entries.length) return values;
    const { country } = await this.orgs.get(this.orgId());
    const out: Record<string, string | null | undefined> = { ...values };
    const errors: { path: string; message: string }[] = [];
    for (const [key, raw] of entries) {
      const phone = normalizePhone(raw!, country);
      if (phone) out[key] = phone;
      else errors.push({ path: `${pathPrefix}${key}`, message: 'Invalid phone number' });
    }
    if (errors.length) throw AppError.validation(errors);
    return out as T;
  }

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  async normalizeAddress(address: Address, path: string): Promise<Address> {
    if (!address.phone) return address;
    const { phone } = await this.normalizePhones({ phone: address.phone }, `${path}.`);
    return { ...address, phone: phone };
  }

  private async normalizeInput<T extends Partial<CustomerInput>>(input: T): Promise<T> {
    const out = { ...input };
    if (input.phone) out.phone = (await this.normalizePhones({ phone: input.phone })).phone;
    if (input.addresses)
      out.addresses = await Promise.all(
        input.addresses.map((a, i) => this.normalizeAddress(a, `addresses.${i}`)),
      );
    return out;
  }

  private search(c: {
    name: string;
    phone?: string | null;
    email?: string | null;
    tags?: string[];
  }) {
    // The phone is stored as E.164; also index the local form so "01712..." matches.
    const local = c.phone ? (nationalDigits(c.phone) ?? undefined) : undefined;
    return searchText(c.name, c.phone ?? undefined, local, c.email ?? undefined, c.tags ?? []);
  }

  async list(query: {
    q?: string;
    tag?: string;
    blocked?: boolean;
    limit: number;
    cursor?: string;
  }) {
    const filter: Record<string, unknown> = {};
    if (query.q) filter.searchText = { $regex: escapeRegex(query.q.trim().toLowerCase()) };
    if (query.tag) filter.tags = query.tag;
    if (query.blocked !== undefined) filter.blocked = query.blocked;
    return this.customers.paginate(filter, query, 'updatedAt');
  }

  async get(id: string): Promise<CustomerDoc> {
    const c = await this.customers.findById(id);
    if (!c) throw AppError.notFound('customer');
    return c;
  }

  async findByPhone(phone: string): Promise<CustomerDoc | null> {
    return this.customers.findOne({ phone });
  }

  private phoneTaken(existing: CustomerDoc | null) {
    return AppError.conflict('customer_phone_taken', 'A customer with this phone number exists.', {
      customerId: existing?._id.toHexString() ?? null,
    });
  }

  async create(raw: CustomerInput, source: CustomerSource = 'manual'): Promise<CustomerDoc> {
    const input = await this.normalizeInput(raw);
    try {
      const created = await this.customers.create({
        name: input.name,
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.email ? { email: input.email } : {}),
        addresses: input.addresses ?? [],
        notes: input.notes ?? '',
        tags: input.tags ?? [],
        source,
        blocked: input.blocked ?? false,
        searchText: this.search(input),
        ...(RequestContext.actor().type === 'user'
          ? { createdBy: new Types.ObjectId(RequestContext.actor().id) }
          : {}),
      });
      await this.audit.record({
        action: 'customer.created',
        orgId: this.orgId(),
        target: { type: 'customer', id: created._id.toHexString(), label: created.name },
        metadata: { source },
      });
      return created;
    } catch (err) {
      if (isDuplicateKey(err) && input.phone)
        throw this.phoneTaken(await this.findByPhone(input.phone));
      throw err;
    }
  }

  async update(id: string, raw: Partial<CustomerInput>): Promise<CustomerDoc> {
    const before = await this.get(id);
    const input = await this.normalizeInput(raw);
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.phone !== undefined) {
      if (input.phone) set.phone = input.phone;
      else unset.phone = '';
    }
    if (input.email !== undefined) {
      if (input.email) set.email = input.email;
      else unset.email = '';
    }
    if (input.addresses !== undefined) set.addresses = input.addresses;
    if (input.notes !== undefined) set.notes = input.notes;
    if (input.tags !== undefined) set.tags = input.tags;
    if (input.blocked !== undefined) set.blocked = input.blocked;
    set.searchText = this.search({
      name: input.name ?? before.name,
      phone: input.phone !== undefined ? input.phone : before.phone,
      email: input.email !== undefined ? input.email : before.email,
      tags: input.tags ?? before.tags,
    });
    let after: CustomerDoc | null;
    try {
      after = await this.customers.findOneAndUpdate(
        { _id: before._id },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      );
    } catch (err) {
      if (isDuplicateKey(err) && input.phone)
        throw this.phoneTaken(await this.findByPhone(input.phone));
      throw err;
    }
    const fields = [...Object.keys(set), ...Object.keys(unset)].filter((k) => k !== 'searchText');
    await this.audit.record({
      action:
        input.blocked !== undefined && input.blocked !== before.blocked
          ? input.blocked
            ? 'customer.blocked'
            : 'customer.unblocked'
          : 'customer.updated',
      orgId: this.orgId(),
      target: { type: 'customer', id, label: after!.name },
      metadata: { fields },
    });
    return after!;
  }

  /** Customers with orders cannot be deleted; their orders still point at them. */
  async remove(id: string): Promise<void> {
    const c = await this.get(id);
    if (await this.orders.exists({ customerId: c._id }))
      throw AppError.conflict(
        'customer_has_orders',
        'This customer has orders and cannot be deleted. Block them instead.',
      );
    await this.customers.deleteOne({ _id: c._id });
    await this.audit.record({
      action: 'customer.deleted',
      orgId: this.orgId(),
      target: { type: 'customer', id, label: c.name },
    });
  }

  /**
   * The customer an order belongs to: the given id, otherwise the customer with this phone
   * number, otherwise a new customer. A new delivery address is remembered on the customer.
   */
  async resolveForOrder(input: {
    customerId?: string;
    name: string;
    phone?: string;
    email?: string;
    address: Address;
    source: CustomerSource;
  }): Promise<CustomerDoc> {
    let customer: CustomerDoc | null = null;
    if (input.customerId) {
      customer = await this.customers.findById(input.customerId);
      if (!customer)
        throw AppError.validation([{ path: 'customer.id', message: 'Unknown customer' }]);
    } else if (input.phone) {
      customer = await this.findByPhone(input.phone);
    }
    if (!customer) {
      try {
        return await this.create(
          {
            name: input.name,
            phone: input.phone,
            email: input.email,
            addresses: [input.address],
          },
          input.source,
        );
      } catch (err) {
        // Another order created this customer a moment ago.
        if (err instanceof AppError && err.code === 'customer_phone_taken' && input.phone) {
          customer = await this.findByPhone(input.phone);
          if (!customer) throw err;
        } else throw err;
      }
    }
    if (!customer.addresses.some((a) => sameAddress(a, input.address))) {
      const addresses = [input.address, ...customer.addresses].slice(0, 10);
      customer = (await this.customers.findOneAndUpdate(
        { _id: customer._id },
        { $set: { addresses } },
      ))!;
    }
    return customer;
  }

  /** Recounts a customer's order numbers from their orders. */
  async refreshStats(customerId: Types.ObjectId): Promise<void> {
    const [row] = await this.orders.aggregate<{
      orders: number;
      delivered: number;
      cancelled: number;
      returned: number;
      spentMinor: number;
      lastOrderAt: Date | null;
    }>([
      { $match: { customerId } },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          returned: { $sum: { $cond: [{ $eq: ['$status', 'returned'] }, 1, 0] } },
          spentMinor: {
            $sum: { $cond: [{ $in: ['$status', ['cancelled', 'returned']] }, 0, '$totalMinor'] },
          },
          lastOrderAt: { $max: '$placedAt' },
        },
      },
    ]);
    await this.customers.updateOne(
      { _id: customerId },
      {
        $set: {
          stats: {
            orders: row?.orders ?? 0,
            delivered: row?.delivered ?? 0,
            cancelled: row?.cancelled ?? 0,
            returned: row?.returned ?? 0,
            spentMinor: row?.spentMinor ?? 0,
            ...(row?.lastOrderAt ? { lastOrderAt: row.lastOrderAt } : {}),
          },
        },
      },
    );
  }
}
