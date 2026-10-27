import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { mulDiv } from '../../common/money/money.js';
import { CounterService } from '../../infra/database/counter.service.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { Organization } from '../orgs/schemas.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import type { Invoice } from './payment-schemas.js';

export type InvoiceDoc = WithId<Invoice>;

@Injectable()
export class InvoiceRepository extends TenantScopedRepository<Invoice> {
  constructor(@InjectModel('Invoice') model: Model<Invoice>) {
    super(model);
  }
}

export interface IssueInvoiceInput {
  kind: Invoice['kind'];
  currency: string;
  lines: { description: string; quantity: number; unitMinor: number }[];
  paidWith: Invoice['paidWith'];
  paymentId?: Types.ObjectId;
}

export function toInvoiceDto(inv: InvoiceDoc, taxLabel = 'VAT') {
  return {
    id: inv._id.toHexString(),
    number: inv.number,
    kind: inv.kind,
    currency: inv.currency,
    lines: inv.lines,
    subtotalMinor: inv.subtotalMinor,
    taxMinor: inv.taxMinor,
    taxRateBps: inv.taxRateBps,
    taxLabel,
    totalMinor: inv.totalMinor,
    paidWith: inv.paidWith,
    issuedAt: inv.issuedAt.toISOString(),
    billTo: inv.billTo,
  };
}

/**
 * Receipts for everything a business pays the platform. Prices are tax-inclusive: the tax
 * share is carved out of the total at the platform's configured rate. Numbers come from a
 * yearly sequence (INV-2026-000001); a rolled-back transaction can leave a gap.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly invoices: InvoiceRepository,
    private readonly counters: CounterService,
    private readonly settings: PlatformSettingsService,
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
  ) {}

  async issue(input: IssueInvoiceInput): Promise<InvoiceDoc> {
    const orgId = RequestContext.tenant()!.orgId;
    const org = await this.orgs
      .findById(orgId, { name: 1, legalName: 1, contact: 1 })
      .lean()
      .exec();
    const { taxRateBps } = (await this.settings.get()).billing;
    const lines = input.lines.map((l) => ({ ...l, totalMinor: l.unitMinor * l.quantity }));
    const totalMinor = lines.reduce((a, l) => a + l.totalMinor, 0);
    const taxMinor = taxRateBps > 0 ? mulDiv(totalMinor, taxRateBps, 10_000 + taxRateBps) : 0;
    const year = new Date().getUTCFullYear();
    const seq = await this.counters.next(`invoice:${year}`, 0);
    return this.invoices.create({
      number: `INV-${year}-${String(seq).padStart(6, '0')}`,
      kind: input.kind,
      currency: input.currency,
      lines,
      subtotalMinor: totalMinor - taxMinor,
      taxMinor,
      taxRateBps,
      totalMinor,
      paidWith: input.paidWith,
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      issuedAt: new Date(),
      billTo: {
        name: org?.legalName ?? org?.name ?? 'Customer',
        ...(org?.contact?.email ? { email: org.contact.email } : {}),
        ...(org?.contact?.address ? { address: org.contact.address } : {}),
      },
    });
  }

  list(q: { limit: number; cursor?: string }) {
    return this.invoices.paginate({}, q);
  }

  async get(id: string): Promise<InvoiceDoc | null> {
    return this.invoices.findById(id);
  }
}
