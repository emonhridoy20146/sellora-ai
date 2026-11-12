import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import type { OrderCoupon } from '../commerce/schemas.js';
import {
  codeProblem,
  COUPON_REASON_TEXT,
  couponAppliesAt,
  couponProblem,
  couponState,
  couponValue,
  MAX_COUPONS,
  MAX_PERCENT,
  normalizeCode,
  type CouponKind,
  type CouponLandingScope,
  type CouponOrder,
  type CouponPlace,
  type CouponReason,
  type CouponTerms,
} from './coupon-rules.js';
import { CouponRepository, CouponUseRepository } from './repositories.js';
import type { Coupon } from './schemas.js';

export type CouponDoc = WithId<Coupon>;

export interface CouponInput {
  code?: string;
  note?: string;
  kind?: CouponKind;
  percent?: number | null;
  amountMinor?: number | null;
  maxDiscountMinor?: number | null;
  minOrderMinor?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  store?: boolean;
  landing?: CouponLandingScope;
  landingPageIds?: string[];
  active?: boolean;
}

/** A coupon checked against an order, ready to be written on it. */
export interface AppliedCoupon {
  id: string;
  code: string;
  discountMinor: number;
  freeDelivery: boolean;
}

/** What a shopper is told when they press Apply. */
export type CouponCheck =
  | { valid: true; code: string; discountMinor: number; freeDelivery: boolean }
  | {
      valid: false;
      code: string;
      reason: CouponReason;
      message: string;
      minOrderMinor?: number;
      startsAt?: string;
    };

const terms = (c: CouponDoc): CouponTerms => ({
  active: c.active,
  kind: c.kind,
  percent: c.percent ?? null,
  amountMinor: c.amountMinor ?? null,
  maxDiscountMinor: c.maxDiscountMinor ?? null,
  minOrderMinor: c.minOrderMinor,
  startsAt: c.startsAt ?? null,
  endsAt: c.endsAt ?? null,
  usageLimit: c.usageLimit ?? null,
  used: c.used,
  store: c.store,
  landing: c.landing,
  landingPageIds: c.landingPageIds.map((i) => i.toHexString()),
});

