/**
 * Response shapes of the Sellora API, written to match what the API returns (checked against
 * a running server). Money is always an integer in the currency's minor unit (paisa, cents).
 */

export type Locale = 'en' | 'bn';
export type IsoDate = string;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ------------------------------------------------------------------ merchant auth

export interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  locale: Locale;
  timezone: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: IsoDate;
}

export type LoginResult =
  | { status: 'ok'; user: User; accessToken: string; expiresIn: number; csrfToken?: string }
  | { status: 'mfa_required'; mfaToken: string };

export interface OrgContact {
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  legalName: string | null;
  category: string;
  country: string;
  currency: string;
  timezone: string;
  locale: Locale;
  contact: OrgContact;
  status: 'active' | 'suspended' | 'closed';
  isDemo: boolean;
  demoExpiresAt: IsoDate | null;
  settings: { orderNumberPrefix: string };
  createdAt: IsoDate;
}

export interface OrgWithRole extends Organization {
  role: { key: string; name: string };
  permissions: string[];
}

export interface Me {
  user: User;
  organizations: OrgWithRole[];
}

export interface MfaStatus {
  enabled: boolean;
  enabledAt: IsoDate | null;
  recoveryCodesRemaining: number;
}

export interface Session {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: IsoDate;
  lastUsedAt: IsoDate;
  current: boolean;
}

export interface BusinessCategory {
  key: string;
  label: { en: string; bn: string };
}

// ------------------------------------------------------------------ staff

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: { key: string; name: string };
  status: 'active' | 'suspended';
  mfaEnabled: boolean;
  joinedAt: IsoDate;
  isYou: boolean;
}

export interface Role {
  key: string;
  name: string;
  description: string;
  permissions: string[];
  system: boolean;
  memberCount: number;
}

export interface PermissionGroup {
  key: string;
  label: string;
  permissions: { key: string; description: string }[];
}

export interface Invitation {
  id: string;
  email: string;
  role: { key: string; name: string };
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: IsoDate;
  createdAt: IsoDate;
}

export interface InvitationPreview {
  orgName: string;
  roleName: string;
  /** Masked, e.g. ra***@gmail.com */
  email: string;
  status: Invitation['status'];
}

export interface AuditEvent {
  id: string;
  seq: number;
  scope?: string;
  orgId?: string | null;
  action: string;
  outcome: 'success' | 'failure';
  actor: { type: string; id: string; label?: string; sessionId?: string };
  target: { type: string; id: string; label?: string } | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  at: IsoDate;
}

// ------------------------------------------------------------------ billing

export type BillingInterval = 'month' | 'year' | 'lifetime';
export type ModelTier = 'fast' | 'standard' | 'advanced';

export interface PlanLimits {
  seats: number | null;
  stores: number | null;
  products: number | null;
  channels: number | null;
  ordersPerMonth: number | null;
  conversationsPerMonth: number | null;
  landingPages: number | null;
  storageMb: number | null;
}

export interface PlanPrice {
  interval: BillingInterval;
  currency: string;
  amountMinor: number;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  modules: { key: string; name: string }[];
  limits: PlanLimits;
  prices: PlanPrice[];
  includedCreditsPerMonth: number;
  trialEligible: boolean;
  highlight: boolean;
  sortOrder: number;
}

