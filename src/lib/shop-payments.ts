import type { BadgeTone } from '@/components/ui/badge';
import type {
  OnlinePaymentAttempt,
  OrderOnlinePayment,
  ShopGatewayKey,
  ShopPaymentSettings,
} from './api/types';

export const SHOP_GATEWAY_NAME: Record<ShopGatewayKey, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  sslcommerz: 'SSLCommerz',
  aamarpay: 'aamarPay',
  shurjopay: 'shurjoPay',
};

/** The order's online payment in a few words, for badges on the order list and page. */
export function onlinePaymentBadge(o: OrderOnlinePayment): { label: string; tone: BadgeTone } {
  const what = o.purpose === 'advance' ? 'Advance' : 'Online payment';
  // A sandbox payment moves no real money, so it never looks like money received.
  const test = o.sandbox ? ' (test)' : '';
  if (o.status === 'paid')
    return {
      label: `${o.purpose === 'advance' ? 'Advance paid' : 'Paid online'}${test}`,
      tone: o.sandbox ? 'outline' : 'success',
    };
  if (o.status === 'failed') return { label: `${what} not paid${test}`, tone: 'danger' };
  return { label: `${what} awaited${test}`, tone: 'warning' };
}

export const ATTEMPT_STATUS: Record<
  OnlinePaymentAttempt['status'],
  { label: string; tone: BadgeTone }
> = {
  started: { label: 'Waiting for the shopper', tone: 'warning' },
  succeeded: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** A percent from 0 to 100 typed in a box; null when it is not one. */
export function percentInput(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Keys left empty. Editing an account: all empty keeps the saved keys, otherwise all are needed. */
export function missingKeys(
  fields: { key: string }[],
  values: Record<string, string>,
  editing: boolean,
): string[] {
  const empty = fields.filter((f) => !(values[f.key] ?? '').trim()).map((f) => f.key);
  if (editing && empty.length === fields.length) return [];
  return empty;
}

/**
 * The advance asked on a cash on delivery order, the same rule the API applies (ADR 0029):
 * the delivery charge, a fixed amount or a percent rounded up to whole taka, never more than
 * the total, and nothing outside the chosen delivery areas or under the minimum total.
 */
export function advanceFor(
  advance: ShopPaymentSettings['advance'],
  cart: { totalMinor: number; deliveryChargeMinor: number; zoneId: string | null },
): number {
  if (advance.mode === 'off' || cart.totalMinor <= 0) return 0;
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

/** Why a try did not go through, in words; the gateway's own code when Sellora has none. */
export function attemptReason(reason: string): string {
  if (reason === 'shopper_cancelled') return 'The shopper cancelled on the payment page.';
  if (reason === 'amount_mismatch')
    return 'The gateway reported a different amount, so it was not counted. See the activity log.';
  if (reason === 'expired') return 'The gateway gave no final answer within two days.';
  if (/_wrong_(payment|reference|order)$/.test(reason))
    return 'The shopper came back with another payment’s details.';
  if (/_(cancel|cancelled|aborted)$/.test(reason) || reason === 'shurjopay_1002')
    return 'Cancelled at the gateway.';
  if (/_(failed|failure|fail)$/.test(reason) || reason === 'shurjopay_1001')
    return 'The gateway declined the payment.';
  return /^[a-z0-9_]+$/.test(reason) ? `Gateway code: ${reason}` : reason;
}
