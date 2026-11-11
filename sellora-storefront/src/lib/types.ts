/** Shapes the Sellora API returns on its /v1/storefront routes. */

export type StoreState = 'open' | 'preview' | 'coming_soon' | 'paused' | 'unavailable';
export type Language = 'en' | 'bn';
export type PageKey = 'about' | 'shipping' | 'returns' | 'privacy' | 'terms';

export interface StoreImage {
  fileId: string;
  url: string;
}

export type Section =
  | {
      id: string;
      enabled: boolean;
      type: 'hero';
      heading: string;
      subheading: string;
      buttonLabel: string;
      image: StoreImage | null;
    }
  | { id: string; enabled: boolean; type: 'categories'; title: string }
  | {
      id: string;
      enabled: boolean;
      type: 'products';
      title: string;
      source: 'newest' | 'bestsellers' | 'category';
      categoryId: string | null;
      limit: number;
    }
  | {
      id: string;
      enabled: boolean;
      type: 'features';
      items: { icon: FeatureIcon; title: string; text: string }[];
    }
  | {
      id: string;
      enabled: boolean;
      type: 'banner';
      heading: string;
      text: string;
      buttonLabel: string;
      image: StoreImage | null;
    }
  | { id: string; enabled: boolean; type: 'text'; heading: string; body: string };

export type FeatureIcon = 'truck' | 'cash' | 'return' | 'support' | 'shield' | 'gift';

export interface ThemeSettings {
  palette: { primary: string; accent: string };
  font: 'sans' | 'serif' | 'rounded';
  radius: 'none' | 'small' | 'large';
  header: 'left' | 'centered' | 'bold';
  card: 'plain' | 'bordered' | 'soft';
  logo: StoreImage | null;
  announcement: string;
  sections: Section[];
}

interface StoreBase {
  id: string;
  name: string;
  handle: string;
  url: string;
  language: Language;
  state: StoreState;
}

/** A store shoppers cannot see: only what a holding page needs. */
export interface ClosedStore extends StoreBase {
  state: 'coming_soon' | 'paused' | 'unavailable';
  theme: ThemeSettings | null;
  themeKey?: string;
  currency?: string;
  contact?: StoreContact;
  social?: StoreSocial;
}

export interface StoreContact {
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
}

export interface StoreSocial {
  facebook: string | null;
  instagram: string | null;
  youtube: string | null;
  tiktok: string | null;
}

export interface OpenStore extends StoreBase {
  state: 'open' | 'preview';
  themeKey: string;
  currency: string;
  contact: StoreContact;
  social: StoreSocial;
  theme: ThemeSettings;
  seo: { title: string; description: string };
  pages: PageKey[];
  checkout: { note: string; minOrderMinor: number };
  /** The business's own ad tags for this store; null in a preview (ADR 0030). */
  tracking?: AdTags | null;
}

export type Store = OpenStore | ClosedStore;

export function isOpen(store: Store): store is OpenStore {
  return store.state === 'open' || store.state === 'preview';
}

export interface ProductCard {
  id: string;
  slug: string;
  name: string;
  image: { url: string; alt: string } | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  priceVaries: boolean;
  inStock: boolean;
}

export interface ProductDetail extends ProductCard {
  description: string;
  images: { url: string; alt: string }[];
  options: { name: string; values: string[] }[];
  variants: {
    id: string;
    title: string;
    optionValues: string[];
    priceMinor: number;
    compareAtPriceMinor: number | null;
    available: boolean;
    left: number | null;
  }[];
  category: { name: string; slug: string } | null;
  currency: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  productCount: number;
}

export interface HomeData {
  sections: Record<string, ProductCard[]>;
  categories: Category[];
}

export interface ProductPage {
  items: ProductCard[];
  total: number;
  page: number;
  pageCount: number;
  category: { name: string; slug: string } | null;
}

export type LineProblem = 'unavailable' | 'out_of_stock' | 'not_enough_stock' | 'duplicate';