export interface PlatformPlan extends Plan {
  isPublic: boolean;
  isActive: boolean;
  version: number;
  updatedAt: IsoDate;
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';

export interface Entitlements {
  planCode: string;
  paidAccess: boolean;
  inGracePeriod: boolean;
  modules: string[];
  limits: PlanLimits;
}

export interface Subscription {
  plan: { code: string; name: string };
  status: SubscriptionStatus;
  interval: BillingInterval | 'trial' | 'free';
  currency: string;
  priceMinor: number;
  currentPeriodStart: IsoDate;
  currentPeriodEnd: IsoDate | null;
  trialEndsAt: IsoDate | null;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  includedCreditsPerMonth: number;
  nextCreditGrantAt: IsoDate | null;
  entitlements: Entitlements;
}

export interface WalletBalance {
  currency: string;
  balanceMinor: number;
  heldMinor: number;
  availableMinor: number;
  bonusMinor: number;
  withdrawableMinor: number;
  status: 'active' | 'frozen';
  lifetimeTopupMinor: number;
  lifetimeSpentMinor: number;
}

export interface CreditRate {
  version: number;
  currency: string;
  creditPriceMinor: number;
  minimumCreditsPerRequest: number;
  tiers: { tier: ModelTier; inputCreditsPer1k: number; outputCreditsPer1k: number }[];
  effectiveFrom: IsoDate;
}

export interface PlatformCreditRate extends CreditRate {
  id: string;
  usdRateScaled: number;
  usdRate: number;
  note: string | null;
  createdBy: string;
  createdAt: IsoDate;
}

export interface BillingSummary {
  subscription: Subscription;
  wallet: WalletBalance;
  creditRate: CreditRate | null;
  withdrawalsEnabled: boolean;
}

export type LedgerType =
  'topup' | 'bonus' | 'ai_usage' | 'subscription' | 'refund' | 'adjustment' | 'withdrawal';

export interface LedgerEntry {
  id: string;
  type: LedgerType | string;
  amountMinor: number;
  balanceAfterMinor: number;
  currency?: string;
  description: string;
  credits: number | null;
  reference?: { type: string; id: string } | null;
  actor?: { type: string; id: string };
  at: IsoDate;
}

export type GatewayKey = 'sslcommerz' | 'bkash' | 'stripe' | 'manual';
export type OnlineGateway = Exclude<GatewayKey, 'manual'>;
export type ManualMethod = 'bkash' | 'nagad' | 'rocket' | 'bank';

export interface ManualInstructions {
  instructions: string;
  accounts: { method: ManualMethod; label: string; account: string }[];
}

export interface PaymentMethods {
  currency: string;
  minTopupMinor: number;
  maxTopupMinor: number;
  online: { key: OnlineGateway; sandbox: boolean }[];
  manual: ManualInstructions | null;
}

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded';

export interface Payment {
  id: string;
  purpose: 'wallet_topup' | 'subscription';
  amountMinor: number;
  currency: string;
  gateway: GatewayKey;
  status: PaymentStatus;
  checkoutUrl: string | null;
  plan: { code: string; interval: BillingInterval } | null;
  manual: {
    method: ManualMethod | 'cash';
    senderAccount: string;
    transactionRef: string;
    note?: string;
  } | null;
  gatewayRef: string | null;
  failureReason: string | null;
  reviewNote: string | null;
  createdAt: IsoDate;
  succeededAt: IsoDate | null;
}

export interface PlatformPayment extends Payment {
  orgId: string;
  gatewaySessionId: string | null;
  reviewedBy: string | null;
  events: { at: IsoDate; type: string }[];
}

export interface UsageSummary {
  from: IsoDate;
  to: IsoDate;
  totals: { credits: number; chargedMinor: number; requests: number };
  byDay: { date: string; credits: number; chargedMinor: number; requests: number }[];
  byFeature: { feature: string; credits: number; chargedMinor: number; requests: number }[];
}

export interface UsageRequest {
  id: string;
  requestId: string;
  feature: string;
  tier: ModelTier;
  status: 'reserved' | 'settled' | 'released';
  tokens: { input: number; output: number };
  credits: number;
  chargedMinor: number;
  reference: { type: string; id: string } | null;
  at: IsoDate;
}

export interface Invoice {
  id: string;
  number: string;
  kind: 'subscription' | 'wallet_topup';
  currency: string;
  lines: { description: string; quantity: number; unitMinor: number }[];
  subtotalMinor: number;
  taxMinor: number;
  taxRateBps: number;
  taxLabel: string;
  totalMinor: number;
  paidWith: string;
  issuedAt: IsoDate;
  billTo: {
    name: string;
    legalName?: string | null;
    email?: string | null;
    address?: string | null;
  };
}

export type WithdrawalStatus = 'requested' | 'approved' | 'paid' | 'rejected' | 'canceled';

export interface Withdrawal {
  id: string;
  amountMinor: number;
  currency: string;
  method: 'bkash' | 'nagad' | 'bank' | 'original_method';
  destination: string;
  status: WithdrawalStatus;
  reviewNote: string | null;
  payoutRef: string | null;
  createdAt: IsoDate;
  reviewedAt: IsoDate | null;
  paidAt: IsoDate | null;
  orgId?: string;
  org?: { id: string; name: string } | null;
}

// ------------------------------------------------------------------ platform (super-admin)

export type PlatformRole = 'owner' | 'admin' | 'finance' | 'support' | 'readonly';

export interface PlatformUser {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  status: 'invited' | 'active' | 'disabled';
  mfaEnabled: boolean;
  lastLoginAt: IsoDate | null;
  createdAt: IsoDate;
}

export interface PlatformMe extends PlatformUser {
  permissions: string[];
}

export type PlatformLoginResult =
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; setupToken: string };

export interface PlatformOverview {
  tenants: number;
  activeTenants: number;
  suspendedTenants: number;
  demoTenants: number;
  users: number;
  newUsersToday: number;
  newTenantsWeek: number;
}

