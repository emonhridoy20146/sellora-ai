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
}

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