export interface QuoteLine {
  productId: string;
  variantId: string;
  quantity: number;
  name: string | null;
  slug?: string;
  variantTitle?: string;
  image?: string | null;
  unitPriceMinor?: number;
  totalMinor?: number;
  maxQuantity?: number | null;
  problem: LineProblem | null;
}

export interface Quote {
  currency: string;
  lines: QuoteLine[];
  subtotalMinor: number;
  zones: { id: string; name: string; chargeMinor: number }[];
  zoneId: string | null;
  deliveryChargeMinor: number;
  totalMinor: number;
  minOrderMinor: number;
  belowMinimum: boolean;
  canCheckout: boolean;
  /** The business texts reminders about carts left with a phone number (shown under it). */
  cartReminders?: boolean;
  /** How the shopper may pay for this cart (ADR 0029). */
  payments?: CheckoutPayments;
}

export type ShopGatewayKey = 'bkash' | 'nagad' | 'sslcommerz' | 'aamarpay' | 'shurjopay';

/** A gateway the business switched on; `sandbox` means test mode, no real money. */
export interface GatewayChoice {
  key: ShopGatewayKey;
  name: string;
  hint: string;
  sandbox: boolean;
}

export interface CheckoutPayments {
  cod: boolean;
  fullOnline: boolean;
  gateways: GatewayChoice[];
  /** Paid online first when the shopper chooses cash on delivery; 0 when none. */
  advanceMinor: number;
}

export interface AdvanceRule {
  mode: 'delivery' | 'fixed' | 'percent';
  fixedMinor: number;
  percent: number;
  zoneIds: string[];
  minTotalMinor: number;
}

/** A landing page prices its own form, so it gets the advance rule rather than an amount. */
export interface LandingPayments {
  cod: boolean;
  fullOnline: boolean;
  gateways: GatewayChoice[];
  advance: AdvanceRule | null;
}

/** The payment started after an order; no `redirectUrl` when the gateway could not start. */
export interface PaymentStart {
  gateway: ShopGatewayKey;
  amountMinor: number;
  redirectUrl: string | null;
  error: string | null;
}

export interface ReceiptPayment {
  method: string;
  status: 'unpaid' | 'partial' | 'paid' | 'refunded';
  paidMinor: number;
  /** Still to pay in all (online or on delivery). */
  dueMinor: number;
  online: {
    gateway: ShopGatewayKey;
    gatewayName: string;
    purpose: 'full' | 'advance';
    dueMinor: number;
    status: 'awaiting' | 'paid' | 'failed';
    sandbox: boolean;
  } | null;
  /** What can be paid online now, and with which gateways; null when nothing. */
  payNow: { amountMinor: number; gateways: GatewayChoice[] } | null;
}

/** Where the gateway sent the shopper back, as the API says (`?payment=`). */
export type ReturnState = 'paid' | 'pending' | 'failed' | 'cancelled' | 'unstarted';

export interface Shipment {
  status: string;
  courier: string;
  trackingCode: string | null;
  trackingUrl: string | null;
}

export interface Receipt {
  number: string;
  status: string;
  placedAt: string;
  currency: string;
  items: {
    name: string;
    variantTitle: string;
    image: string | null;
    quantity: number;
    unitPriceMinor: number;
    totalMinor: number;
  }[];
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  totalMinor: number;
  paymentMethod: string;
  customer: { name: string; phone: string | null };
  address: { line1: string; area: string | null; city: string | null; district: string | null };
  deliveryZone: string | null;
  timeline: { status: string; at: string }[];
  shipment: Shipment | null;
  payment?: ReceiptPayment;
  /** The purchase as the browser reports it to the ad tags, with the server's event id. */
  tracking?: { purchase: BrowserPurchase };
}

export interface Tracking {
  number: string;
  status: string;
  placedAt: string;
  totalMinor: number;
  currency: string;
  itemCount: number;
  timeline: { status: string; at: string }[];
  shipment: Shipment | null;
}

