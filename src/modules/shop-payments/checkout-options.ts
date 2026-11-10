import type { ShopGatewayKey } from '../commerce/schemas.js';
import type { ShopPaymentSettings } from './schemas.js';

type Settings = Pick<ShopPaymentSettings, 'cod' | 'fullOnline' | 'advance'>;

export interface GatewayChoice {
  key: ShopGatewayKey;
  name: string;
  hint: string;
  sandbox: boolean;
}

/** What a shopper may choose for one cart (ADR 0029). */
export interface CheckoutPaymentOptions {
  cod: boolean;
  fullOnline: boolean;
  gateways: GatewayChoice[];
  /** Asked online when the shopper chooses cash on delivery; 0 when none. */
  advanceMinor: number;
}

/** The whole taka at or above `minor` (advances are asked in whole taka). */
function wholeTaka(minor: number): number {
  return Math.ceil(minor / 100) * 100;
}

/**
 * The advance asked for a cash on delivery order: the delivery charge, a fixed amount or a
 * percent of the total, never more than the total; nothing when the rule does not apply to
 * this delivery area or total.
 */
export function advanceFor(
  advance: Settings['advance'],
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
        : wholeTaka((cart.totalMinor * advance.percent) / 100);
  return Math.max(0, Math.min(cart.totalMinor, Math.round(raw)));
}

/**
 * The options for this cart. Without a switched-on gateway only cash on delivery is offered;
 * cash on delivery stays on whenever paying in full online is off.
 */
export function checkoutOptions(
  settings: Settings,
  gateways: GatewayChoice[],
  cart: { totalMinor: number; deliveryChargeMinor: number; zoneId: string | null },
): CheckoutPaymentOptions {
  if (!gateways.length) return { cod: true, fullOnline: false, gateways: [], advanceMinor: 0 };
  const fullOnline = settings.fullOnline;
  const cod = settings.cod || !fullOnline;
  return {
    cod,
    fullOnline,
    gateways,
    advanceMinor: cod ? advanceFor(settings.advance, cart) : 0,
  };
}
