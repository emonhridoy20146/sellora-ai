/**
 * Sellable feature modules. Plans bundle modules; routes declare the module they belong
 * to with @RequireModule, and the access guard answers 402 when the plan lacks it.
 */
export const FEATURE_MODULES = {
  inbox: {
    name: 'Unified inbox',
    description: 'Messenger, Instagram, WhatsApp and web chat in one inbox',
  },
  ai_agent: {
    name: 'AI sales agent',
    description: 'AI replies, product suggestions, customer memory, dot command',
  },
  commerce: {
    name: 'Orders and products',
    description: 'Products, stock, manual orders, customers, printing',
  },
  couriers: { name: 'Courier booking', description: 'Steadfast, Pathao and more, with tracking' },
  fraud: {
    name: 'Fraud check',
    description: 'Courier success-rate and risk scoring before shipping',
  },
  storefront: {
    name: 'Online store',
    description: 'Themed store on a subdomain or your own domain',
  },
  landing_pages: { name: 'Landing pages', description: 'High-converting product landing pages' },
  marketing: {
    name: 'Marketing automation',
    description: 'Follow-ups, broadcasts, abandoned cart and SMS',
  },
  ads: {
    name: 'Ads intelligence',
    description: 'Meta, Google and TikTok ads analytics and forecasts',
  },
  seo: {
    name: 'AI SEO studio',
    description: 'Keyword research and SEO writing for products and pages',
  },
  analytics: { name: 'Reports', description: 'Sales, inbox and AI value dashboards' },
  backups_drive: {
    name: 'Google Drive backup',
    description: 'Daily backup of your data to your own Google Drive',
  },
  api_access: { name: 'API and webhooks', description: 'Public API keys and outgoing webhooks' },
} as const;

export type FeatureModule = keyof typeof FEATURE_MODULES;
export const FEATURE_MODULE_KEYS = Object.keys(FEATURE_MODULES) as [
  FeatureModule,
  ...FeatureModule[],
];

/** Numeric plan limits. `null` means unlimited. */
export const LIMIT_KEYS = [
  'seats',
  'stores',
  'products',
  'channels',
  'ordersPerMonth',
  'conversationsPerMonth',
  'landingPages',
  'storageMb',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type PlanLimits = Record<LimitKey, number | null>;

export const UNLIMITED: PlanLimits = {
  seats: null,
  stores: null,
  products: null,
  channels: null,
  ordersPerMonth: null,
  conversationsPerMonth: null,
  landingPages: null,
  storageMb: null,
};

export const BILLING_INTERVALS = ['month', 'year', 'lifetime'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
