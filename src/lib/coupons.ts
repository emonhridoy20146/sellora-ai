import type { Coupon, CouponKind, CouponLandingScope, CouponState } from './api/types';
import { formatMoney, fromLocalInput, minorToInput, parseMoney, toLocalInput } from './format';
import { couponCodeProblem, normalizeCouponCode } from './landing';

/** Coupons (ADR 0031): the business's codes for the store checkout and landing pages. */

export const MAX_COUPON_PERCENT = 90;

export const COUPON_STATE: Record<
  CouponState,
  { label: string; tone: 'success' | 'info' | 'neutral' | 'warning' }
> = {
  active: { label: 'Active', tone: 'success' },
  scheduled: { label: 'Starts later', tone: 'info' },
  ended: { label: 'Ended', tone: 'neutral' },
  used_up: { label: 'Used up', tone: 'warning' },
  off: { label: 'Off', tone: 'neutral' },
};

export const COUPON_KIND_LABEL: Record<CouponKind, string> = {
  percent: 'Percent off',
  amount: 'Amount off',
  free_delivery: 'Free delivery',
};

/** "15% off (up to ৳500)", "৳200 off" or "Free delivery", plus the smallest order. */
export function couponValueText(
  c: Pick<Coupon, 'kind' | 'percent' | 'amountMinor' | 'maxDiscountMinor' | 'minOrderMinor'>,
  currency: string,
): string {
  const value =
    c.kind === 'percent'
      ? `${c.percent ?? 0}% off${c.maxDiscountMinor ? ` (up to ${formatMoney(c.maxDiscountMinor, currency)})` : ''}`
      : c.kind === 'amount'
        ? `${formatMoney(c.amountMinor ?? 0, currency)} off`
        : 'Free delivery';
  return c.minOrderMinor > 0
    ? `${value} on orders of ${formatMoney(c.minOrderMinor, currency)} or more`
    : value;
}

/** Where shoppers can use it, in a few words. */
export function couponWhereText(
  c: Pick<Coupon, 'store' | 'landing' | 'landingPageIds'>,
  pages: { id: string; name: string }[] = [],
): string {
  const landing =
    c.landing === 'all'
      ? 'all landing pages'
      : c.landing === 'chosen'
        ? c.landingPageIds.length === 1
          ? (pages.find((p) => p.id === c.landingPageIds[0])?.name ?? '1 landing page')
          : `${c.landingPageIds.length} landing pages`
        : null;
  if (c.store && landing) return `Store and ${landing}`;
  if (c.store) return 'Store only';
  return landing ? landing[0]!.toUpperCase() + landing.slice(1) : 'Nowhere';
}

/** The coupon form as typed: money as text, times as datetime-local values. */
export interface CouponForm {
  code: string;
  note: string;
  kind: CouponKind;
  percent: string;
  amount: string;
  maxDiscount: string;
  minOrder: string;
  startsAt: string;
  endsAt: string;
  usageLimit: string;
  perCustomerLimit: string;
  store: boolean;
  landing: CouponLandingScope;
  landingPageIds: string[];
  active: boolean;
}

export function emptyCouponForm(): CouponForm {
  return {
    code: '',
    note: '',
    kind: 'percent',
    percent: '10',
    amount: '',
    maxDiscount: '',
    minOrder: '',
    startsAt: '',
    endsAt: '',
    usageLimit: '',
    perCustomerLimit: '1',
    store: true,
    landing: 'all',
    landingPageIds: [],
    active: true,
  };
}

export function couponToForm(c: Coupon, currency: string): CouponForm {
  const money = (m: number | null) => (m ? minorToInput(m, currency) : '');
  return {
    code: c.code,
    note: c.note,
    kind: c.kind,
    percent: c.percent ? String(c.percent) : '',
    amount: money(c.amountMinor),
    maxDiscount: money(c.maxDiscountMinor),
    minOrder: money(c.minOrderMinor),
    startsAt: toLocalInput(c.startsAt),
    endsAt: toLocalInput(c.endsAt),
    usageLimit: c.usageLimit ? String(c.usageLimit) : '',
    perCustomerLimit: c.perCustomerLimit ? String(c.perCustomerLimit) : '',
    store: c.store,
    landing: c.landing,
    landingPageIds: c.landingPageIds,
    active: c.active,
  };
}

/** The API body the form stands for. */
export interface CouponBody {
  code: string;
  note: string;
  kind: CouponKind;
  percent: number | null;
  amountMinor: number | null;
  maxDiscountMinor: number | null;
  minOrderMinor: number;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  store: boolean;
  landing: CouponLandingScope;
  landingPageIds: string[];
  active: boolean;
}

/** A whole number from 1 up to `max`, or null when empty; NaN when not one. */
function count(v: string, max: number): number | null {
  if (!v.trim()) return null;
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 1 && n <= max ? n : Number.NaN;
}

