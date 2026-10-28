import { formatNumber } from './money';
import type {
  ATTRIBUTION_KEYS,
  Attribution,
  Language,
  LandingProduct,
  LandingVariant,
  LandingView,
  VideoEmbed,
} from './types';

/**
 * The offer arithmetic a landing page shows before the shopper orders. The API works every
 * price out again from the published page and the catalog; these numbers are only for the
 * form, and must agree with it (packageCharge mirrors the API's).
 */

/** Where the order form is; every "order" button on the page jumps there. */
export const ORDER_ANCHOR = 'order';

/** Where the page keeps where the shopper came from (set when the page opens). */
export const attributionKey = (pageId: string) => `sl_lp_attr_${pageId}`;

/** The page address format (the API's; reserved words simply find no page). */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
export function isLandingSlug(value: string): boolean {
  return SLUG_RE.test(value) && !value.includes('--');
}

/** What `quantity` pieces cost at `regularUnitMinor` each, or as a package priced at `packageMinor`. */
export function packageCharge(
  regularUnitMinor: number,
  quantity: number,
  packageMinor: number | null,
): { regularMinor: number; totalMinor: number; savingMinor: number } {
  const regularMinor = regularUnitMinor * quantity;
  if (packageMinor === null) return { regularMinor, totalMinor: regularMinor, savingMinor: 0 };
  return {
    regularMinor,
    totalMinor: packageMinor,
    savingMinor: Math.max(0, regularMinor - packageMinor),
  };
}

/** The option matching the shopper's choice of each option value, if there is one. */
export function variantFor(
  product: LandingProduct,
  chosen: (string | undefined)[],
): LandingVariant | undefined {
  if (product.variants.length === 1) return product.variants[0];
  return product.variants.find((v) => v.optionValues.every((value, i) => chosen[i] === value));
}

/** The first option a shopper can buy, chosen for them when the page opens. */
export function firstAvailable(product: LandingProduct): LandingVariant | undefined {
  return product.variants.find((v) => v.available) ?? product.variants[0];
}

export interface OfferChoice {
  packageId: string | null;
  variantId: string | null;
  quantity: number;
  addOn: boolean;
  zoneId: string | null;
}

export interface OfferTotals {
  quantity: number;
  /** The product (and add-on) at their regular prices. */
  regularMinor: number;
  /** What the package and the add-on price take off. */
  savingMinor: number;
  deliveryMinor: number | null;
  totalMinor: number;
}

/** The parts of a page the order form needs. */
export type OfferPart = Pick<
  LandingView,
  'product' | 'packages' | 'maxFreeQuantity' | 'addOn' | 'zones'
>;

/** The order the form would place, priced as the API prices it. Null until an option is chosen. */
export function offerTotals(view: OfferPart, choice: OfferChoice): OfferTotals | null {
  const variant = view.product?.variants.find((v) => v.id === choice.variantId);
  if (!variant) return null;
  const pkg = view.packages.find((p) => p.id === choice.packageId);
  if (view.packages.length && !pkg) return null;
  const quantity = pkg
    ? pkg.quantity
    : Math.max(1, Math.min(choice.quantity, view.maxFreeQuantity));
  const main = packageCharge(variant.priceMinor, quantity, pkg ? pkg.priceMinor : null);
  let { regularMinor, savingMinor, totalMinor } = main;
  if (choice.addOn && view.addOn) {
    const extra = packageCharge(view.addOn.regularPriceMinor, 1, view.addOn.priceMinor);
    regularMinor += extra.regularMinor;
    savingMinor += extra.savingMinor;
    totalMinor += extra.totalMinor;
  }
  const zone = view.zones.find((z) => z.id === choice.zoneId);
  const deliveryMinor = view.zones.length ? (zone ? zone.chargeMinor : null) : 0;
  return {
    quantity,
    regularMinor,
    savingMinor,
    deliveryMinor,
    totalMinor: totalMinor + (deliveryMinor ?? 0),
  };
}

/**
 * The lowest price the page offers for one order, and the regular price it compares with,
 * for the hero and the price section: the cheapest package, or one piece of the cheapest
 * option. Null when nothing can be ordered.
 */
export function headlinePrice(
  view: LandingView,
): { priceMinor: number; regularMinor: number } | null {
  const variants = view.product?.variants.filter((v) => v.available) ?? [];
  if (!variants.length) return null;
  const unit = Math.min(...variants.map((v) => v.priceMinor));
  const compareAt = Math.max(
    unit,
    ...variants.filter((v) => v.priceMinor === unit).map((v) => v.compareAtPriceMinor ?? 0),
  );
  if (!view.packages.length) return { priceMinor: unit, regularMinor: compareAt };
  const first = view.packages[0]!;
  const charge = packageCharge(unit, first.quantity, first.priceMinor);
  return {
    priceMinor: charge.totalMinor,
    regularMinor: Math.max(charge.regularMinor, first.quantity === 1 ? compareAt : 0),
  };
}

/** "Only {count} left" with the real number, in the page's digits. */
export function stockText(text: string, count: number, language: Language): string {
  return text.replaceAll('{count}', formatNumber(count, language));
}

/** Days, hours, minutes and seconds until `endsAt`; null once it has passed. */
export function countdownParts(
  endsAt: string,
  now: number,
): { days: number; hours: number; minutes: number; seconds: number } | null {
  const left = Math.floor((Date.parse(endsAt) - now) / 1000);
  if (!Number.isFinite(left) || left <= 0) return null;
  return {
    days: Math.floor(left / 86_400),
    hours: Math.floor((left % 86_400) / 3600),
    minutes: Math.floor((left % 3600) / 60),
    seconds: left % 60,
  };
}

/** The player address for a video the API has already checked. */
export function videoSrc(embed: VideoEmbed): string {
  return embed.provider === 'youtube'
    ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(embed.id)}?rel=0`
    : `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(embed.id)}&show_text=false`;
}

const QUERY_KEYS: Record<Exclude<(typeof ATTRIBUTION_KEYS)[number], 'referrer'>, string> = {
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  utmContent: 'utm_content',
  utmTerm: 'utm_term',
  fbclid: 'fbclid',
  gclid: 'gclid',
  ttclid: 'ttclid',
};

/**
 * Where the shopper came from: UTM tags and ad click ids from the page address, and the
 * referring site's host (never its full address, and never this shop's own address).
 */
export function readAttribution(search: string, referrer: string, ownHost: string): Attribution {
  const params = new URLSearchParams(search);
  const out: Attribution = {};
  for (const [key, param] of Object.entries(QUERY_KEYS) as [keyof typeof QUERY_KEYS, string][]) {
    const value = params.get(param)?.trim();
    if (value) out[key] = value.slice(0, 200);
  }
  try {
    const host = referrer ? new URL(referrer).hostname.toLowerCase() : '';
    if (host && host !== ownHost.toLowerCase().replace(/:\d+$/, ''))
      out.referrer = host.slice(0, 200);
  } catch {
    // Not an address: nothing to keep.
  }
  return out;
}