export interface Tenant extends Organization {
  memberCount: number;
  owner: { id: string; name: string; email: string } | null;
  statusReason: string | null;
}

export interface TenantDetail extends Organization {
  statusReason: string | null;
  statusChangedAt: IsoDate | null;
  members: {
    id: string;
    userId: string;
    name: string;
    email: string;
    roleKey: string;
    status: string;
  }[];
}

export interface MerchantUserRow extends User {
  status: 'active' | 'locked' | 'disabled';
  lastLoginAt: IsoDate | null;
}

export interface MerchantUserDetail extends MerchantUserRow {
  statusReason: string | null;
  lastLoginIp: string | null;
  organizations: { id: string; name: string; roleKey: string; status: string }[];
  activeSessions: number;
}

export interface PlatformRoleCatalogue {
  permissions: { key: string; description: string }[];
  roles: { key: PlatformRole; permissions: string[] }[];
}

export interface AuditChainCheck {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  reason?: 'missing_event' | 'prev_hash_mismatch' | 'hash_mismatch' | 'head_mismatch';
}

/** Sellable modules and plan limit keys, as the API defines them (plan editor, overrides). */
export interface ModuleCatalogue {
  modules: { key: string; name: string; description: string }[];
  limits: (keyof PlanLimits)[];
}

export interface PlatformSettings {
  signupEnabled: boolean;
  trial: { enabled: boolean; days: number; planCode: string };
  demo: { defaultHours: number };
  maintenance: { enabled: boolean; message: string };
  support: { email: string; whatsapp: string };
  billing: {
    withdrawalsEnabled: boolean;
    graceDays: number;
    taxRateBps: number;
    taxLabel: string;
    minTopupMinor: number;
    maxTopupMinor: number;
  };
  updatedAt?: IsoDate;
}

export interface PublicPlatformStatus {
  signupEnabled: boolean;
  trial: { enabled: boolean; days: number; planCode: string };
  maintenance: { enabled: boolean; message: string };
  support: { email: string; whatsapp: string };
}

export interface BillingOverview {
  from: IsoDate;
  to: IsoDate;
  subscriptions: { status: SubscriptionStatus; planCode: string; count: number }[];
  mrr: { currency: string; mrrMinor: number; payingBusinesses: number }[];
  wallets: {
    currency: string;
    balanceMinor: number;
    heldMinor: number;
    bonusMinor: number;
    cashMinor: number;
    wallets: number;
  }[];
  payments: { currency: string; gateway: GatewayKey; amountMinor: number; count: number }[];
  ai: {
    currency: string;
    requests: number;
    credits: number;
    collectedMinor: number;
    billedMinor: number;
    costMinor: number;
    profitMinor: number;
    marginPct: number | null;
  }[];
  queues: { pendingManualPayments: number; openWithdrawals: number };
}

export interface ProfitRow {
  key: string;
  label?: string | null;
  currency: string;
  requests: number;
  credits: number;
  billedMinor: number;
  collectedMinor: number;
  costMinor: number;
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  profitMinor: number;
  marginPct: number | null;
}

export interface ProfitReport {
  from: IsoDate;
  to: IsoDate;
  groupBy: 'day' | 'org' | 'model' | 'feature' | 'tier';
  /** Time zone the API used to cut days. */
  timezone: string;
  rows: ProfitRow[];
}

export interface PlatformUsage {
  id: string;
  orgId: string;
  requestId: string;
  feature: string;
  tier: ModelTier;
  status: string;
  provider: string;
  model: string | null;
  tokens: { input: number; cachedInput: number; cacheWrite: number; output: number };
  credits: number;
  currency: string;
  billedMinor: number;
  shortfallMinor: number;
  costUsdMicros: number;
  costMinor: number;
  profitMinor: number;
  creditRateVersion: number;
  at: IsoDate;
}

export interface AiModel {
  id: string;
  provider: 'anthropic' | 'openai' | 'google' | 'other';
  model: string;
  label: string;
  tier: ModelTier;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cachedInputUsdPerMTok: number;
  /** null: 1.25 × the input price. */
  cacheWriteUsdPerMTok: number | null;
  longContext: {
    thresholdTokens: number;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
  } | null;
  contextWindow: number;
  enabled: boolean;
  isDefaultForTier: boolean;
}

export interface GatewayStatus {
  key: GatewayKey;
  enabled: boolean;
  sandbox: boolean;
  configured: boolean;
  currencies: string[] | 'any';
  updatedAt: IsoDate | null;
  /** Address to paste into the gateway's dashboard for server notifications, if it needs one. */
  webhookUrl: string | null;
  publicConfig: ManualInstructions | null;
}

