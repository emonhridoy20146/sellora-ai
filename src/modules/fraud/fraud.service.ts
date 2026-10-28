import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { hmacSha256 } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { nationalDigits } from '../../common/validation/schemas.js';
import { AppConfig } from '../../config/app-config.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import { CustomersService, type CustomerDoc } from '../commerce/customers.service.js';
import type { ParcelOutcomeEvent } from '../couriers/parcels.service.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import { assessRisk, type RiskAssessment } from './fraud-rules.js';
import type { DeliveryOutcome, FraudSettings } from './schemas.js';

@Injectable()
export class FraudSettingsRepository extends TenantScopedRepository<FraudSettings> {
  constructor(@InjectModel('FraudSettings') model: Model<FraudSettings>) {
    super(model);
  }
}

/** Why the network part of the check is on or off for this business. */
export type NetworkStatus = 'unavailable' | 'not_sharing' | 'on';

interface NetworkCounts {
  businesses: number;
  delivered: number;
  returned: number;
}

export interface FraudCheck extends RiskAssessment {
  phone: string;
  localPhone: string | null;
  customer: { id: string; name: string; blocked: boolean } | null;
  own: { orders: number; delivered: number; returned: number; cancelled: number };
  network: NetworkCounts | null;
  networkStatus: NetworkStatus;
}

const MAX_BATCH = 100;

/**
 * The fraud check before shipping: a customer's delivery record with this business, plus
 * (when the platform has it on and the business shares) courier-confirmed outcomes at other
 * businesses, keyed by a hash of the phone number. No courier "success rate" APIs are used:
 * none of the couriers publishes one.
 */
@Injectable()
export class FraudService {
  constructor(
    private readonly settingsRepo: FraudSettingsRepository,
    @InjectModel('DeliveryOutcome') private readonly outcomes: Model<DeliveryOutcome>,
    private readonly customers: CustomersService,
    private readonly platform: PlatformSettingsService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private phoneHash(e164: string): string {
    return hmacSha256(this.config.get('FRAUD_NETWORK_SECRET')!, `phone:${e164}`);
  }

  /** The network can run: switched on by the super-admin and keyed. */
  async networkAvailable(): Promise<boolean> {
    if (!this.config.get('FRAUD_NETWORK_SECRET')) return false;
    return (await this.platform.get()).fraudNetwork.enabled;
  }

  async settings(): Promise<WithId<FraudSettings>> {
    const existing = await this.settingsRepo.findOne({});
    if (existing) return existing;
    try {
      return await this.settingsRepo.create({ shareOutcomes: false });
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.settingsRepo.findOne({}))!;
      throw err;
    }
  }

  async settingsDto() {
    const s = await this.settings();
    return {
      shareOutcomes: s.shareOutcomes,
      sharedSince: s.sharedSince?.toISOString() ?? null,
      networkAvailable: await this.networkAvailable(),
    };
  }

  /** Starts or stops sharing. Stopping deletes everything this business shared. */
  async updateSettings(input: { shareOutcomes: boolean }) {
    const before = await this.settings();
    if (input.shareOutcomes && !(await this.networkAvailable()))
      throw AppError.unprocessable(
        'fraud_network_unavailable',
        'The Sellora delivery network is not switched on for this platform.',
      );
    if (input.shareOutcomes !== before.shareOutcomes) {
      await this.settingsRepo.updateOne(
        { _id: before._id },
        input.shareOutcomes
          ? { $set: { shareOutcomes: true, sharedSince: new Date() } }
          : { $set: { shareOutcomes: false }, $unset: { sharedSince: '' } },
      );
      let removed = 0;
      if (!input.shareOutcomes)
        removed = (
          await this.outcomes.deleteMany({ orgId: new Types.ObjectId(this.orgId()) }).exec()
        ).deletedCount;
      await this.audit.record({
        action: input.shareOutcomes ? 'fraud.sharing_started' : 'fraud.sharing_stopped',
        orgId: this.orgId(),
        target: { type: 'org', id: this.orgId() },
        metadata: input.shareOutcomes ? {} : { removedOutcomes: removed },
      });
    }
    return this.settingsDto();
  }

  private async networkStatus(): Promise<NetworkStatus> {
    if (!(await this.networkAvailable())) return 'unavailable';
    return (await this.settings()).shareOutcomes ? 'on' : 'not_sharing';
  }

