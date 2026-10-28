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

    METRICS_TOKEN: z.string().min(16).optional(),

    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),

    WEBCHAT_TOKEN_SECRET: z.string().min(32).optional(),

    AI_ANTHROPIC_API_KEY: z.string().optional(),
    /** Only for a gateway or proxy in front of the Anthropic API. Empty: the public API. */
    AI_ANTHROPIC_BASE_URL: z.union([z.url(), z.literal('')]).optional(),
    AI_OPENAI_API_KEY: z.string().optional(),
    AI_OPENAI_BASE_URL: z.string().optional(),

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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
