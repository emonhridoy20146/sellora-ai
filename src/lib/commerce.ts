import type { BadgeTone } from '@/components/ui/badge';
import type {
  Address,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  StockReason,
} from './api/types';

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  packed: { label: 'Packed', tone: 'info' },
  shipped: { label: 'Shipped', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  returned: { label: 'Returned', tone: 'danger' },
};

export const ORDER_STATUS_ORDER: OrderStatus[] = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
];

/** The button text for moving an order to a status. */
export const STATUS_ACTION: Record<OrderStatus, string> = {
  pending: 'Back to pending',
  confirmed: 'Confirm',
  packed: 'Mark packed',
  shipped: 'Mark shipped',
  delivered: 'Mark delivered',
  cancelled: 'Cancel order',
  returned: 'Mark returned',
};

export const PAYMENT_STATUS: Record<OrderPaymentStatus, { label: string; tone: BadgeTone }> = {
  unpaid: { label: 'Unpaid', tone: 'warning' },
  partial: { label: 'Part paid', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cod', label: 'Cash on delivery' },
  { value: 'bkash', label: 'bKash' },
  { value: 'nagad', label: 'Nagad' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];

export function paymentMethodLabel(m: PaymentMethod): string {
  return PAYMENT_METHODS.find((p) => p.value === m)?.label ?? m;
}

export const STOCK_REASON: Record<StockReason, string> = {
  initial: 'Opening stock',
  adjustment: 'Count correction',
  received: 'Goods received',
  damaged: 'Damaged or lost',
  order: 'Order',
  order_cancel: 'Order cancelled',
  order_edit: 'Order edited',
  return: 'Returned',
};

/** One line per address part, empty parts left out. */
export function addressLines(a: Address): string[] {
  const place = [a.area, a.city, a.district].filter(Boolean).join(', ');
  return [a.line1, [place, a.postcode].filter(Boolean).join(' ')].filter(Boolean);
}

/**
 * Every combination of option values, in option order: Size [S, M] x Colour [Red] gives
 * [S, Red], [M, Red]. A product without options has one empty combination.
 */
export function combinations(options: { values: string[] }[]): string[][] {
  return options.reduce<string[][]>(
    (acc, o) => acc.flatMap((combo) => o.values.map((v) => [...combo, v])),
    [[]],
  );
}

export function comboKey(values: string[]): string {
  return values.map((v) => v.trim().toLowerCase()).join('\u0000');
}

/** Splits "S, M , L" into clean, unique values. */
export function splitValues(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const v = raw.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

export interface CartLine {
  unitPriceMinor: number;
  quantity: number;
}

/** The same arithmetic the API uses, so the new-order screen shows the final total. */
export function orderTotals(lines: CartLine[], discountMinor: number, deliveryMinor: number) {
  const subtotalMinor = lines.reduce((a, l) => a + l.unitPriceMinor * l.quantity, 0);
  return {
    subtotalMinor,
    discountMinor,
    deliveryChargeMinor: deliveryMinor,
    totalMinor: Math.max(0, subtotalMinor - discountMinor) + deliveryMinor,
    discountTooLarge: discountMinor > subtotalMinor,
  };
}