  /** Counts at other businesses, by E.164 phone. */
  private async networkCounts(phones: string[]): Promise<Map<string, NetworkCounts>> {
    const byHash = new Map(phones.map((p) => [this.phoneHash(p), p]));
    const rows = await this.outcomes
      .aggregate<{ _id: string } & NetworkCounts>([
        {
          $match: {
            phoneHash: { $in: [...byHash.keys()] },
            orgId: { $ne: new Types.ObjectId(this.orgId()) },
          },
        },
        {
          $group: {
            _id: { h: '$phoneHash', o: '$orgId' },
            delivered: { $sum: { $cond: [{ $eq: ['$outcome', 'delivered'] }, 1, 0] } },
            returned: { $sum: { $cond: [{ $eq: ['$outcome', 'returned'] }, 1, 0] } },
          },
        },
        {
          $group: {
            _id: '$_id.h',
            businesses: { $sum: 1 },
            delivered: { $sum: '$delivered' },
            returned: { $sum: '$returned' },
          },
        },
      ])
      .exec();
    return new Map(
      rows.map((r) => [
        byHash.get(r._id)!,
        { businesses: r.businesses, delivered: r.delivered, returned: r.returned },
      ]),
    );
  }

  private result(
    phone: string,
    customer: CustomerDoc | undefined,
    network: NetworkCounts | null,
    networkStatus: NetworkStatus,
  ): FraudCheck {
    const own = {
      orders: customer?.stats.orders ?? 0,
      delivered: customer?.stats.delivered ?? 0,
      returned: customer?.stats.returned ?? 0,
      cancelled: customer?.stats.cancelled ?? 0,
    };
    return {
      phone,
      localPhone: nationalDigits(phone),
      customer: customer
        ? { id: customer._id.toHexString(), name: customer.name, blocked: customer.blocked }
        : null,
      own,
      network,
      networkStatus,
      ...assessRisk({ blocked: customer?.blocked ?? false, own, network }),
    };
  }

  private async normalize(raw: string, path: string): Promise<string> {
    const phone = await this.customers.normalizeOne(raw);
    if (!phone) throw AppError.validation([{ path, message: 'Invalid phone number' }]);
    return phone;
  }

  async check(rawPhone: string): Promise<FraudCheck> {
    const phone = await this.normalize(rawPhone, 'phone');
    const [customer, status] = await Promise.all([
      this.customers.findByPhone(phone),
      this.networkStatus(),
    ]);
    const network =
      status === 'on' ? ((await this.networkCounts([phone])).get(phone) ?? null) : null;
    return this.result(phone, customer ?? undefined, network, status);
  }

  /** Short results for many numbers at once (risk badges on the orders list). */
  async batch(rawPhones: string[]) {
    const phones: string[] = [];
    for (const [i, raw] of rawPhones.slice(0, MAX_BATCH).entries())
      phones.push(await this.normalize(raw, `phones.${i}`));
    const unique = [...new Set(phones)];
    const [customers, status] = await Promise.all([
      this.customers.findByPhones(unique),
      this.networkStatus(),
    ]);
    const network =
      status === 'on' ? await this.networkCounts(unique) : new Map<string, NetworkCounts>();
    const byPhone = new Map(customers.map((c) => [c.phone!, c]));
    return {
      networkStatus: status,
      items: unique.map((phone) => {
        const r = this.result(phone, byPhone.get(phone), network.get(phone) ?? null, status);
        return { phone, level: r.level, successRate: r.successRate, outcomes: r.outcomes };
      }),
    };
  }

  /** Records a courier-confirmed outcome when the business shares (runs in the worker or API). */
  async recordOutcome(e: ParcelOutcomeEvent): Promise<boolean> {
    if (!(await this.networkAvailable())) return false;
    return RequestContext.withTenant(e.orgId, async () => {
      if (!(await this.settings()).shareOutcomes) return false;
      await this.outcomes
        .updateOne(
          { _id: new Types.ObjectId(e.parcelId) },
          {
            $set: {
              phoneHash: this.phoneHash(e.phone),
              orgId: new Types.ObjectId(e.orgId),
              outcome: e.outcome,
              at: new Date(),
            },
          },
          { upsert: true },
        )
        .exec();
      return true;
    });
  }
}