/**
 * Discount codes (ADR 0031): the business makes them under Coupons in the dashboard; shoppers type
 * them at store checkout and in landing page order forms. The server always works out what
 * a code is worth; an order takes a use inside its own transaction, so a limited code can
 * never be used more often than allowed, and a cancelled or returned order gives it back.
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly coupons: CouponRepository,
    private readonly uses: CouponUseRepository,
    private readonly audit: AuditService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private target(c: Pick<CouponDoc, '_id' | 'code'>) {
    return { type: 'coupon', id: c._id.toHexString(), label: c.code };
  }

  toDto(c: CouponDoc, now = new Date()) {
    return {
      id: c._id.toHexString(),
      code: c.code,
      note: c.note,
      kind: c.kind,
      percent: c.percent ?? null,
      amountMinor: c.amountMinor ?? null,
      maxDiscountMinor: c.maxDiscountMinor ?? null,
      minOrderMinor: c.minOrderMinor,
      startsAt: c.startsAt?.toISOString() ?? null,
      endsAt: c.endsAt?.toISOString() ?? null,
      usageLimit: c.usageLimit ?? null,
      perCustomerLimit: c.perCustomerLimit ?? null,
      store: c.store,
      landing: c.landing,
      landingPageIds: c.landingPageIds.map((i) => i.toHexString()),
      active: c.active,
      used: c.used,
      discountGivenMinor: c.discountGivenMinor,
      state: couponState(terms(c), now),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- the business's side

  async list() {
    const items = await this.coupons.find({}, { sort: { createdAt: -1 } });
    const now = new Date();
    return { items: items.map((c) => this.toDto(c, now)), limit: MAX_COUPONS };
  }

  async get(id: string): Promise<CouponDoc> {
    const c = await this.coupons.findById(id);
    if (!c) throw AppError.notFound('coupon');
    return c;
  }

  /** The business's landing pages, to choose where a coupon works. */
  async landingPages() {
    const pages = await this.connection
      .collection('landing_pages')
      .find(
        { orgId: new Types.ObjectId(this.orgId()) },
        { projection: { name: 1, slug: 1 }, sort: { createdAt: -1 } },
      )
      .limit(200)
      .toArray();
    return pages.map((p) => ({ id: String(p._id), name: String(p.name), slug: String(p.slug) }));
  }

  /** Checks and shapes the fields; `before` is the coupon being changed. */
  private async fields(input: CouponInput, before?: CouponDoc) {
    const errors: FieldError[] = [];
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    const put = (key: string, value: unknown) => {
      if (value === null || value === undefined) unset[key] = '';
      else set[key] = value;
    };

    if (input.code !== undefined) {
      const code = normalizeCode(input.code);
      const problem = codeProblem(code);
      if (problem) errors.push({ path: 'code', message: problem });
      set.code = code;
    }
    if (input.note !== undefined) set.note = input.note.trim();

    const kind = input.kind ?? before?.kind;
    if (input.kind !== undefined) set.kind = input.kind;
    const percent = input.percent !== undefined ? input.percent : (before?.percent ?? null);
    const amount =
      input.amountMinor !== undefined ? input.amountMinor : (before?.amountMinor ?? null);
    const cap =
      input.maxDiscountMinor !== undefined
        ? input.maxDiscountMinor
        : (before?.maxDiscountMinor ?? null);
    if (kind === 'percent') {
      if (!percent || percent < 1 || percent > MAX_PERCENT)
        errors.push({ path: 'percent', message: `Take off between 1% and ${MAX_PERCENT}%` });
      put('percent', percent);
      put('maxDiscountMinor', cap);
      put('amountMinor', null);
    } else if (kind === 'amount') {
      if (!amount || amount < 1)
        errors.push({ path: 'amountMinor', message: 'Say how much it takes off' });
      put('amountMinor', amount);
      put('percent', null);
      put('maxDiscountMinor', null);
    } else if (kind === 'free_delivery') {
      put('percent', null);
      put('amountMinor', null);
      put('maxDiscountMinor', null);
    }

    if (input.minOrderMinor !== undefined) set.minOrderMinor = input.minOrderMinor;
    const date = (v: string | null | undefined) => (v ? new Date(v) : null);
    const startsAt =
      input.startsAt !== undefined ? date(input.startsAt) : (before?.startsAt ?? null);
    const endsAt = input.endsAt !== undefined ? date(input.endsAt) : (before?.endsAt ?? null);
    if (input.startsAt !== undefined) put('startsAt', startsAt);
    if (input.endsAt !== undefined) {
      put('endsAt', endsAt);
      if (endsAt && endsAt <= new Date())
        errors.push({ path: 'endsAt', message: 'The end must be in the future' });
    }
    if (startsAt && endsAt && endsAt <= startsAt)
      errors.push({ path: 'endsAt', message: 'The end must be after the start' });

    if (input.usageLimit !== undefined) {
      put('usageLimit', input.usageLimit);
      if (input.usageLimit !== null && before && input.usageLimit < before.used)
        errors.push({
          path: 'usageLimit',
          message: `It was already used ${before.used} times; the limit cannot be lower`,
        });
    }
    if (input.perCustomerLimit !== undefined) put('perCustomerLimit', input.perCustomerLimit);
    if (input.store !== undefined) set.store = input.store;
    if (input.landing !== undefined) set.landing = input.landing;
    if (input.landingPageIds !== undefined) {
      const ids = [...new Set(input.landingPageIds)];
      const found = ids.length
        ? await this.connection.collection('landing_pages').countDocuments({
            orgId: new Types.ObjectId(this.orgId()),
            _id: { $in: ids.map((i) => new Types.ObjectId(i)) },
          })
        : 0;
      if (found !== ids.length)
        errors.push({ path: 'landingPageIds', message: 'A chosen landing page no longer exists' });
      set.landingPageIds = ids.map((i) => new Types.ObjectId(i));
    }
    const landing = input.landing ?? before?.landing ?? 'all';
    const pageCount =
      input.landingPageIds !== undefined
        ? (set.landingPageIds as unknown[]).length
        : (before?.landingPageIds.length ?? 0);
    if (landing === 'chosen' && pageCount === 0)
      errors.push({ path: 'landingPageIds', message: 'Choose at least one landing page' });
    const store = input.store ?? before?.store ?? true;
    if (!store && landing === 'none')
      errors.push({ path: 'store', message: 'Let it work in the store or on landing pages' });
    if (input.active !== undefined) set.active = input.active;

    if (errors.length) throw AppError.validation(errors);
    return { set, unset };
  }

  async create(input: CouponInput & { code: string; kind: CouponKind }) {
    const count = await this.coupons.count();
    if (count >= MAX_COUPONS)
      throw AppError.conflict(
        'too_many_coupons',
        `A business can keep ${MAX_COUPONS} coupons. Remove old ones first.`,
      );
    const { set } = await this.fields(input);
    const actor = RequestContext.actor();
    let c: CouponDoc;
    try {
      c = await this.coupons.create({
        note: '',
        minOrderMinor: 0,
        store: true,
        landing: 'all',
        landingPageIds: [],
        active: true,
        used: 0,
        discountGivenMinor: 0,
        perCustomerLimit: 1,
        ...set,
        ...(actor.type === 'user' ? { createdBy: new Types.ObjectId(actor.id) } : {}),
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw this.codeTaken();
      throw err;
    }
    await this.audit.record({
      action: 'coupon.created',
      orgId: this.orgId(),
      target: this.target(c),
      metadata: { kind: c.kind },
    });
    return this.toDto(c);
  }

  private codeTaken() {
    return AppError.conflict('code_taken', 'Another coupon uses this code.', {
      errors: [{ path: 'code', message: 'Another coupon uses this code' }],
    });
  }

  async update(id: string, input: CouponInput) {
    const before = await this.get(id);
    if (input.code !== undefined && normalizeCode(input.code) !== before.code && before.used > 0)
      throw AppError.conflict(
        'coupon_used',
        'Orders already used this code, so it cannot be renamed. Make a new coupon instead.',
      );
    const { set, unset } = await this.fields(input, before);
    let after: CouponDoc | null;
    try {
      after = await this.coupons.findOneAndUpdate(
        { _id: before._id },
        {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
      );
    } catch (err) {
      if (isDuplicateKey(err)) throw this.codeTaken();
      throw err;
    }
    if (!after) throw AppError.notFound('coupon');
    await this.audit.record({
      action: 'coupon.updated',
      orgId: this.orgId(),
      target: this.target(after),
      metadata: { fields: Object.keys(input) },
    });
    return this.toDto(after);
  }

  /** Removes a coupon no order used; a used one can only be switched off (orders show it). */
  async remove(id: string): Promise<void> {
    const c = await this.get(id);
    if (c.used > 0)
      throw AppError.conflict(
        'coupon_used',
        'Orders used this coupon, so it stays for the record. Switch it off instead.',
      );
    await this.coupons.deleteOne({ _id: c._id, used: 0 });
    await this.uses.deleteMany({ couponId: c._id });
    await this.audit.record({
      action: 'coupon.deleted',
      orgId: this.orgId(),
      target: this.target(c),
    });
  }

  // ---------------------------------------------------------------- shoppers

  private async find(code: string): Promise<CouponDoc | null> {
    const normal = normalizeCode(code);
    if (codeProblem(normal)) return null;
    return this.coupons.findOne({ code: normal });
  }

  private async customerUses(c: CouponDoc, phone: string | undefined): Promise<number> {
    if (!phone) return 0;
    const u = await this.uses.findOne({ couponId: c._id, phone });
    return u?.count ?? 0;
  }

  private refusal(code: string, reason: CouponReason, c: CouponDoc | null): CouponCheck {
    return {
      valid: false,
      code: normalizeCode(code).slice(0, 20),
      reason,
      message: COUPON_REASON_TEXT[reason],
      ...(reason === 'min_order' && c ? { minOrderMinor: c.minOrderMinor } : {}),
      ...(reason === 'not_started' && c?.startsAt ? { startsAt: c.startsAt.toISOString() } : {}),
    };
  }

  /**
   * What a code takes off this order, or why it cannot be used. Runs in the shop's
   * business. `phone` (already normalized) adds the per-customer check when known.
   */
  async check(
    code: string,
    place: CouponPlace,
    order: CouponOrder,
    phone?: string,
    now = new Date(),
  ): Promise<CouponCheck> {
    const c = await this.find(code);
    if (!c) return this.refusal(code, 'invalid', null);
    const reason = couponProblem(terms(c), place, order, now);
    if (reason) return this.refusal(code, reason, c);
    if (c.perCustomerLimit && (await this.customerUses(c, phone)) >= c.perCustomerLimit)
      return this.refusal(code, 'customer_limit', c);
    const v = couponValue(terms(c), order);
    return { valid: true, code: c.code, ...v };
  }

  /**
   * Which of `codes` shoppers can use at `place` now or once they start: switched on, not
   * ended or used up, and valid there. For coupon banners on landing pages (ADR 0031).
   */
  async usableCodes(codes: string[], place: CouponPlace, now = new Date()): Promise<Set<string>> {
    if (codes.length === 0) return new Set();
    const found = await this.coupons.find({ code: { $in: codes.map(normalizeCode) } });
    return new Set(
      found
        .filter((c) => {
          const state = couponState(terms(c), now);
          return (state === 'active' || state === 'scheduled') && couponAppliesAt(terms(c), place);
        })
        .map((c) => c.code),
    );
  }

  /**
   * Whether any coupon works at `place` now, so the storefront shows a code box only when a
   * code could work there (ADR 0031).
   */
  async offeredAt(place: CouponPlace, now = new Date()): Promise<boolean> {
    const found = await this.coupons.find({ active: true }, { limit: MAX_COUPONS });
    return found.some(
      (c) => couponState(terms(c), now) === 'active' && couponAppliesAt(terms(c), place),
    );
  }

  /** Like `check`, but throws the shopper's reason as a 422 (`coupon_invalid`). */
  async prepare(
    code: string,
    place: CouponPlace,
    order: CouponOrder,
    phone: string,
  ): Promise<AppliedCoupon> {
    const result = await this.check(code, place, order, phone);
    if (!result.valid) throw this.invalid(result);
    const c = (await this.find(code))!;
    return {
      id: c._id.toHexString(),
      code: c.code,
      discountMinor: result.discountMinor,
      freeDelivery: result.freeDelivery,
    };
  }

  private invalid(result: Extract<CouponCheck, { valid: false }>) {
    return AppError.unprocessable('coupon_invalid', result.message, {
      reason: result.reason,
      errors: [{ path: 'couponCode', message: result.message }],
      ...(result.minOrderMinor !== undefined ? { minOrderMinor: result.minOrderMinor } : {}),
      ...(result.startsAt ? { startsAt: result.startsAt } : {}),
    });
  }

  /**
   * Takes one use of the coupon for an order. Call inside the order's transaction: when the
   * coupon was used up (or switched off, or the phone reached its limit) a moment ago, this
   * throws and the order is not made.
   */
  async redeem(applied: AppliedCoupon, phone: string | undefined): Promise<OrderCoupon> {
    const id = new Types.ObjectId(applied.id);
    const now = new Date();
    const taken = await this.coupons.findOneAndUpdate(
      {
        _id: id,
        active: true,
        $and: [
          { $or: [{ endsAt: { $exists: false } }, { endsAt: { $gt: now } }] },
          {
            $or: [{ usageLimit: { $exists: false } }, { $expr: { $lt: ['$used', '$usageLimit'] } }],
          },
        ],
      },
      { $inc: { used: 1, discountGivenMinor: applied.discountMinor } },
    );
    if (!taken)
      throw this.invalid({
        valid: false,
        code: applied.code,
        reason: 'used_up',
        message: COUPON_REASON_TEXT.used_up,
      });
    if (taken.perCustomerLimit && phone) {
      try {
        await this.uses.findOneAndUpdate(
          { couponId: id, phone, count: { $lt: taken.perCustomerLimit } },
          { $inc: { count: 1 } },
          { upsert: true },
        );
      } catch (err) {
        // The phone's record exists and is at the limit: the upsert tried to add a second.
        if (isDuplicateKey(err))
          throw this.invalid({
            valid: false,
            code: applied.code,
            reason: 'customer_limit',
            message: COUPON_REASON_TEXT.customer_limit,
          });
        throw err;
      }
    }
    return {
      id,
      code: taken.code,
      discountMinor: applied.discountMinor,
      freeDelivery: applied.freeDelivery,
    };
  }

  /** Gives a cancelled or returned order's use back. Call inside the status change. */
  async release(coupon: OrderCoupon, phone: string | undefined): Promise<void> {
    await this.coupons.updateOne(
      { _id: coupon.id, used: { $gt: 0 } },
      { $inc: { used: -1, discountGivenMinor: -coupon.discountMinor } },
    );
    if (phone)
      await this.uses.updateOne(
        { couponId: coupon.id, phone, count: { $gt: 0 } },
        { $inc: { count: -1 } },
      );
  }
}
