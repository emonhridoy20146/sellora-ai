import type { Dictionary } from './i18n';
import type {
  AdvanceRule,
  CheckoutPayments,
  LandingPayments,
  ReceiptPayment,
  ReturnState,
  ShopGatewayKey,
} from './types';

/** The shopper's choice, as the API takes it. */
export interface PaymentPick {
  method: 'cod' | 'online';
  gateway: ShopGatewayKey | null;
}

/**
 * The advance asked on a cash on delivery order, the same rule the API applies (ADR 0029).
 * The API works it out again when the order is placed; this is only for showing it.
 */
export function advanceFor(
  advance: AdvanceRule | null,
  cart: { totalMinor: number; deliveryChargeMinor: number; zoneId: string | null },
): number {
  if (!advance || cart.totalMinor <= 0) return 0;
  if (advance.zoneIds.length && (!cart.zoneId || !advance.zoneIds.includes(cart.zoneId))) return 0;
  if (advance.minTotalMinor > 0 && cart.totalMinor < advance.minTotalMinor) return 0;
  const raw =
    advance.mode === 'delivery'
      ? cart.deliveryChargeMinor
      : advance.mode === 'fixed'
        ? advance.fixedMinor
        : Math.ceil((cart.totalMinor * advance.percent) / 100 / 100) * 100;
  return Math.max(0, Math.min(cart.totalMinor, Math.round(raw)));
}

/** A landing page's rules for one filled-in form, in the shape the store checkout gets. */
export function landingOptions(
  rules: LandingPayments | undefined,
  cart: { totalMinor: number; deliveryChargeMinor: number; zoneId: string | null },
): CheckoutPayments {
  if (!rules?.gateways.length)
    return { cod: true, fullOnline: false, gateways: [], advanceMinor: 0 };
  return {
    cod: rules.cod,
    fullOnline: rules.fullOnline,
    gateways: rules.gateways,
    advanceMinor: rules.cod ? advanceFor(rules.advance, cart) : 0,
  };
}

/** The choice to show first: cash on delivery when the shop takes it, and the first gateway. */
export function firstPick(o: CheckoutPayments | undefined): PaymentPick {
  return {
    method: o && !o.cod && o.fullOnline ? 'online' : 'cod',
    gateway: o?.gateways[0]?.key ?? null,
  };
}

/** The pick, kept valid as the options change (a gateway switched off, COD turned off). */
export function validPick(pick: PaymentPick, o: CheckoutPayments | undefined): PaymentPick {
  if (!o?.gateways.length) return { method: 'cod', gateway: null };
  const method =
    pick.method === 'online' ? (o.fullOnline ? 'online' : 'cod') : o.cod ? 'cod' : 'online';
  const gateway = o.gateways.some((g) => g.key === pick.gateway)
    ? pick.gateway
    : o.gateways[0]!.key;
  return { method, gateway };
}

/** What is paid online when the order is placed with this pick; 0 for plain cash on delivery. */
export function payingNow(pick: PaymentPick, o: CheckoutPayments | undefined, totalMinor: number) {
  if (!o?.gateways.length) return 0;
  return pick.method === 'online' ? totalMinor : o.advanceMinor;
}

/** The body's `payment`: a gateway goes along whenever there is one, so an advance never lacks it. */
export function paymentBody(pick: PaymentPick, o: CheckoutPayments | undefined) {
  if (!o?.gateways.length) return undefined;
  return { method: pick.method, ...(pick.gateway ? { gateway: pick.gateway } : {}) };
}

export function isReturnState(v: unknown): v is ReturnState {
  return (
    v === 'paid' || v === 'pending' || v === 'failed' || v === 'cancelled' || v === 'unstarted'
  );
}

/** How the order is paid, in the shop's language. */
export function paymentLabel(
  r: { paymentMethod: string; payment?: ReceiptPayment | undefined },
  t: Dictionary,
): string {
  const online = r.payment?.online;
  if (online?.status === 'paid')
    return online.purpose === 'advance'
      ? `${t.cod} · ${t.advancePaid(online.gatewayName)}`
      : t.paidOnline(online.gatewayName);
  if (online?.purpose === 'full') return `${t.methodOnline} · ${online.gatewayName}`;
  if (r.paymentMethod === 'cod') return t.cod;
  if (r.paymentMethod === 'online') return t.methodOnline;
  return r.paymentMethod;
}

/** The message at the top of the receipt after the gateway sent the shopper back. */
export function returnMessage(
  state: ReturnState | null,
  payment: ReceiptPayment | undefined,
  t: Dictionary,
): { tone: 'good' | 'wait' | 'bad'; text: string } | null {
  if (!payment?.online || !state) return null;
  // What the order says wins over what the address says.
  if (payment.online.status === 'paid') return { tone: 'good', text: t.paymentPaid };
  if (state === 'pending' || state === 'paid') return { tone: 'wait', text: t.paymentPending };
  if (!payment.payNow) return null;
  if (state === 'cancelled') return { tone: 'bad', text: t.paymentCancelled };
  if (state === 'unstarted') return { tone: 'bad', text: t.paymentUnstarted };
  return { tone: 'bad', text: t.paymentFailed };
}
