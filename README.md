# sellora-api

The Sellora AI platform API and background workers: accounts, businesses and staff, the
super-admin realm, billing (plans, AI-credit wallet, payments, invoices, withdrawals) and,
milestone by milestone, the inbox, AI agent, commerce, couriers, online stores and landing
pages.

NestJS 12 · TypeScript (strict) · MongoDB 8 (replica set) · Redis 7 + BullMQ · Zod · Vitest.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- What is built and what is not: [docs/TRACKER.md](docs/TRACKER.md)
- Decisions and why: [docs/adr/](docs/adr)
- API reference: OpenAPI at `/v1/docs` when `NODE_ENV` is not production (`npm run openapi:export` writes the JSON).

## Run it locally

You need Node 22.12+ (24 recommended), MongoDB 8 running as a replica set (transactions are
used for money), and Redis 7.

```bash
# MongoDB as a one-node replica set
mongod --replSet rs0 --dbpath ./.mongo --port 27017 --bind_ip 127.0.0.1
mongosh --eval 'rs.initiate()'          # once
redis-server --bind 127.0.0.1 --daemonize yes

npm install
cp .env.example .env
npm run keys:generate                   # prints JWT keys and encryption keys to paste into .env
npm run dev                             # API on :4000, reloads on change
npm run dev:worker                      # renewals, credit grants, mail (separate process)
npm run dev:seed                        # optional: two demo businesses, staff, usage, a platform owner
```

`npm run dev:seed` prints the demo logins. For a real installation, create the first
platform owner with `npm run platform:bootstrap -- owner@example.com "Owner Name"`; it prints
a one-time setup link where the owner sets a password and two-step verification.

The web app (`sellora-web`) proxies `/v1/*` to this API, so in development open
http://localhost:3000 rather than calling :4000 from the browser.

## Configuration

Every setting is an environment variable, validated at start-up (`src/config/env.ts`); the
process refuses to start with a missing or malformed value. `.env.example` documents each one.
Secrets never go in code or in git:

- JWT signing keys (Ed25519) and data-encryption keys come from the environment and support
  rotation (previous public keys / key ids stay readable).
- Payment gateway credentials (SSLCommerz, bKash, Stripe) and manual transfer instructions are
  entered by the super-admin in the admin panel and stored AES-256-GCM encrypted. They are
  never returned by the API.
- AI provider keys are environment variables; model ids and their prices live in the database
  and are edited in the admin panel, so nothing about a provider is hard-coded in features.
  Set `AI_ANTHROPIC_API_KEY` for the AI sales agent (both the API and the worker need it).
  Without it the agent hands every chat to people and the settings page says the AI service
  is unavailable. To demo locally without a key, run `node scripts/claude-stand-in.mjs` and
  set `AI_ANTHROPIC_BASE_URL=http://127.0.0.1:4010` with any key; its replies are scripted.
- Voice notes (ADR 0025): customers' voice notes from Messenger, Instagram and WhatsApp are
  saved privately and play in the inbox with no extra settings. Turning them into text needs
  `AI_OPENAI_API_KEY` (API and worker), an enabled speech-to-text model in Admin › AI credits &
  models (one is seeded) and a voice note price in the credit price list (seeded at 15 credits
  a minute). Optional `VOICE_NOTE_MAX_SECONDS` (default 300). To demo locally without a key,
  run `node scripts/speech-stand-in.mjs` and set
  `AI_OPENAI_BASE_URL=http://127.0.0.1:4100/v1` with any key; it answers a scripted sentence
  and never listens to the recording.
- Value dashboard and reports (ADR 0026) need no settings: they read the business's own
  records and show on the overview and the Analytics page when the plan includes Reports.
- Messenger, Instagram and WhatsApp use one Meta app for the platform: `META_APP_ID`,
  `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` (set all three or none), plus optional
  `META_LOGIN_CONFIG_ID` (Facebook Login for Business) and `META_WHATSAPP_CONFIG_ID` (WhatsApp
  Embedded Signup). In the Meta app dashboard, point the webhook at
  `<API_PUBLIC_URL>/v1/webhooks/meta` with the same verify token, and add
  `<WEB_APP_URL>/app/connect/meta` as a valid OAuth redirect URI. Page and WhatsApp tokens are
  stored encrypted. Without these settings the channels page says Meta channels are off.
  To try the flows locally without a Meta app, run
  `META_APP_SECRET=<same secret> node scripts/graph-stand-in.mjs` and set
  `META_GRAPH_BASE_URL=http://127.0.0.1:4020` for the API and the worker. It is not Meta: it
  knows two demo pages and one WhatsApp number, accepts any login code, and serves demo photos
  (`/__photo/<name>.jpg`, and WhatsApp media ids starting `wa-media-`) and voice clips
  (`/__audio/<name>.mp4`, and WhatsApp media ids starting `wa-voice-`).
