import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import { DEFAULT_PLANS } from './billing-defaults.js';
import {
  FEATURE_MODULES,
  LIMIT_KEYS,
  type BillingInterval,
  type PlanLimits,
} from './feature-modules.js';
import type { Plan, PlanPrice } from './schemas.js';

export type PlanDoc = WithId<Plan>;

export type PlanInput = Omit<Plan, 'version' | 'updatedBy'>;

export function toPlanDto(plan: PlanDoc, currency?: string) {
  const prices = currency ? plan.prices.filter((p) => p.currency === currency) : plan.prices;
  return {
    id: plan._id.toHexString(),
    code: plan.code,
    name: plan.name,
    description: plan.description,
    modules: plan.modules.map((key) => ({ key, name: FEATURE_MODULES[key].name })),
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, plan.limits?.[k] ?? null])) as PlanLimits,
    prices: prices.map((p) => ({
      interval: p.interval,
      currency: p.currency,
      amountMinor: p.amountMinor,
    })),
    includedCreditsPerMonth: plan.includedCreditsPerMonth,
    trialEligible: plan.trialEligible,
    highlight: plan.highlight,
    sortOrder: plan.sortOrder,
  };
}

export function toPlatformPlanDto(plan: PlanDoc) {
  return {
    ...toPlanDto(plan),
    isPublic: plan.isPublic,
    isActive: plan.isActive,
    version: plan.version,
    updatedAt: plan.updatedAt.toISOString(),
  };
}

export function priceFor(
  plan: Plan,
  interval: BillingInterval,
  currency: string,
): PlanPrice | undefined {
  return plan.prices.find((p) => p.interval === interval && p.currency === currency);
}

/** The plan catalogue. Plans are platform data edited by the super-admin. */
@Injectable()
export class PlansService {
  constructor(
    @InjectModel('Plan') private readonly plans: Model<Plan>,
    private readonly audit: AuditService,
  ) {}

  async seedDefaults(): Promise<void> {
    for (const plan of DEFAULT_PLANS) {
      await this.plans
        .updateOne({ code: plan.code }, { $setOnInsert: { ...plan, version: 1 } }, { upsert: true })
        .exec()
        .catch((err: unknown) => {
          if (!isDuplicateKey(err)) throw err;
        });
    }
  }

  async listPublic(): Promise<PlanDoc[]> {
    return this.plans
      .find({ isActive: true, isPublic: true })
      .sort({ sortOrder: 1, code: 1 })
      .lean<PlanDoc[]>()
      .exec();
  }

  async listAll(): Promise<PlanDoc[]> {
    return this.plans.find({}).sort({ sortOrder: 1, code: 1 }).lean<PlanDoc[]>().exec();
  }

  async findByCode(code: string): Promise<PlanDoc | null> {
    return this.plans.findOne({ code: code.toLowerCase() }).lean<PlanDoc>().exec();
  }

  async getByCode(code: string): Promise<PlanDoc> {
    const plan = await this.findByCode(code);
    if (!plan) throw AppError.notFound('plan');
    return plan;
  }

  private checkPrices(prices: PlanPrice[]): void {
    const seen = new Set<string>();
    for (const p of prices) {
      const key = `${p.interval}:${p.currency}`;
      if (seen.has(key))
        throw AppError.validation([
          { path: 'prices', message: `Duplicate price for ${p.interval} in ${p.currency}` },
        ]);
      seen.add(key);
    }
  }

  async create(input: PlanInput, actorId: string): Promise<PlanDoc> {
    this.checkPrices(input.prices);
    try {
      const [created] = await this.plans.create([{ ...input, version: 1, updatedBy: actorId }]);
      const doc = created!.toObject() as unknown as PlanDoc;
      await this.audit.record({
        action: 'platform.plan.created',
        target: { type: 'plan', id: doc._id.toHexString(), label: doc.code },
        metadata: { plan: toPlatformPlanDto(doc) },
      });
      return doc;
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('plan_code_taken', 'A plan with this code already exists.');
      throw err;
    }
  }

  /**
   * Edits a plan and bumps its version. Businesses already subscribed keep the snapshot they
   * bought (modules, limits, price) until their next change or renewal.
   */
  async update(
    code: string,
    patch: Partial<Omit<PlanInput, 'code'>>,
    actorId: string,
  ): Promise<PlanDoc> {
    const before = await this.getByCode(code);
    if (patch.prices) this.checkPrices(patch.prices);
    const set: Record<string, unknown> = { updatedBy: actorId };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
    if (patch.limits) {
      delete set.limits;
      for (const k of LIMIT_KEYS) if (k in patch.limits) set[`limits.${k}`] = patch.limits[k];
    }
    const after = await this.plans
      .findOneAndUpdate(
        { _id: before._id },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after', runValidators: true },
      )
      .lean<PlanDoc>()
      .exec();
    await this.audit.record({
      action: 'platform.plan.updated',
      target: { type: 'plan', id: before._id.toHexString(), label: before.code },
      metadata: { before: toPlatformPlanDto(before), after: toPlatformPlanDto(after!) },
    });
    return after!;
  }
}
