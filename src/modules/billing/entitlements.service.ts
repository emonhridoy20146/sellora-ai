import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import { Types, type Model } from 'mongoose';
import { AppError } from '../../common/errors/app-error.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import { FREE_PLAN_CODE } from './billing-defaults.js';
import {
  FEATURE_MODULES,
  LIMIT_KEYS,
  type FeatureModule,
  type LimitKey,
  type PlanLimits,
} from './feature-modules.js';
import type { Plan, Subscription, SubscriptionStatus } from './schemas.js';

const CACHE_TTL_SECONDS = 60;
const DAY_MS = 24 * 3600_000;

interface CachedSnapshot {
  subscription: {
    planCode: string;
    planName: string;
    status: SubscriptionStatus;
    modules: FeatureModule[];
    limits: PlanLimits;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    overrides: {
      addModules: FeatureModule[];
      removeModules: FeatureModule[];
      limits: Partial<PlanLimits>;
      expiresAt: string | null;
    };
  } | null;
  free: { planCode: string; planName: string; modules: FeatureModule[]; limits: PlanLimits } | null;
}

export interface Entitlements {
  planCode: string | null;
  planName: string | null;
  status: SubscriptionStatus | 'none';
  /** False when the paid period or trial has ended and the business runs on the free plan. */
  paidAccess: boolean;
  inGracePeriod: boolean;
  modules: FeatureModule[];
  limits: PlanLimits;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

const ZERO_LIMITS = Object.fromEntries(LIMIT_KEYS.map((k) => [k, 0])) as PlanLimits;

function normaliseLimits(limits: Partial<PlanLimits> | undefined): PlanLimits {
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits?.[k] ?? null])) as PlanLimits;
}

/**
 * What a business may use right now: modules and numeric limits from its subscription
 * snapshot, adjusted by super-admin overrides, falling back to the free plan when a trial
 * or paid period has ended. Evaluated against the clock on every call, so access ends on
 * time even if the renewal job is late.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @InjectModel('Subscription') private readonly subscriptions: Model<Subscription>,
    @InjectModel('Plan') private readonly plans: Model<Plan>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settings: PlatformSettingsService,
  ) {}

  private key(orgId: string) {
    return `ent:${orgId}`;
  }

  async invalidate(orgId: string): Promise<void> {
    await this.redis.del(this.key(orgId));
  }

  private async snapshot(orgId: string): Promise<CachedSnapshot> {
    const cached = await this.redis.get(this.key(orgId));
    if (cached) return JSON.parse(cached) as CachedSnapshot;
    const [sub, free] = await Promise.all([
      this.subscriptions
        .findOne({ orgId: new Types.ObjectId(orgId) }, null, { [CROSS_TENANT]: true })
        .lean()
        .exec(),
      this.plans.findOne({ code: FREE_PLAN_CODE, isActive: true }).lean().exec(),
    ]);
    const snap: CachedSnapshot = {
      subscription: sub
        ? {
            planCode: sub.planCode,
            planName: sub.planName,
            status: sub.status,
            modules: sub.modules,
            limits: normaliseLimits(sub.limits),
            trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
            currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
            overrides: {
              addModules: sub.overrides?.addModules ?? [],
              removeModules: sub.overrides?.removeModules ?? [],
              limits: Object.fromEntries(
                Object.entries(sub.overrides?.limits ?? {}).filter(
                  ([, v]) => v !== null && v !== undefined,
                ),
              ),
              expiresAt: sub.overrides?.expiresAt?.toISOString() ?? null,
            },
          }
        : null,
      free: free
        ? {
            planCode: free.code,
            planName: free.name,
            modules: free.modules,
            limits: normaliseLimits(free.limits),
          }
        : null,
    };
    await this.redis.set(this.key(orgId), JSON.stringify(snap), 'EX', CACHE_TTL_SECONDS);
    return snap;
  }

  async forOrg(orgId: string, now = new Date()): Promise<Entitlements> {
    const snap = await this.snapshot(orgId);
    const sub = snap.subscription;
    const { graceDays } = (await this.settings.get()).billing;

    let base: {
      planCode: string | null;
      planName: string | null;
      modules: FeatureModule[];
      limits: PlanLimits;
    } = snap.free
      ? { ...snap.free }
      : { planCode: null, planName: null, modules: [], limits: ZERO_LIMITS };
    let paidAccess = false;
    let inGracePeriod = false;

    if (sub && sub.status !== 'canceled' && sub.status !== 'expired') {
      const end = sub.status === 'trialing' ? sub.trialEndsAt : sub.currentPeriodEnd;
      const endMs = end ? Date.parse(end) : Number.POSITIVE_INFINITY;
      // Trials end sharply; paid periods get the grace window while renewal is retried.
      const graceMs = sub.status === 'trialing' ? 0 : graceDays * DAY_MS;
      if (now.getTime() < endMs + graceMs) {
        base = {
          planCode: sub.planCode,
          planName: sub.planName,
          modules: sub.modules,
          limits: sub.limits,
        };
        paidAccess = true;
        inGracePeriod = now.getTime() >= endMs || sub.status === 'past_due';
      }
    }

    const modules = new Set<FeatureModule>(base.modules);
    let limits = { ...base.limits };
    const overrides = sub?.overrides;
    if (overrides && (!overrides.expiresAt || Date.parse(overrides.expiresAt) > now.getTime())) {
      overrides.addModules.forEach((m) => modules.add(m));
      overrides.removeModules.forEach((m) => modules.delete(m));
      limits = { ...limits, ...overrides.limits };
    }

    return {
      planCode: base.planCode,
      planName: base.planName,
      status: sub?.status ?? 'none',
      paidAccess,
      inGracePeriod,
      modules: (Object.keys(FEATURE_MODULES) as FeatureModule[]).filter((m) => modules.has(m)),
      limits,
      trialEndsAt: sub?.trialEndsAt ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    };
  }

  async hasModule(orgId: string, module: FeatureModule): Promise<boolean> {
    return (await this.forOrg(orgId)).modules.includes(module);
  }

  async assertModules(orgId: string, required: FeatureModule[]): Promise<void> {
    if (required.length === 0) return;
    const ent = await this.forOrg(orgId);
    const missing = required.filter((m) => !ent.modules.includes(m));
    if (missing.length) {
      throw AppError.paymentRequired(
        'module_not_in_plan',
        `Your plan does not include ${missing.map((m) => FEATURE_MODULES[m].name).join(', ')}. Upgrade to use it.`,
        {
          modules: missing,
          planCode: ent.planCode,
        },
      );
    }
  }

  /** Throws 402 when adding one more item would pass the plan limit. */
  async assertWithinLimit(orgId: string, key: LimitKey, currentCount: number): Promise<void> {
    const ent = await this.forOrg(orgId);
    const limit = ent.limits[key];
    if (limit !== null && currentCount >= limit) {
      throw AppError.paymentRequired(
        'plan_limit_reached',
        `Your plan allows ${limit} ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}. Upgrade to add more.`,
        {
          limit: key,
          max: limit,
          current: currentCount,
          planCode: ent.planCode,
        },
      );
    }
  }
}