- Customers' photos from Messenger, Instagram and WhatsApp are copied into file storage as
  private files (ADR 0012). `CHAT_MEDIA_MAX_MB` (default 16) is the largest one kept; they
  count against the plan's storage. On S3, make only `o/*/products/*` and `o/*/store/*`
  (online store logos and pictures) publicly readable:
  `o/*/chat/*` must stay private (the API serves those to signed-in staff). Photos shown to the
  AI are resized on the server with `sharp` (a prebuilt native module for Linux, macOS and
  Windows; nothing to install separately).
- Couriers (ADR 0013): each business enters its own Steadfast, Pathao or RedX merchant
  credentials in Settings › Couriers; they are checked with the courier, stored encrypted, and
  never returned. The platform only configures addresses: `COURIER_*_BASE_URL` and the sandbox
  URLs default to the couriers' published APIs, `COURIER_*_TRACKING_URL` to their public
  tracking pages. Each courier account shows its own webhook address and secret to paste into
  the courier's panel; without a webhook, parcels are still checked every hour. To try it
  locally without courier accounts, run `node scripts/courier-stand-in.mjs` and point the
  `COURIER_*` URLs at it (the script's header lists them and the demo credentials). It is not a
  courier: nothing is picked up, and statuses move only when you tell it to.
- Online stores (ADR 0014): every store lives at `<handle>.<STOREFRONT_BASE_DOMAIN>` and is
  served by the separate `sellora-storefront` app, which calls `/v1/storefront/*` with
  `STOREFRONT_API_KEY` (the same random value, 32+ characters, set in both apps; it also signs
  preview links and order receipts). In production point a wildcard DNS record and certificate
  for `*.<domain>` at the storefront and set `STOREFRONT_URL_SCHEME=https`. Without the key,
  stores can still be built and approved, but previews answer 503 and no store opens to
  shoppers. The super-admin reviews stores in Admin › Online stores; Admin › Settings can let
  stores open without review when the automatic check finds nothing.
- Custom domains for stores (ADR 0015): set `STOREFRONT_DOMAIN_TARGET` to a host name of the
  storefront server that businesses point a CNAME at (without it, custom domains are off and
  the dashboard says so), and `STOREFRONT_DOMAIN_IPS` to its public addresses to allow bare
  domains (`yourshop.com`) with A/AAAA records. A business proves the domain with a TXT record;
  the worker re-checks waiting domains on a back-off for three days and connected ones daily.
  Proven domains wait for the super-admin in Admin › Online stores › Custom domains unless
  Admin › Settings approves them automatically. `DNS_SERVERS` overrides the system resolvers
  (comma-separated, `host:port` allowed). The plan limit `customDomains` caps domains per
  business (plans saved before this limit existed count as unlimited until edited). Caddy's
  on-demand TLS asks `GET /v1/public/store-domains/check?domain=` before each certificate; the
  storefront README has the configuration. To try it locally, run `node
scripts/dns-stand-in.mjs` (a DNS server for made-up domains whose records you set over HTTP;
  not a DNS provider) and start the API with `DNS_SERVERS=127.0.0.1:5300
STOREFRONT_DOMAIN_TARGET=edge.sellora.test`.
- SMS (ADR 0017): off for every business until it chooses a route in Settings › SMS. A business
  can connect its own BulkSMSBD, Alpha SMS, SSL Wireless or Twilio account (checked with the
  provider, stored encrypted, never returned), or use Sellora SMS, which the super-admin sets up
  in Admin › SMS: connect the platform's provider account, switch it on and set the price and
  cost per SMS part for each currency. Sellora SMS is paid from wallet cash (free credit is for
  AI only). `SMS_*_BASE_URL` default to the providers' published APIs, `SMS_DAILY_LIMIT` caps
  messages per business per day (the super-admin can change it per business), and Twilio
  delivery reports need `API_PUBLIC_URL` to be the address Twilio can reach. To try it locally
  without provider accounts, run `node scripts/sms-stand-in.mjs` and set
  `SMS_BULKSMSBD_BASE_URL=http://127.0.0.1:4060/bulksmsbd` and
  `SMS_ALPHA_BASE_URL=http://127.0.0.1:4060/alpha` (the script's header lists the demo keys). It
  is not an SMS gateway: no phone receives anything; its page at http://127.0.0.1:4060/ shows
  what would have arrived.
- Abandoned cart reminders (ADR 0018): off for every business until it turns them on in
  Marketing › Abandoned carts (needs the marketing module and a working SMS route). The worker
  looks for due reminders every minute (queue `carts`), so run `npm run dev:worker` too. The
  reminder link is `<store address>/r/<code>`; the stop link uses `WEB_APP_URL`. A database
  from before this version has a non-unique index on SMS settings: run
  `npm run db:indexes -- --drop` once to rebuild it as unique (the script says which index
  differs and exits with an error until then).
- Backups (ADR 0020): `npm run keys:generate` prints `BACKUP_ENCRYPTION_KEYS` and
  `BACKUP_ENCRYPTION_ACTIVE_KID`; production refuses to start without them (development falls
  back to the data keys and warns). Keep a copy of the backup keys away from the server:
  without them no backup can be read. The worker makes the nightly backup (queue `backups`,
  checked every 5 minutes) into the configured storage, so run `npm run dev:worker`; settings
  and downloads are in Admin › Backups, restoring one business is on its page in Admin ›
  Businesses. `BACKUP_TMP_DIR` is where files are written before upload (needs room for one
  backup). Set all of `BACKUP_OFFSITE_S3_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY`
  (plus `_ENDPOINT` and `_REGION`) to copy each verified backup to a second bucket. MongoDB
  must be a replica set (backups read one snapshot).
- Merchant backups (ADR 0021): "Download your data" and restore points need nothing more than
  the worker. Daily Google Drive copies need a Google Cloud OAuth client (Web application) with
  `<API_PUBLIC_URL>/v1/backups/google/callback` as its redirect URI and the Drive API turned
  on: set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Without them the Drive card
  says it is not set up. To try it locally, run `node scripts/google-stand-in.mjs` and set the
  `GOOGLE_*` URLs it prints in its header (it is not Google).
- Owner reports and alerts on Telegram (ADR 0022): create a bot with @BotFather and set
  `TELEGRAM_BOT_TOKEN` on the API and the worker. In Admin › Telegram press "Connect" (real
  Telegram needs `API_PUBLIC_URL` to be a public HTTPS address), then "Link a chat". Without a
  token the page says it is not set up and alerts are emailed to the platform owners. To try
  it locally, run `node scripts/telegram-stand-in.mjs` and set the two `TELEGRAM_*` lines in its
  header (it is not Telegram).
- Catalog sync (ADR 0023, Products › Import and sync): needs no keys of ours. Each business
  enters its own Shopify Admin API token or WooCommerce key, which are stored encrypted with
  the `DATA_ENCRYPTION_KEYS`. Optional: `SHOPIFY_API_VERSION` (default `2025-10`) and
  `SYNC_HTTP_TIMEOUT_MS` (default 30000). Requests to the addresses merchants type in never go
  to private or local addresses; `SYNC_ALLOW_PRIVATE_NETWORK=true` lifts that for local tries
  and is refused in production. To try it locally, run `node scripts/shop-stand-in.mjs` (it is
  not Shopify, WooCommerce or Google) and set `SYNC_ALLOW_PRIVATE_NETWORK=true`.
- Website crawl (ADR 0024, "Your website" in Products › Import and sync): needs no keys. The
  business proves it owns the site with a `_sellora-verify` TXT record or a
  `sellora-site-verification` meta tag; DNS questions go to `DNS_SERVERS` when set (as for
  custom domains). Optional: `CRAWL_MAX_PAGES` (default 1000, the most one crawl reads; plans
  can allow fewer with the "Website pages per crawl" limit), `CRAWL_MIN_DELAY_MS` (default 250
  between requests to one site) and `CRAWL_USER_AGENT` (default
  `SelloraBot/1.0 (+<WEB_APP_URL>/bot)`; the web app's `/bot` page explains the crawler). To
  try it locally, run `node scripts/site-stand-in.mjs` (a demo site, not a real shop) with
  `SYNC_ALLOW_PRIVATE_NETWORK=true`, and add `http://localhost:4095`.
- Fraud check: a business's own delivery history needs no settings. The shared delivery
  network between businesses also needs `FRAUD_NETWORK_SECRET` (32+ characters, e.g.
  `openssl rand -hex 32`; it keys the phone-number hashes, so keep it stable), the super-admin
  switch in Admin › Settings (off by default) and each business's opt-in.

## Scripts

| Command                                                       | What it does                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run dev:worker`                          | API / worker with reload (reads `.env`).                                                                                                                                                                                          |
| `npm run build` then `npm start` / `npm run start:worker`     | Production build (SWC) and processes.                                                                                                                                                                                             |
| `npm run typecheck` · `npm run lint` · `npm run format:check` | Static checks.                                                                                                                                                                                                                    |
| `npm test`                                                    | Unit and end-to-end tests (see below).                                                                                                                                                                                            |
| `npm run db:indexes`                                          | Builds every MongoDB index (run on deploy; `MONGODB_AUTO_INDEX=false` in production).                                                                                                                                             |
| `npm run keys:generate`                                       | New JWT key pair and encryption keys.                                                                                                                                                                                             |
| `npm run platform:bootstrap`                                  | First platform owner (only when there are no platform accounts).                                                                                                                                                                  |
| `npm run openapi:export`                                      | Writes the OpenAPI document.                                                                                                                                                                                                      |
| `npm run backup -- verify <file>`                             | Checks a downloaded backup file (`.slbk`) and lists what it holds; `decrypt <file> <out>` writes it as JSON lines; `restore <file> --uri … --db <new>` loads it into an empty database. Needs only `BACKUP_ENCRYPTION_KEYS`.      |
| `npm run dev:seed`                                            | Demo data: two businesses (one with a 12-product catalog for an online store; its pictures are generated patterns), staff, wallet money, AI usage and a platform owner.                                                           |
| `node scripts/claude-stand-in.mjs`                            | Scripted stand-in for the Claude API for local demos without a key (not an AI; cannot see photos, says how many it got).                                                                                                          |
| `node scripts/graph-stand-in.mjs`                             | Stand-in for Meta's Graph API for local demos without a Meta app (not Meta).                                                                                                                                                      |
| `node scripts/courier-stand-in.mjs`                           | Stand-in for the Steadfast, Pathao and RedX APIs for local demos without courier accounts (not a courier).                                                                                                                        |
| `node scripts/dns-stand-in.mjs`                               | DNS server on 127.0.0.1:5300 for trying custom domains with made-up names; records are set over HTTP on :4050 (not a DNS provider or resolver).                                                                                   |
| `node scripts/sms-stand-in.mjs`                               | Stand-in for the BulkSMSBD and Alpha SMS APIs with an inbox page, for local demos without SMS accounts (not an SMS gateway).                                                                                                      |
| `node scripts/google-stand-in.mjs`                            | Stand-in for Google's sign-in and Google Drive with a consent page and a Drive page, for trying Drive backups without a Google client (not Google).                                                                               |
| `node scripts/telegram-stand-in.mjs`                          | Stand-in for the Telegram Bot API with a page of chats you can type in, for trying owner reports, alerts and commands without a bot (not Telegram).                                                                               |
| `node scripts/shop-stand-in.mjs`                              | Stand-in for Shopify's GraphQL Admin API, WooCommerce's REST API and a published sheet on :4090, with a page to change prices and stock, for trying catalog sync (not Shopify, WooCommerce or Google).                            |
| `node scripts/site-stand-in.mjs`                              | A demo shop website on :4095 (robots.txt, sitemap, product pages with schema.org data, delivery and returns pages in Bangla and English), with calls to change prices, hide pages and set the verification tag (not a real shop). |
| `node scripts/speech-stand-in.mjs`                            | Stand-in for an OpenAI-style speech-to-text API on :4100 for trying voice notes without a key; answers a scripted sentence (set the next with `/__say`) and never listens (not speech recognition).                               |

## Tests

```bash
export MONGOMS_SYSTEM_BINARY=/path/to/mongod   # if mongodb-memory-server cannot download one
npm test                                        # needs Redis on 127.0.0.1:6379 (uses DB 15)
```

End-to-end tests boot the real Nest app against a throwaway MongoDB replica set and drive it
over HTTP. Highlights: a suite that calls every business-scoped route with another business's
id and expects 404; wallet concurrency (20 parallel debits never overspend); payment callbacks
including forged and mismatched ones; and checks that merchant responses never contain
provider cost or model fields. Payment gateways are faked in tests
(`test/helpers/fake-gateways.ts`), and so are Meta's Graph API (`test/helpers/fake-meta.ts`,
which checks the bearer token and `appsecret_proof` like Meta does) and the courier APIs
(`test/helpers/fake-couriers.ts`, which can lose a booking reply after creating the parcel);
see the tracker for what that does and does not prove. Courier status checks are also tested
with a real BullMQ worker, so queue behaviour (deduplication, delayed jobs) is not faked.

The S3 storage driver has its own suite (`test/e2e/files-s3.e2e.ts`) that runs against a real
MinIO server. It runs when `MINIO_BINARY` points at a `minio` server binary and is skipped
otherwise:

```bash
MINIO_BINARY=/path/to/minio npm test
```

## Layout

```
src/
  main.ts / worker.ts        HTTP process / background worker process
  bootstrap/                 helmet, CORS, cookies, raw body for webhooks, OpenAPI
  config/                    env schema (Zod) and typed AppConfig
  common/                    request context, crypto, errors (RFC 9457), money, validation
  infra/                     database (tenant guard plugin, transactions), redis, queues,
                             mail, metrics, storage (local disk or S3-compatible driver),
                             realtime (Redis pub/sub relay to Socket.IO)
  modules/
    auth/                    merchant sign-up, login, 2FA, sessions, AccessGuard
    users/ orgs/ iam/        people, businesses, staff, roles, permissions
    platform/                super-admin realm: login, admins, tenants, settings
    audit/                   hash-chained audit log
    billing/                 plans, entitlements, wallet + ledger, AI credits, payments,
                             invoices, withdrawals, platform analytics, jobs
    files/                   uploads, per-business storage limit, file serving, cleanup
    commerce/                products, stock, customers, orders, printing
    inbox/                   channels, contacts, conversations, messages, website chat,
                             live updates (Socket.IO gateways)
    ai/                      AI sales agent: provider interface (Claude), settings, prompt,
                             tools, metered tool loop, reply queue and handover (ADR 0010)
    meta/                    Messenger, Instagram, WhatsApp: Graph API client, webhook
                             parsing, inbound events, outbox sender, connect flows (ADR 0011)
    couriers/ fraud/         courier bookings and status checks; delivery risk (ADR 0013)
    stores/                  online stores, launch review, storefront API, custom domains
                             (ADR 0014, 0015)
    landing-pages/           landing pages: sections, offer, templates, review, versions,
                             storefront view and orders, visit numbers (ADR 0016)
    sms/                     SMS provider adapters, Sellora SMS and wallet charging, order
                             messages, sender names, opt-outs, delivery reports (ADR 0017)
    health/                  liveness and readiness
test/
  e2e/                       HTTP tests per area, including tenancy.e2e.ts
  helpers/                   test app, fake gateways, fake Anthropic API, fake Graph API,
                             route inventory
scripts/                     keys, bootstrap, indexes, dev seed
```

## Deploying (Railway or Render)

`DEPLOY.md` at the root of the GitHub repository walks through a first deploy on Railway (API,
worker, web app and Redis) with MongoDB Atlas, Cloudflare R2 and SMTP; `render.yaml` there is
the same on Render. `Dockerfile` in this folder builds one image for both processes:
`node dist/main.js` (the default) and `node dist/worker.js`. Without a shell on the server,
set `PLATFORM_BOOTSTRAP_EMAIL` for the first start: the API creates that platform owner and
logs a one-time setup link. `HOST` sets the listen address (`::` for IPv6 private networks).

## Deploying (VPS)

Run two processes from the same build: `node dist/main.js` (behind Nginx or Caddy with TLS,
several instances are fine) and `node dist/worker.js` (one or more). Use MongoDB Atlas or a
three-node replica set, and Redis with persistence (a separate Redis for queues is
recommended, see `REDIS_QUEUE_URL`). Set `NODE_ENV=production`, `COOKIE_SECURE=true`,
`COOKIE_DOMAIN` to the shared parent domain, `TRUST_PROXY_HOPS` to the number of proxies,
`MAIL_TRANSPORT=smtp`, and run `npm run db:indexes` on each release.

File storage: with `STORAGE_DRIVER=local` (one server) set `STORAGE_SIGNING_SECRET` and keep
`STORAGE_LOCAL_DIR` on a persistent disk that is backed up. With `STORAGE_DRIVER=s3` (several
servers, or a CDN), create a bucket, give it a CORS rule that allows `PUT` from `WEB_APP_URL`
with the `content-type` header, and either make the bucket public behind a CDN and set
`S3_PUBLIC_BASE_URL`, or leave that empty and the API serves files itself. Photo URLs are
saved on products when they are added, so changing `S3_PUBLIC_BASE_URL` later needs the stored
URLs rewritten. `/v1/health/live` and
`/v1/health/ready` are for the load balancer;
live updates use Socket.IO on `/socket.io` (proxy WebSocket upgrades; with several API
instances turn on sticky sessions for it). Set `WEBCHAT_TOKEN_SECRET` (required in
production); `/metrics` serves Prometheus metrics when
`METRICS_TOKEN` is set.
