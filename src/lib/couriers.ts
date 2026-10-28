import type { BadgeTone } from '@/components/ui/badge';
import type {
  CourierDescriptor,
  Order,
  ParcelEventSource,
  RiskLevel,
  ShipmentFilter,
  ShipmentStatus,
} from './api/types';

export const SHIPMENT_STATUS: Record<ShipmentStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: 'Waiting to send', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'warning' },
  booked: { label: 'Booked', tone: 'info' },
  picked_up: { label: 'Picked up', tone: 'info' },
  in_transit: { label: 'On the way', tone: 'info' },
  on_hold: { label: 'On hold', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  partly_delivered: { label: 'Partly delivered', tone: 'warning' },
  returning: { label: 'Coming back', tone: 'danger' },
  returned: { label: 'Returned', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Not booked', tone: 'danger' },
};

/** Statuses in the order a parcel usually moves through them (for filters). */
export const SHIPMENT_STATUS_ORDER: ShipmentStatus[] = [
  'queued',
  'sending',
  'booked',
  'picked_up',
  'in_transit',
  'on_hold',
  'delivered',
  'partly_delivered',
  'returning',
  'returned',
  'cancelled',
  'failed',
];

/** Waiting for the courier to take it: the order cannot be cancelled or edited meanwhile. */
export const SHIPMENT_IN_PROGRESS: ShipmentStatus[] = ['queued', 'sending', 'booked'];

/** Statuses that end a booking without the parcel going anywhere: the order can go again. */
export const SHIPMENT_ENDED_UNSENT: ShipmentStatus[] = ['failed', 'cancelled'];

export const SHIPMENT_FILTERS: { value: ShipmentFilter | ''; label: string }[] = [
  { value: '', label: 'Any courier status' },
  { value: 'ready', label: 'Ready to send' },
  { value: 'none', label: 'Not sent to a courier' },
  { value: 'attention', label: 'Courier needs a look' },
  ...SHIPMENT_STATUS_ORDER.filter((s) => s !== 'queued').map((s) => ({
    value: s,
    label: SHIPMENT_STATUS[s].label,
  })),
];

export function isShipmentFilter(v: string | null): v is ShipmentFilter {
  return SHIPMENT_FILTERS.some((f) => f.value !== '' && f.value === v);
}

export const EVENT_SOURCE: Record<ParcelEventSource, string> = {
  booking: 'Booking',
  poll: 'Checked with the courier',
  webhook: 'Courier update',
  staff: 'Your team',
  system: 'Sellora',
};

export const RISK: Record<RiskLevel, { label: string; tone: BadgeTone; hint: string }> = {
  new: {
    label: 'New customer',
    tone: 'neutral',
    hint: 'No delivered or returned parcels yet.',
  },
  low: { label: 'Low risk', tone: 'success', hint: 'Most parcels were delivered.' },
  medium: {
    label: 'Some risk',
    tone: 'warning',
    hint: 'Some parcels came back, or orders were cancelled. Call before sending.',
  },
  high: {
    label: 'High risk',
    tone: 'danger',
    hint: 'Most parcels came back, or your team blocked this number. Ask for advance payment.',
  },
};

/** Only confirmed or packed orders can go to a courier, and only without a live booking. */
export function canSendToCourier(o: Pick<Order, 'status' | 'shipment'>): boolean {
  if (o.status !== 'confirmed' && o.status !== 'packed') return false;
  return !o.shipment || SHIPMENT_ENDED_UNSENT.includes(o.shipment.status);
}

/** "500 g", "1.5 kg". */
export function formatWeight(grams: number): string {
  if (grams < 1000) return `${grams} g`;
  const kg = Math.round(grams / 100) / 10;
  return `${kg} kg`;
}

/** Kilograms as typed ("0.5", "1,5") to whole grams; null when it is not a positive number. */
export function parseKg(input: string): number | null {
  const t = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const grams = Math.round(Number(t) * 1000);
  return grams > 0 ? grams : null;
}

export function kgInput(grams: number): string {
  return String(Math.round(grams) / 1000);
}

/** Why a weight is outside what the courier takes, or null when it is fine. */
export function weightProblem(
  grams: number | null,
  limits: { min: number; max: number },
): string | null {
  if (grams === null) return 'Enter the weight in kg, such as 0.5';
  if (grams < limits.min) return `At least ${formatWeight(limits.min)}`;
  if (grams > limits.max) return `At most ${formatWeight(limits.max)}`;
  return null;
}

/**
 * Credential fields left empty. When editing a saved account every field may stay empty
 * (keep the saved credentials), but filling one means filling all, as they are checked
 * together.
 */
export function missingCredentials(
  fields: CourierDescriptor['credentialFields'],
  values: Record<string, string>,
  editing: boolean,
): string[] {
  const empty = fields.filter((f) => !(values[f.key] ?? '').trim()).map((f) => f.key);
  if (editing && empty.length === fields.length) return [];
  return empty;
}

/** Unique phone numbers, in batches the fraud check takes at once. */
export function phoneBatches(phones: (string | null | undefined)[], size = 100): string[][] {
  const unique = [...new Set(phones.filter((p): p is string => Boolean(p)))].sort();
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}
