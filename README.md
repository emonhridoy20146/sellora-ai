# sellora-api

The Sellora AI platform API and background workers: accounts, businesses and staff, the
super-admin realm, billing (plans, AI-credit wallet, payments, invoices, withdrawals) and,
milestone by milestone, the inbox, AI agent, commerce and store features.

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
npm run dev:seed                        # optional: demo business, staff, usage, a platform owner
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

## Scripts

| Command                                                       | What it does                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run dev:worker`                          | API / worker with reload (reads `.env`).                                              |
| `npm run build` then `npm start` / `npm run start:worker`     | Production build (SWC) and processes.                                                 |
| `npm run typecheck` · `npm run lint` · `npm run format:check` | Static checks.                                                                        |
| `npm test`                                                    | Unit and end-to-end tests (see below).                                                |
| `npm run db:indexes`                                          | Builds every MongoDB index (run on deploy; `MONGODB_AUTO_INDEX=false` in production). |
| `npm run keys:generate`                                       | New JWT key pair and encryption keys.                                                 |
| `npm run platform:bootstrap`                                  | First platform owner (only when there are no platform accounts).                      |
| `npm run openapi:export`                                      | Writes the OpenAPI document.                                                          |

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
(`test/helpers/fake-gateways.ts`); see the tracker for what that does and does not prove.

## Layout

```
src/
  main.ts / worker.ts        HTTP process / background worker process
  bootstrap/                 helmet, CORS, cookies, raw body for webhooks, OpenAPI
  config/                    env schema (Zod) and typed AppConfig
  common/                    request context, crypto, errors (RFC 9457), money, validation
  infra/                     database (tenant guard plugin, transactions), redis, queues,
                             mail, metrics (storage and telegram folders are placeholders)
  modules/
    auth/                    merchant sign-up, login, 2FA, sessions, AccessGuard
    users/ orgs/ iam/        people, businesses, staff, roles, permissions
    platform/                super-admin realm: login, admins, tenants, settings
    audit/                   hash-chained audit log
    billing/                 plans, entitlements, wallet + ledger, AI credits, payments,
                             invoices, withdrawals, platform analytics, jobs
test/
  e2e/                       HTTP tests per area, including tenancy.e2e.ts
  helpers/                   test app, fake gateways, route inventory
scripts/                     keys, bootstrap, indexes, dev seed
```

## Deploying (VPS)

Run two processes from the same build: `node dist/main.js` (behind Nginx or Caddy with TLS,
several instances are fine) and `node dist/worker.js` (one or more). Use MongoDB Atlas or a
three-node replica set, and Redis with persistence (a separate Redis for queues is
recommended, see `REDIS_QUEUE_URL`). Set `NODE_ENV=production`, `COOKIE_SECURE=true`,
`COOKIE_DOMAIN` to the shared parent domain, `TRUST_PROXY_HOPS` to the number of proxies,
`MAIL_TRANSPORT=smtp`, and run `npm run db:indexes` on each release. `/v1/health/live` and
`/v1/health/ready` are for the load balancer; `/metrics` serves Prometheus metrics when
`METRICS_TOKEN` is set.
