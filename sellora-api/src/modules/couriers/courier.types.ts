import type { z } from 'zod';
import type { ShipmentStatus } from '../commerce/schemas.js';

/** Couriers Sellora can book with. Each has an adapter in ./providers. */
export const COURIER_KEYS = ['steadfast', 'pathao', 'redx'] as const;
export type CourierKey = (typeof COURIER_KEYS)[number];

/** Injection token for the fetch courier adapters use, so tests can play the courier's part. */
export const COURIER_FETCH = Symbol('COURIER_FETCH');

/**
 * How a courier call failed, which decides what Sellora does next:
 * - rejected: the courier refused the request (bad address, phone, amount). Nothing was made.
 * - auth: the courier did not accept the credentials. Nothing was made.
 * - busy: rate limited. Nothing was made; try again later.
 * - unavailable: a read failed (network, outage). Safe to try again.
 * - uncertain: a booking was sent but the answer was lost (timeout, outage). The courier may
 *   or may not have made the parcel, so it must not be sent again blindly.
 */
export type CourierErrorKind = 'rejected' | 'auth' | 'busy' | 'unavailable' | 'uncertain';

export class CourierError extends Error {
  constructor(
    readonly kind: CourierErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'CourierError';
  }
}

/** A credential the merchant copies from the courier's merchant panel. */
export interface CourierField {
  key: string;
  label: string;
  /** Never shown again after saving. */
  secret: boolean;
  help?: string;
}

export interface CourierChoice {
  value: string;
  label: string;
}

/** What a courier needs from staff and from the account settings to take a booking. */
export interface CourierDescriptor {
  key: CourierKey;
  name: string;
  credentialFields: CourierField[];
  /** Delivery options the account can default to (home or point delivery, normal or express). */
  deliveryTypes: CourierChoice[];
  /** The courier has a sandbox an account can point at. */
  sandbox: boolean;
  /** Parcels leave from a pickup store chosen in the account settings. */
  pickupStore: 'required' | 'optional' | 'none';
  /**
   * The delivery location the booking form asks for: none (a written address is enough),
   * city_zone_area (Pathao's ids), or area (one area from the courier's list).
   */
  location: 'none' | 'city_zone_area' | 'area';
  locationRequired: boolean;
  weightGrams: { min: number; max: number };
  /** How the courier proves a webhook comes from it. */
  webhookAuth: 'bearer' | 'secret_header' | 'url';
  /** What to paste where in the courier's panel, shown next to the webhook address. */
  webhookHelp: string;
}

/** Non-secret account settings, validated against the descriptor. */
export interface CourierSettings {
  deliveryType?: string;
  storeId?: string;
  /** The store's name as the courier lists it, for display (set by Sellora, not staff). */
  storeName?: string;
}

export interface CourierContext<C> {
  accountId: string;
  credentials: C;
  settings: CourierSettings;
  sandbox: boolean;
}

export interface ParcelLocation {
  cityId?: number;
  cityName?: string;
  zoneId?: number;
  zoneName?: string;
  areaId?: number;
  areaName?: string;
}

export interface BookingRequest {
  /** Our reference, unique per business: the order number, with -2, -3 on later bookings. */
  invoice: string;
  recipient: {
    name: string;
    /** Local 11-digit mobile number: 01XXXXXXXXX. */
    phone: string;
    altPhone?: string;
    email?: string;
    address: string;
  };
  /** Cash to collect, in paisa (always whole taka). */
  codMinor: number;
  /** Declared value of the goods, in paisa. */
  valueMinor: number;
  weightGrams: number;
  quantity: number;
  description: string;
  note?: string;
  location?: ParcelLocation;
}

export interface BookingResult {
  consignmentId: string;
  trackingCode?: string;
  providerStatus: string;
  deliveryFeeMinor?: number;
}

export interface ParcelRef {
  consignmentId?: string;
  trackingCode?: string;
  invoice: string;
}

export interface StatusResult {
  /** The courier's own status word, kept as it came. */
  providerStatus: string;
}

/** A courier status in Sellora's words, with a note for staff when it needs a look. */
export interface Translation {
  /** null: a status Sellora does not know; it is recorded and nothing else changes. */
  status: ShipmentStatus | null;
  attention?: string;
}

export interface LocationQuery {
  kind: 'city' | 'zone' | 'area';
  parentId?: number;
  search?: string;
}

export interface LocationOption {
  id: number;
  name: string;
  hint?: string;
}

export interface StoreOption {
  id: string;
  name: string;
  address?: string;
}

/** Parcel references found in a webhook body (which is never trusted for the status). */
export interface WebhookRefs {
  consignmentIds: string[];
  trackingCodes: string[];
  invoices: string[];
}

/**
 * One courier's API behind a common shape. Everything courier-specific (addresses, headers,
 * field names, status words) stays inside the adapter.
 */
export interface CourierProvider<C = unknown> {
  readonly descriptor: CourierDescriptor;
  readonly credentials: z.ZodType<C>;
  /** A non-secret hint to recognise the credentials later (masked key, username). */
  hint(credentials: C): string;
  /** Checks the credentials with a call that changes nothing; lists pickup stores if any. */
  verify(ctx: CourierContext<C>): Promise<{ summary: string; stores: StoreOption[] }>;
  book(ctx: CourierContext<C>, req: BookingRequest): Promise<BookingResult>;
  status(ctx: CourierContext<C>, ref: ParcelRef): Promise<StatusResult>;
  /**
   * After a lost reply: whether the courier has a parcel with our invoice. Couriers that
   * cannot look a parcel up by invoice leave this out, and staff check by hand.
   */
  statusByInvoice?(ctx: CourierContext<C>, invoice: string): Promise<StatusResult | 'not_found'>;
  translate(providerStatus: string, previous: ShipmentStatus): Translation;
  locations?(ctx: CourierContext<C>, query: LocationQuery): Promise<LocationOption[]>;
  trackingUrl(parcel: {
    consignmentId?: string;
    trackingCode?: string;
    phone: string;
  }): string | null;
  webhookRefs(body: unknown): WebhookRefs;
  /** Whether a webhook really comes from the courier, given the account's webhook secret. */
  verifyWebhook(headers: WebhookHeaders, secret: string): boolean;
  /** The status and headers the courier expects in the answer to its webhook. */
  webhookReply(secret: string): { status: number; headers: Record<string, string> };
}

/** Request headers as Node gives them (lower-case names). */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Fills a tracking page template; null when the template or a needed value is missing. */
export function fillTrackingUrl(
  template: string,
  values: { tracking?: string; consignment?: string; phone: string },
): string | null {
  if (!template) return null;
  let missing = false;
  const url = template.replace(/\{(tracking|consignment|phone)\}/g, (_, key: string) => {
    const v = values[key as keyof typeof values];
    if (!v) missing = true;
    return encodeURIComponent(v ?? '');
  });
  return missing ? null : url;
}

/** Lower-case words joined by underscores: "At the Sorting HUB" and "at-the-sorting-hub" match. */
export function statusKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^order\./, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