/** RFC 9457 problem details, as the API sends errors. */
export interface Problem {
  status: number;
  code: string;
  detail: string;
  errors?: { path: string; message: string; code?: string }[];
  retryAfterSeconds?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------- landing pages

/**
 * live: shoppers see it and can order. preview: a signed link shows a draft or the version
 * in review (no orders). paused: the business (or its store) paused it. unavailable: the
 * platform took it down, or the business may not show pages now.
 */
export type LandingState = 'live' | 'preview' | 'paused' | 'unavailable';
export type HideOn = 'none' | 'mobile' | 'desktop';

export interface LandingImage {
  fileId: string;
  url: string;
  alt: string;
}

export interface VideoEmbed {
  provider: 'youtube' | 'facebook';
  /** The YouTube video id, or the Facebook video's canonical link. */
  id: string;
}

interface LandingBase {
  id: string;
  enabled: boolean;
  hideOn: HideOn;
}

export type LandingSection = LandingBase &
  (
    | {
        type: 'hero';
        heading: string;
        subheading: string;
        badge: string;
        buttonLabel: string;
        image: LandingImage | null;
        showPrice: boolean;
      }
    | { type: 'image'; image: LandingImage | null; caption: string }
    | { type: 'gallery'; title: string; source: 'product' | 'custom'; images: LandingImage[] }
    | { type: 'video'; title: string; url: string; embed?: VideoEmbed | null }
    | { type: 'benefits'; title: string; items: { title: string; text: string }[] }
    | {
        type: 'problem_solution';
        problemTitle: string;
        problem: string;
        solutionTitle: string;
        solution: string;
        image: LandingImage | null;
      }
    | { type: 'specs'; title: string; rows: { label: string; value: string }[] }
    | { type: 'steps'; title: string; steps: { text: string }[] }
    | {
        type: 'before_after';
        title: string;
        before: LandingImage | null;
        after: LandingImage | null;
        caption: string;
      }
    | {
        type: 'reviews';
        title: string;
        items: { name: string; text: string; rating: number; image: LandingImage | null }[];
      }
    | { type: 'countdown'; heading: string; endsAt: string | null; endedText: string }
    | { type: 'stock_left'; text: string; threshold: number }
    | { type: 'price'; heading: string; note: string }
    | { type: 'faq'; title: string; items: { question: string; answer: string }[] }
    | {
        type: 'guarantee';
        title: string;
        items: { icon: FeatureIcon; title: string; text: string }[];
      }
    | { type: 'delivery'; heading: string; text: string; showAreas: boolean }
    | { type: 'contact'; heading: string; text: string; call: boolean; whatsapp: boolean }
    | { type: 'text'; heading: string; body: string }
    | { type: 'order_form'; heading: string; subheading: string; buttonLabel: string }
  );

export type LandingSectionOf<T extends LandingSection['type']> = Extract<
  LandingSection,
  { type: T }
>;

/** The store a landing page belongs to: its look and how to reach it. */
export interface LandingBrand {
  id: string;
  name: string;
  handle: string;
  url: string;
  language: Language;
  /** Whether the rest of the shop is open (links to it are shown only then). */
  open: boolean;
  themeKey: string;
  theme: ThemeSettings;
  currency: string;
  contact: StoreContact;
}

export interface LandingHead {
  state: LandingState;
  store: LandingBrand;
  page: { id: string; name: string; slug: string; language: Language; url: string };
}

export interface LandingPackage {
  id: string;
  label: string;
  quantity: number;
  /** The package's whole price; null charges the option's own price times the quantity. */
  priceMinor: number | null;
  badge: string;
}

export interface LandingVariant {
  id: string;
  title: string;
  optionValues: string[];
  priceMinor: number;
  compareAtPriceMinor: number | null;
  available: boolean;
  /** Most a shopper can order; null when stock is not counted. */
  maxQuantity: number | null;
}

export interface LandingProduct {
  id: string;
  name: string;
  description: string;
  images: { url: string; alt: string }[];
  options: { name: string; values: string[] }[];
  variants: LandingVariant[];
  currency: string;
}

export interface LandingAddOnOffer {
  label: string;
  name: string;
  variantTitle: string;
  image: string | null;
  priceMinor: number;
  regularPriceMinor: number;
}

export interface DeliveryZone {
  id: string;
  name: string;
  chargeMinor: number;
}

/** A page shoppers can see (live, or a preview). */
export interface LandingView extends LandingHead {
  state: 'live' | 'preview';
  sections: LandingSection[];
  settings: { stickyButton: boolean; stickyLabel: string };
  seo: { title: string; description: string; image: string | null; index: boolean };
  /** Null when the product is no longer on sale: the page shows that the offer ended. */
  product: LandingProduct | null;
  packages: LandingPackage[];
  maxFreeQuantity: number;
  addOn: LandingAddOnOffer | null;
  noteField: boolean;
  /** Units left, only when the page's "stock left" section asks to show them. */
  stockLeft: number | null;
  zones: DeliveryZone[];
  defaultZoneId: string | null;
  currency: string;
  /** The business texts reminders about carts left with a phone number (shown under it). */
  cartReminders?: boolean;
  /** How the shopper may pay (ADR 0029). */
  payments?: LandingPayments;
  /** The business's own ad tags for this page; null in a preview (ADR 0030). */
  tracking?: AdTags | null;
}

export type Landing = LandingHead | LandingView;

/** What a reminder link (`/r/<code>`) brings back. */
export interface RestoredCart {
  kind: 'store' | 'landing_page';
  status: 'open' | 'ordered' | 'dismissed';
  token: string | null;
  items: { productId: string; variantId: string; quantity: number }[];
  landingPage: { slug: string } | null;
  selection: {
    packageId: string | null;
    variantId: string;
    quantity: number;
    addOn: boolean;
  } | null;
  customer: { name: string; phone: string };
}

export function isShown(l: Landing): l is LandingView {
  return (l.state === 'live' || l.state === 'preview') && 'sections' in l;
}

export interface LandingPlaced {
  orderNumber: string;
  totalMinor: number;
  currency: string;
  receipt: string;
  /** True when this is the order the shopper placed a moment ago, shown again. */
  duplicate: boolean;
  /** The online payment started for the order, if the shopper chose one. */
  payment?: PaymentStart | null;
}

export interface LandingReceipt {
  order: Receipt;
  store: LandingBrand;
  page: { id: string; name: string; slug: string; language: Language };
  /** The page's ad tags, for the purchase (ADR 0030). */
  tracking?: AdTags | null;
}

export const ATTRIBUTION_KEYS = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'fbclid',
  'gclid',
  'ttclid',
  'referrer',
] as const;
export type Attribution = Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>>;

// ---------------------------------------------------------------- ad tags (ADR 0030)

/** Whether shoppers are asked before any ad tag loads. */
export type AdConsentMode = 'off' | 'ask';

/** The public ids of the business's own pixels and tags for one store or landing page. */
export interface AdTags {
  consent: AdConsentMode;
  /** `purchase`: the browser reports the purchase when the order is placed. */
  meta: { pixelId: string; purchase: boolean }[];
  tiktok: { pixelCode: string; purchase: boolean }[];
  ga4: { measurementId: string }[];
  googleAds: { conversionId: string; purchaseLabel: string | null; purchase: boolean }[];
}

/** An order as the browser reports it to ad tags, with the server's event id. */
export interface BrowserPurchase {
  eventId: string;
  orderNumber: string;
  currency: string;
  valueMinor: number;
  items: { id: string; name: string; quantity: number; priceMinor: number }[];
  /** SHA-256 of the normalized email and E.164 phone, for Google Ads enhanced conversions. */
  hashedEmail: string | null;
  hashedPhone: string | null;
}