export interface TenantBilling {
  org: { id: string; name: string; currency: string };
  subscription: Subscription & {
    overrides: {
      addModules: string[];
      removeModules: string[];
      limits: PlanLimits;
      expiresAt?: IsoDate | null;
      note?: string | null;
    };
    source: string;
  };
  wallet: WalletBalance & {
    lowBalanceThresholdMinor: number;
    reconciled: boolean;
    ledgerSumMinor: number;
  };
  ledger: LedgerEntry[];
}

// ------------------------------------------------------------------ commerce

export type ProductStatus = 'active' | 'draft' | 'archived';

export interface Variant {
  id: string;
  title: string;
  optionValues: string[];
  sku: string | null;
  barcode: string | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  costMinor: number | null;
  trackStock: boolean;
  stock: number;
  weightGrams: number | null;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  status: ProductStatus;
  currency: string;
  images: { url: string; fileId: string | null; alt: string }[];
  options: { name: string; values: string[] }[];
  variants: Variant[];
  priceRange: { minMinor: number; maxMinor: number };
  stock: { tracked: boolean; total: number; lowVariants: number | null };
  soldCount: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  productCount?: number;
}

export type StockReason =
  | 'initial'
  | 'adjustment'
  | 'received'
  | 'damaged'
  | 'order'
  | 'order_cancel'
  | 'order_edit'
  | 'return';

export interface StockMovement {
  id: string;
  productId: string;
  variantId: string;
  delta: number;
  stockAfter: number;
  reason: StockReason;
  reference: { type: string; id: string; label?: string } | null;
  note: string | null;
  actor: { type: string; id: string };
  at: IsoDate;
}