/**
 * Checks the form the way the API does and builds the body. Errors are keyed by the API's
 * field names so server errors land on the same fields.
 */
export function couponFormToBody(
  f: CouponForm,
  currency: string,
  opts: { now?: number; savedEndsAt?: string | null } = {},
): { body: CouponBody | null; errors: Record<string, string> } {
  const now = opts.now ?? Date.now();
  const errors: Record<string, string> = {};
  const code = normalizeCouponCode(f.code);
  const codeProblem = couponCodeProblem(code);
  if (codeProblem) errors.code = codeProblem;

  let percent: number | null = null;
  let amountMinor: number | null = null;
  let maxDiscountMinor: number | null = null;
  if (f.kind === 'percent') {
    percent = count(f.percent, MAX_COUPON_PERCENT);
    if (percent === null || Number.isNaN(percent))
      errors.percent = `Take off between 1% and ${MAX_COUPON_PERCENT}%.`;
    if (f.maxDiscount.trim()) {
      maxDiscountMinor = parseMoney(f.maxDiscount, currency);
      if (!maxDiscountMinor) errors.maxDiscountMinor = 'Enter an amount, or leave it empty.';
    }
  } else if (f.kind === 'amount') {
    amountMinor = parseMoney(f.amount, currency);
    if (!amountMinor) errors.amountMinor = 'Say how much it takes off.';
  }
  const minOrderMinor = f.minOrder.trim() ? parseMoney(f.minOrder, currency) : 0;
  if (minOrderMinor === null) errors.minOrderMinor = 'Enter an amount, or leave it empty.';

  const startsAt = fromLocalInput(f.startsAt);
  const endsAt = fromLocalInput(f.endsAt);
  if (f.startsAt && !startsAt) errors.startsAt = 'Choose a date and time.';
  if (f.endsAt && !endsAt) errors.endsAt = 'Choose a date and time.';
  else if (endsAt && startsAt && Date.parse(endsAt) <= Date.parse(startsAt))
    errors.endsAt = 'The end must be after the start.';
  else if (
    endsAt &&
    Date.parse(endsAt) <= now &&
    // An ended coupon may be changed without moving its end.
    !(opts.savedEndsAt && toIsoMinute(opts.savedEndsAt) === toIsoMinute(endsAt))
  )
    errors.endsAt = 'The end must be in the future.';

  const usageLimit = count(f.usageLimit, 1_000_000);
  if (Number.isNaN(usageLimit)) errors.usageLimit = 'A whole number, or empty for no limit.';
  const perCustomerLimit = count(f.perCustomerLimit, 1000);
  if (Number.isNaN(perCustomerLimit))
    errors.perCustomerLimit = 'A whole number up to 1,000, or empty for no limit.';

  if (f.landing === 'chosen' && f.landingPageIds.length === 0)
    errors.landingPageIds = 'Choose at least one landing page.';
  if (!f.store && f.landing === 'none')
    errors.store = 'Let it work in the store or on landing pages.';

  if (Object.keys(errors).length) return { body: null, errors };
  return {
    body: {
      code,
      note: f.note.trim(),
      kind: f.kind,
      percent,
      amountMinor,
      maxDiscountMinor,
      minOrderMinor: minOrderMinor ?? 0,
      startsAt,
      endsAt,
      usageLimit,
      perCustomerLimit,
      store: f.store,
      landing: f.landing,
      landingPageIds: f.landing === 'chosen' ? f.landingPageIds : [],
      active: f.active,
    },
    errors,
  };
}

/** Only the fields that differ from the coupon as saved (an ended coupon keeps its end). */
export function couponChanges(before: Coupon, body: CouponBody): Partial<CouponBody> {
  const out: Partial<CouponBody> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const was: CouponBody = {
    code: before.code,
    note: before.note,
    kind: before.kind,
    percent: before.percent,
    amountMinor: before.amountMinor,
    maxDiscountMinor: before.maxDiscountMinor,
    minOrderMinor: before.minOrderMinor,
    startsAt: before.startsAt ? toIsoMinute(before.startsAt) : null,
    endsAt: before.endsAt ? toIsoMinute(before.endsAt) : null,
    usageLimit: before.usageLimit,
    perCustomerLimit: before.perCustomerLimit,
    store: before.store,
    landing: before.landing,
    landingPageIds: before.landingPageIds,
    active: before.active,
  };
  for (const k of Object.keys(body) as (keyof CouponBody)[]) {
    const v =
      k === 'startsAt' || k === 'endsAt' ? (body[k] ? toIsoMinute(body[k]) : null) : body[k];
    if (!same(v, was[k])) (out as Record<string, unknown>)[k] = body[k];
  }
  return out;
}

/** An ISO time cut to the minute, as a datetime-local input keeps it. */
function toIsoMinute(iso: string): string {
  const d = new Date(iso);
  d.setSeconds(0, 0);
  return d.toISOString();
}
