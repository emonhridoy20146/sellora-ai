import { isIP } from 'node:net';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** A URL with a default; an empty value (as in a copied .env.example) means the default. */
const urlWithDefault = (fallback: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.url().default(fallback));

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Every environment variable the API reads. Parsing fails fast at boot with a readable
 * message, so a misconfigured deployment never starts half-working.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('Sellora AI'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /**
     * Address the API listens on. 0.0.0.0 is IPv4 only; `::` also takes IPv6, which some
     * hosts' private networks use (Railway environments made before mid-October 2025).
     */
    HOST: z.string().trim().min(1).default('0.0.0.0'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
    WEB_APP_URL: z.url().default('http://localhost:3000'),
    /**
     * Stores live at <handle>.<STOREFRONT_BASE_DOMAIN>. May carry a port in development
     * (sellora.localhost:3100); browsers send *.localhost to this machine.
     */
    STOREFRONT_BASE_DOMAIN: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9.-]+(:\d{2,5})?$/, 'a domain, optionally with :port')
      .default('sellora.localhost'),
    STOREFRONT_URL_SCHEME: z.enum(['http', 'https']).default('https'),
    /**
     * Shared secret the storefront app sends as X-Storefront-Key on every call to the
     * storefront routes. Also keys the store preview and order receipt links. Without it the
     * storefront routes answer 503 and no store can open.
     */
    STOREFRONT_API_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32).optional(),
    ),
    /**
     * Custom domains (ADR 0015). Businesses point a CNAME at STOREFRONT_DOMAIN_TARGET (a host
     * that reaches the storefront); apex domains use A/AAAA records with STOREFRONT_DOMAIN_IPS.
     * Without a target, custom domains are off. DNS_SERVERS (host or host:port, comma
     * separated) are asked when checking a domain's records; empty means the system's.
     */
    STOREFRONT_DOMAIN_TARGET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/, 'a host name')
        .optional(),
    ),
    STOREFRONT_DOMAIN_IPS: csv
      .default([])
      .refine((ips) => ips.every((ip) => isIP(ip) !== 0), 'IPv4 or IPv6 addresses'),
    DNS_SERVERS: csv.default([]),
    CORS_ORIGINS: csv.default(['http://localhost:3000']),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: bool.default(false),

    MONGODB_URI: z.string().min(1),
    MONGODB_DB_NAME: z.string().min(1).default('sellora'),
    MONGODB_AUTO_INDEX: bool.default(true),

    REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379/0'),
    REDIS_QUEUE_URL: z.string().optional(),
    REDIS_KEY_PREFIX: z.string().default('sl:'),

    JWT_ISSUER: z.string().default('sellora-api'),
    JWT_KEY_ID: z.string().min(1),
    JWT_PRIVATE_KEY: z.string().min(1).describe('base64 encoded PKCS8 PEM (Ed25519)'),
    JWT_PUBLIC_KEY: z.string().min(1).describe('base64 encoded SPKI PEM (Ed25519)'),
    JWT_PREVIOUS_PUBLIC_KEYS: z
      .string()
      .optional()
      .describe('JSON array of {"kid":"..","pem":"base64"} accepted during key rotation'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    REFRESH_TOKEN_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    PLATFORM_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
    PLATFORM_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),

    DATA_ENCRYPTION_KEYS: z
      .string()
      .min(1)
      .describe('Comma separated kid:base64key pairs, each key 32 bytes'),
    DATA_ENCRYPTION_ACTIVE_KID: z.string().min(1),

    MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default('Sellora AI <no-reply@sellora.localhost>'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./storage'),
    STORAGE_SIGNING_SECRET: z.string().min(32).optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default(true),
    S3_PUBLIC_BASE_URL: z.string().optional(),
    /** Largest photo a merchant may upload, in megabytes. */
    FILE_MAX_IMAGE_MB: z.coerce.number().min(1).max(100).default(10),
    /** Largest photo from a customer's chat that is saved, in megabytes. */
    CHAT_MEDIA_MAX_MB: z.coerce.number().min(1).max(100).default(16),
    /** How long an upload link stays valid. */
    STORAGE_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),

    /**
     * Backups (ADR 0020): `kid:base64` 32-byte keys, comma-separated, and the one that
     * encrypts new backups. Development falls back to the data keys; production needs them.
     */
    BACKUP_ENCRYPTION_KEYS: z.string().optional(),
    BACKUP_ENCRYPTION_ACTIVE_KID: z.string().optional(),
    /** Where a backup is written before it is uploaded. Empty: the system's temporary folder. */
    BACKUP_TMP_DIR: z.string().optional(),
    /** A second S3-compatible bucket (another provider and region) for off-site copies. */
    BACKUP_OFFSITE_S3_ENDPOINT: z.string().optional(),
    BACKUP_OFFSITE_S3_REGION: z.string().default('auto'),
    BACKUP_OFFSITE_S3_BUCKET: z.string().optional(),
    BACKUP_OFFSITE_S3_ACCESS_KEY_ID: z.string().optional(),
    BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY: z.string().optional(),
    BACKUP_OFFSITE_S3_FORCE_PATH_STYLE: bool.default(true),
    /** Google Drive copies for merchants (ADR 0021): a Google Cloud OAuth client. */
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_AUTH_URL: z.url().default('https://accounts.google.com/o/oauth2/v2/auth'),
    GOOGLE_OAUTH_TOKEN_URL: z.url().default('https://oauth2.googleapis.com/token'),
    GOOGLE_OAUTH_REVOKE_URL: z.url().default('https://oauth2.googleapis.com/revoke'),
    /** Drive API and uploads (`/drive/v3`, `/upload/drive/v3`). */
    GOOGLE_API_URL: z.url().default('https://www.googleapis.com'),

    METRICS_TOKEN: z.string().min(16).optional(),

    /** The bot that sends owner reports and alerts (ADR 0022), from @BotFather. Secret. */
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'Expected a bot token like 123456:ABC…')
      .optional(),
    /** Telegram's Bot API; a stand-in can play it locally. */
    TELEGRAM_API_URL: z.url().default('https://api.telegram.org'),

    WEBCHAT_TOKEN_SECRET: z.string().min(32).optional(),

    /**
     * Catalog sync (ADR 0023). Shopify Admin API version (YYYY-MM); change it when Shopify
     * retires the version in use.
     */
    SHOPIFY_API_VERSION: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .default('2025-10'),
    /** How long one request to a shop, sheet or photo may take. */
    SYNC_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    /**
     * Lets syncs reach private and loopback addresses (stand-ins on localhost). Only for local
     * development and tests; refused in production.
     */
    SYNC_ALLOW_PRIVATE_NETWORK: bool.default(false),
    /**
     * Website crawl (ADR 0024). Most pages one crawl reads, whatever the plan allows; the
     * user agent sites see (empty: "SelloraBot/1.0 (+<WEB_APP_URL>/bot)"); and the least time
     * between two requests to one site (robots.txt may ask for more).
     */
    CRAWL_MAX_PAGES: z.coerce.number().int().min(1).max(20_000).default(1_000),
    CRAWL_USER_AGENT: z.string().max(200).optional(),
    CRAWL_MIN_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(250),

    /**
     * Keyword search volumes for the SEO studio (ADR 0032), from DataForSEO's Google Ads data.
     * Without a login keyword ideas show without volumes.
     */
    KEYWORDS_DATAFORSEO_LOGIN: z.string().optional(),
    KEYWORDS_DATAFORSEO_PASSWORD: z.string().optional(),
    KEYWORDS_DATAFORSEO_URL: urlWithDefault('https://api.dataforseo.com'),
    /** Google Ads location the volumes are for (2050: Bangladesh). */
    KEYWORDS_LOCATION_CODE: z.coerce.number().int().min(1).default(2050),

    AI_ANTHROPIC_API_KEY: z.string().optional(),
    /** Only for a gateway or proxy in front of the Anthropic API. Empty: the public API. */
    AI_ANTHROPIC_BASE_URL: z.union([z.url(), z.literal('')]).optional(),
    /**
     * OpenAI, used for speech-to-text on customers' voice notes (ADR 0025). The base URL may
     * point at any service with the same API (Groq, a self-hosted Whisper server). Without
     * a key voice notes stay audio only.
     */
    AI_OPENAI_API_KEY: z.string().optional(),
    AI_OPENAI_BASE_URL: z.union([z.url(), z.literal('')]).optional(),
    /** Longer voice notes are kept and playable but not turned into text. */
    VOICE_NOTE_MAX_SECONDS: z.coerce.number().int().min(10).max(3_600).default(300),

    /** The platform's Meta app (Messenger, Instagram, WhatsApp). Without it those channels are off. */
    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
    /** The string Meta echoes when the webhook is registered in the app dashboard. */
    META_WEBHOOK_VERIFY_TOKEN: z.string().min(16).optional(),
    /** Facebook Login for Business configuration id; empty uses the classic scope list. */
    META_LOGIN_CONFIG_ID: z.string().optional(),
    /** WhatsApp Embedded Signup configuration id; empty hides the one-click WhatsApp button. */
    META_WHATSAPP_CONFIG_ID: z.string().optional(),
    /** Graph API version, e.g. v23.0. Change it when Meta retires the version in use. */
    META_GRAPH_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default('v23.0'),
    /** Only for a stand-in or proxy in front of the Graph API. Empty: graph.facebook.com. */
    META_GRAPH_BASE_URL: z.union([z.url(), z.literal('')]).optional(),

    /**
     * Payment gateway APIs (ADR 0029): shoppers paying businesses at checkout, and the
     * platform's own SSLCommerz and bKash billing. The defaults are the gateways' published
     * live and sandbox addresses; change them only when a gateway moves or for a local stand-in.
     */
    PAYMENT_BKASH_LIVE_URL: urlWithDefault('https://tokenized.pay.bka.sh/v1.2.0-beta'),
    PAYMENT_BKASH_SANDBOX_URL: urlWithDefault('https://tokenized.sandbox.bka.sh/v1.2.0-beta'),
    PAYMENT_SSLCOMMERZ_LIVE_URL: urlWithDefault('https://securepay.sslcommerz.com'),
    PAYMENT_SSLCOMMERZ_SANDBOX_URL: urlWithDefault('https://sandbox.sslcommerz.com'),
    PAYMENT_NAGAD_LIVE_URL: urlWithDefault('https://api.mynagad.com'),
    PAYMENT_NAGAD_SANDBOX_URL: urlWithDefault(
      'http://sandbox.mynagad.com:10080/remote-payment-gateway-1.0',
    ),
    PAYMENT_AAMARPAY_LIVE_URL: urlWithDefault('https://secure.aamarpay.com'),
    PAYMENT_AAMARPAY_SANDBOX_URL: urlWithDefault('https://sandbox.aamarpay.com'),
    PAYMENT_SHURJOPAY_LIVE_URL: urlWithDefault('https://engine.shurjopayment.com'),
    PAYMENT_SHURJOPAY_SANDBOX_URL: urlWithDefault('https://sandbox.shurjopayment.com'),
    /**
     * Ad platforms' server APIs for the businesses' own pixels (ADR 0030): Meta Conversions
     * API (with META_GRAPH_VERSION), TikTok Events API and GA4 Measurement Protocol. Change
     * them only for a proxy or the local stand-in (scripts/tracking-stand-in.mjs).
     */
    TRACKING_META_BASE_URL: urlWithDefault('https://graph.facebook.com'),
    TRACKING_TIKTOK_BASE_URL: urlWithDefault('https://business-api.tiktok.com'),
    TRACKING_GA4_BASE_URL: urlWithDefault('https://www.google-analytics.com'),
    /**
     * Courier APIs. The defaults are the couriers' published production and sandbox
     * addresses; change them only when a courier moves its API or for a local stand-in.
     */
    COURIER_STEADFAST_BASE_URL: urlWithDefault('https://portal.packzy.com/api/v1'),
    COURIER_PATHAO_BASE_URL: urlWithDefault('https://api-hermes.pathao.com'),
    COURIER_PATHAO_SANDBOX_URL: urlWithDefault('https://courier-api-sandbox.pathao.com'),
    COURIER_REDX_BASE_URL: urlWithDefault('https://openapi.redx.com.bd/v1.0.0-beta'),
    COURIER_REDX_SANDBOX_URL: urlWithDefault('https://sandbox.redx.com.bd/v1.0.0-beta'),
    /**
     * Public tracking pages shown to staff and customers. {tracking}, {consignment} and
     * {phone} are filled in; an empty value hides the link for that courier.
     */
    COURIER_STEADFAST_TRACKING_URL: z.string().default('https://steadfast.com.bd/t/{tracking}'),
    COURIER_PATHAO_TRACKING_URL: z
      .string()
      .default('https://merchant.pathao.com/tracking?consignment_id={consignment}&phone={phone}'),
    COURIER_REDX_TRACKING_URL: z
      .string()
      .default('https://redx.com.bd/track-parcel/?trackingId={tracking}'),
    /** How long to wait for a courier's API before giving up on a request. */
    COURIER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),

    /**
     * SMS provider APIs (ADR 0017). The defaults are the providers' published addresses;
     * change them only when a provider moves its API or for a local stand-in.
     */
    SMS_BULKSMSBD_BASE_URL: urlWithDefault('https://bulksmsbd.net'),
    SMS_ALPHA_BASE_URL: urlWithDefault('https://api.sms.net.bd'),
    SMS_SSL_WIRELESS_BASE_URL: urlWithDefault('https://smsplus.sslwireless.com'),
    SMS_TWILIO_BASE_URL: urlWithDefault('https://api.twilio.com'),
    /** How long to wait for an SMS provider before giving up on a request. */
    SMS_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    /** Messages one business may send a day unless the super-admin sets its own limit. */
    SMS_DAILY_LIMIT: z.coerce.number().int().min(0).max(1_000_000).default(1_000),

    /**
     * Keys the phone-number hashes of the shared delivery network (fraud check). Without it
     * the network stays off even when the super-admin switches it on. Changing it starts the
     * network from zero, as old hashes no longer match.
     */
    FRAUD_NETWORK_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32).optional(),
    ),

    /** Insert the starter plans, AI models and credit price list when missing (never overwrites). */
    BILLING_SEED_DEFAULTS: bool.default(true),
    /**
     * First deploy without a shell: when set and no platform account exists yet, the API
     * creates this platform owner at start and logs a one-time setup link (valid 24 hours).
     * Ignored once any platform account exists; remove it after setting up.
     */
    PLATFORM_BOOTSTRAP_EMAIL: z
      .preprocess((v) => (v === '' ? undefined : v), z.email().optional())
      .transform((v) => v?.toLowerCase()),
    PLATFORM_BOOTSTRAP_NAME: z
      .preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).max(100).optional())
      .transform((v) => v ?? 'Platform owner'),
    /** Time zone that platform-wide reports (AI profit per day) use to cut days. */
    PLATFORM_REPORT_TIMEZONE: z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown time zone')
      .default('Asia/Dhaka'),

    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(10).default(600),
    RATE_LIMIT_AUTH_PER_15MIN: z.coerce.number().int().min(3).default(20),
    /** Scales every per-IP limit (e.g. behind a carrier-grade NAT, or in tests). */
    RATE_LIMIT_IP_MULTIPLIER: z.coerce.number().int().min(1).max(10_000).default(1),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      if (env.MAIL_TRANSPORT === 'log') {
        ctx.addIssue({
          code: 'custom',
          path: ['MAIL_TRANSPORT'],
          message: 'log transport is not allowed in production',
        });
      }
      if (env.STOREFRONT_URL_SCHEME !== 'https') {
        ctx.addIssue({
          code: 'custom',
          path: ['STOREFRONT_URL_SCHEME'],
          message: 'must be https in production',
        });
      }
      if (!env.WEBCHAT_TOKEN_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBCHAT_TOKEN_SECRET'],
          message: 'required in production (signs website chat visitor tokens)',
        });
      }
      if (!env.BACKUP_ENCRYPTION_KEYS) {
        ctx.addIssue({
          code: 'custom',
          path: ['BACKUP_ENCRYPTION_KEYS'],
          message: 'required in production (encrypts backups; keep a copy away from them)',
        });
      }
      if (env.SYNC_ALLOW_PRIVATE_NETWORK) {
        ctx.addIssue({
          code: 'custom',
          path: ['SYNC_ALLOW_PRIVATE_NETWORK'],
          message: 'must be false in production (syncs must not reach private addresses)',
        });
      }
      if (env.STORAGE_DRIVER === 'local' && !env.STORAGE_SIGNING_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['STORAGE_SIGNING_SECRET'],
          message: 'required in production when STORAGE_DRIVER=local',
        });
      }
    }
    if (
      env.STORAGE_DRIVER === 's3' &&
      (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message:
          'S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for the s3 driver',
      });
    }
    if (
      Boolean(env.META_APP_ID) !== Boolean(env.META_APP_SECRET) ||
      (env.META_APP_ID && !env.META_WEBHOOK_VERIFY_TOKEN)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['META_APP_ID'],
        message: 'META_APP_ID, META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN go together',
      });
    }
    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'required when MAIL_TRANSPORT=smtp',
      });
    }
    if (env.BACKUP_ENCRYPTION_KEYS) {
      const backupKids = env.BACKUP_ENCRYPTION_KEYS.split(',').map((p) => p.trim().split(':')[0]);
      if (
        !env.BACKUP_ENCRYPTION_ACTIVE_KID ||
        !backupKids.includes(env.BACKUP_ENCRYPTION_ACTIVE_KID)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['BACKUP_ENCRYPTION_ACTIVE_KID'],
          message: 'must match a kid in BACKUP_ENCRYPTION_KEYS',
        });
    }
    const offsite = [
      env.BACKUP_OFFSITE_S3_BUCKET,
      env.BACKUP_OFFSITE_S3_ACCESS_KEY_ID,
      env.BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY,
    ];
    if (offsite.some(Boolean) && !offsite.every(Boolean))
      ctx.addIssue({
        code: 'custom',
        path: ['BACKUP_OFFSITE_S3_BUCKET'],
        message:
          'BACKUP_OFFSITE_S3_BUCKET, BACKUP_OFFSITE_S3_ACCESS_KEY_ID and BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY go together',
      });
    if (Boolean(env.KEYWORDS_DATAFORSEO_LOGIN) !== Boolean(env.KEYWORDS_DATAFORSEO_PASSWORD))
      ctx.addIssue({
        code: 'custom',
        path: ['KEYWORDS_DATAFORSEO_LOGIN'],
        message: 'KEYWORDS_DATAFORSEO_LOGIN and KEYWORDS_DATAFORSEO_PASSWORD go together',
      });
    if (Boolean(env.GOOGLE_OAUTH_CLIENT_ID) !== Boolean(env.GOOGLE_OAUTH_CLIENT_SECRET))
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_OAUTH_CLIENT_ID'],
        message: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET go together',
      });
    const kids = env.DATA_ENCRYPTION_KEYS.split(',').map((p) => p.split(':')[0]);
    if (!kids.includes(env.DATA_ENCRYPTION_ACTIVE_KID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATA_ENCRYPTION_ACTIVE_KID'],
        message: 'must match a kid in DATA_ENCRYPTION_KEYS',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Settings where an empty value means something ("hide the link"), not "use the default". */
const EMPTY_MEANS_OFF = new Set([
  'COURIER_STEADFAST_TRACKING_URL',
  'COURIER_PATHAO_TRACKING_URL',
  'COURIER_REDX_TRACKING_URL',
]);

/**
 * Reads the environment. A variable set to an empty string (`NAME=` copied from
 * .env.example, or left blank in a host's dashboard) counts as not set, except the few where
 * empty has its own meaning.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (value !== '' || EMPTY_MEANS_OFF.has(key)) cleaned[key] = value;
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