export interface Address {
  label?: string;
  name?: string;
  phone?: string;
  line1: string;
  area?: string;
  city?: string;
  district?: string;
  postcode?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  addresses: Address[];
  notes: string;
  tags: string[];
  source: string;
  blocked: boolean;
  stats: {
    orders: number;
    delivered: number;
    cancelled: number;
    returned: number;
    spentMinor: number;
    lastOrderAt: IsoDate | null;
  };
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export type OrderStatus =
  'pending' | 'confirmed' | 'packed' | 'shipped' | 'delivered' | 'cancelled' | 'returned';
export type PaymentMethod =
  'cod' | 'bkash' | 'nagad' | 'rocket' | 'bank' | 'card' | 'cash' | 'other';
export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';

export interface OrderItem {
  productId: string;
  variantId: string;
  name: string;
  variantTitle: string;
  sku: string | null;
  imageUrl: string | null;
  unitPriceMinor: number;
  unitCostMinor: number | null;
  quantity: number;
  totalMinor: number;
  trackStock: boolean;
}

export interface Order {
  id: string;
  number: string;
  status: OrderStatus;
  source: string;
  customerId: string;
  customer: { name: string; phone: string | null; email: string | null };
  shippingAddress: Address;
  items: OrderItem[];
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  totalMinor: number;
  dueMinor: number;
  /** Paid more than the order now costs (items removed after paying). */
  refundDueMinor: number;
  deliveryZone: { id: string; name: string } | null;
  payment: {
    method: PaymentMethod;
    status: OrderPaymentStatus;
    paidMinor: number;
    reference: string | null;
  };
  stockCommitted: boolean;
  customerNote: string;
  internalNote: string;
  cancelReason: string | null;
  history: {
    status: OrderStatus;
    at: IsoDate;
    actor: { type: string; id: string };
    note: string | null;
  }[];
  allowedTransitions: OrderStatus[];
  editable: boolean;
  /** The inbox conversation the order was placed in (by the AI sales agent or staff). */
  conversationId: string | null;
  placedAt: IsoDate;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export type OrderCounts = Record<OrderStatus | 'all', number>;

/** GET /orgs/:orgId/orders/summary. Order value excludes cancelled and returned orders. */
export interface OrdersSummary {
  currency: string;
  timezone: string;
  today: { orders: number; valueMinor: number };
  month: { orders: number; valueMinor: number };
  toHandle: { pending: number; confirmed: number; packed: number };
  shipped: { orders: number; toCollectMinor: number };
  products: { active: number; lowStock: number };
}

export interface DeliveryZone {
  id: string;
  name: string;
  chargeMinor: number;
}

export interface ShopSettings {
  deliveryZones: DeliveryZone[];
  defaultZoneId: string | null;
  invoiceNote: string;
  lowStockThreshold: number;
  autoConfirmManualOrders: boolean;
}

export interface PrintBundle {
  business: {
    name: string;
    legalName: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    website: string | null;
    timezone: string;
    locale: Locale;
  };
  invoiceNote: string;
  orders: Order[];
}

// ------------------------------------------------------------------- inbox

export type ChannelType = 'web_chat' | 'messenger' | 'instagram' | 'whatsapp';

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  status: 'active' | 'disabled' | 'error';
  statusReason: string | null;
  aiEnabled: boolean;
  webChat: {
    publicKey: string;
    allowedOrigins: string[];
    greeting: string;
    color: string;
    askContact: boolean;
  } | null;
  account: { externalId: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  channelId: string;
  name: string;
  phone: string | null;
  email: string | null;
  avatarUrl: string | null;
  customerId: string | null;
  /** What the AI sales agent remembers about the person; staff can correct it. */
  memory: { facts: string[]; address: string | null };
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  channelId: string;
  channelType: ChannelType;
  status: 'open' | 'closed';
  assigneeId: string | null;
  ai: {
    mode: 'auto' | 'paused';
    changedAt: string | null;
    changedBy: { type: string; id: string; name?: string } | null;
    reason: string | null;
  };
  lastMessage: { text: string; at: string; direction: 'in' | 'out'; senderType: string } | null;
  lastMessageAt: string;
  lastInboundAt: string | null;
  unread: number;
  tags: string[];
  locked: boolean;
  contact: Contact | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboxMessage {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  type: 'text' | 'image' | 'file' | 'note' | 'system';
  sender: { type: 'contact' | 'user' | 'ai' | 'system'; id: string | null; name: string | null };
  text: string;
  attachments: {
    url: string;
    contentType: string | null;
    name: string | null;
    size: number | null;
  }[];
  clientId: string | null;
  delivery: { status: string; error: string | null };
  ai: { credits: number } | null;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  name: string;
  isYou: boolean;
}

/** What the website chat widget gets about the business. */
export interface WidgetConfig {
  businessName: string;
  greeting: string;
  color: string;
  askContact: boolean;
  allowedOrigins: string[];
}

export interface VisitorMessage {
  id: string;
  from: 'visitor' | 'business';
  name: string | null;
  type: string;
  text: string;
  attachments: { url: string; contentType: string | null; name: string | null }[];
  clientId: string | null;
  createdAt: string;
}

export interface VisitorContact {
  name: string | null;
  phone: string | null;
  email: string | null;
}

// ------------------------------------------------------------------- AI sales agent

export type AiTone = 'friendly' | 'professional' | 'casual';
export type AiLanguage = 'auto' | 'bn' | 'banglish' | 'en';

export interface AiAgentSettings {
  enabled: boolean;
  assistantName: string;
  tone: AiTone;
  language: AiLanguage;
  tier: ModelTier;
  businessInfo: string;
  instructions: string;
  faqs: { question: string; answer: string }[];
  takeOrders: boolean;
  confirmOrders: boolean;
  handoverKeywords: string[];
  handoverMessage: string;
  replyDelaySeconds: number;
  maxRepliesPerDay: number;
  updatedAt: string;
}

/** GET/PATCH /orgs/:orgId/ai-agent */
export interface AiAgentView {
  settings: AiAgentSettings;
  status: {
    /** The AI service can answer (a provider is set up for the tier's model). */
    serviceReady: boolean;
    /** What a typical reply costs at the chosen tier; null when no price is set. */
    perReply: { credits: number; amountMinor: number; currency: string } | null;
    /** Every quality level: what a typical reply costs and whether it can answer now. */
    tiers: {
      tier: ModelTier;
      available: boolean;
      perReply: { credits: number; amountMinor: number; currency: string } | null;
    }[];
    wallet: { availableMinor: number; currency: string };
    channels: {
      id: string;
      name: string;
      type: ChannelType;
      status: Channel['status'];
      aiEnabled: boolean;
      /** Replies can go out on this channel now. */
      aiCanReply: boolean;
    }[];
  };
}

export type AiHandoverReason =
  | 'customer_request'
  | 'complaint'
  | 'order_problem'
  | 'discount_request'
  | 'cannot_answer'
  | 'other';

/** POST /orgs/:orgId/ai-agent/preview */
export interface AiPreviewResult {
  reply: string;
  outcome: 'reply' | 'refusal' | 'incomplete';
  handover: { reason: AiHandoverReason; summary: string } | null;
  /** A test order number (TEST-ORDER): nothing is saved. */
  order: { number: string } | null;
  toolCalls: { name: string; ok: boolean }[];
  credits: number;
}
