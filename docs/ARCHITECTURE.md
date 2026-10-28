# Architecture

Sellora AI is a multi-tenant SaaS. A **business** (organization, `orgId`) is the tenant; people
belong to businesses through memberships with roles. A separate **platform** realm is for the
people who run Sellora (the super-admin panel).

```
 Browser ──► sellora-web (Next.js) ──/v1/* proxy──► sellora-api (NestJS, HTTP)
                                                        │
 Payment gateways ──callbacks / webhooks──────────────► │
 Meta (Messenger, Instagram, WhatsApp) ──webhooks─────► │ ◄──Graph API (worker sends replies)
                                                        ├── MongoDB (replica set): all data, JSON only
                                                        ├── Redis: rate limits, locks, caches
                                                        ├── BullMQ queues ──► sellora-api worker
                                                        │                      (mail, renewals, credit
                                                        │                       grants, reservations,
                                                        │                       AI replies, Meta webhooks,
                                                        │                       outgoing messages and
                                                        │                       customers' photos)
                                                        ├── File storage: local disk or S3-compatible
                                                        │   (product photos public, chat photos private)
                                                        └── Telegram: platform stats (planned, not built)
```

Repositories are separate (no monorepo): `sellora-api` (this), `sellora-web` (marketing site,
merchant dashboard, super-admin panel) and later `sellora-storefront` (customer-facing stores
and landing pages). See [ADR 0003](adr/0003-separate-repositories.md).

## Request lifecycle

1. **Bootstrap** (`src/bootstrap/configure-app.ts`): Helmet, CORS from `CORS_ORIGINS`, cookie
   parser, raw body kept for webhook signature checks, URI versioning (`/v1`).
2. **Request context** (`common/context/request-context.ts`): an AsyncLocalStorage store with
   the request id, actor and, once resolved, the tenant. Everything below reads it.
3. **AccessGuard** (`modules/auth/guards/access.guard.ts`), one guard for every route, in order:
   - **Authentication.** Access tokens are short-lived Ed25519 JWTs in httpOnly cookies
     (`sl_at` for merchants, `slp_at` for the platform, each scoped to its own path) or a
     bearer header for API clients. The token's session id is checked against the session
     store, so sign-out and "sign out everywhere" take effect immediately.
   - **CSRF.** Cookie-authenticated writes must send `x-csrf-token` matching the readable
     `sl_csrf` / `slp_csrf` cookie (double submit), and the `Origin` must be allowed.
   - **Tenant.** Routes under `/v1/orgs/:orgId/…` resolve the membership; a missing or
     foreign business is a 404 (never 403, so ids cannot be probed). Suspended businesses and
     members are refused.
   - **Permissions.** `@RequirePermissions('…')` against the member's role; platform routes use
     `@RequirePlatformPermissions('…')` against the fixed platform roles.
   - **Plan module.** `@RequireModule('…')` answers `402 module_not_in_plan` when the
     business's plan (plus overrides) does not include the module.
4. **Validation**: Zod schemas through `@ZodBody`, `@ZodQuery`, `@ZodParam`; unknown fields are
   rejected (`.strict()`).
5. **Errors**: one filter turns every error into RFC 9457 problem details
   `{type, title, status, code, detail, instance, requestId, errors?}` with field paths like
   `body.email`.

## Tenant isolation (defence in depth)

- Tenant collections carry `orgId`. Repositories add it to every query.
- `tenantGuardPlugin` (`infra/database/tenant-guard.plugin.ts`) runs on every Mongoose query,
  update, aggregate and save of a tenant collection, in every environment. It throws unless
  the filter is pinned to exactly one `orgId` that equals the request's tenant, and it refuses
  updates that would move a document to another tenant. Platform code that must read across
  tenants passes the explicit `crossTenant` option, which is easy to grep and review.
- `test/e2e/tenancy.e2e.ts` walks the route inventory and calls every business route with
  another business's id.

## Audit log

`modules/audit` writes an append-only event for sign-ins, permission changes, money movements
and every platform action. Each scope (the platform, and each business) is a hash chain: an
event stores the previous event's hash and its own SHA-256 over its content. `GET
/v1/platform/audit-events/verify/:scope` recomputes the chain and reports the first broken
entry (missing, edited, or truncated). Merchants see their own business's log.

## Money

- Amounts are integers in the currency's minor unit (paisa for BDT). No floats touch money.
- **Wallet** (`billing/wallet.service.ts`): one document per business holds `balanceMinor`,
  `heldMinor` and `bonusMinor`, and an append-only **ledger** records every movement. Each
  movement is a single conditional update (it cannot overdraw) plus one ledger row in the
  same transaction, keyed by an idempotency key so a retried callback cannot apply twice.
  Reconciliation compares the wallet with the ledger sum.
- **Funding rules**: AI usage spends free credit (bonus) first, then cash; plans and
  withdrawals use cash only; free credit is never withdrawable.
- **AI credits** (`billing/credits.service.ts`, `credit-math.ts`): the super-admin publishes
  versioned price lists (price of one credit, credits per 1,000 input/output tokens for the
  fast, standard and advanced tiers, a per-call minimum, and the USD exchange rate). Each AI
  call reserves its worst case, then settles on real token counts using integer maths in
  hundredths of a credit, rounding up. Every usage record keeps the provider, model, tokens,
  credits, the amount billed, the provider cost (from the model's USD prices in the
  database) and the price-list version, so profit is exact per call. Merchant responses never
  include cost or model fields (tested).
- **Subscriptions** (`subscriptions.service.ts`): trial, paid from the wallet with pro-rata
  credit when switching, automatic renewal, past due with a grace period, fall back to Free.
  The price is locked on the subscription; plan edits apply to new subscriptions.
- **Payments** (`billing/payments/`): SSLCommerz, bKash and Stripe adapters plus manual
  transfers. A payment is credited only after the gateway confirms the exact amount and
  currency server-to-server (validation API, execute/query, or a signed webhook); browser
  redirects alone never credit money. Gateway credentials are stored encrypted per gateway.
- **Withdrawals**: request holds the cash; the super-admin approves or rejects, then marks
  paid with a payout reference. Disabled by default (platform setting) pending legal review.

## Background work

`src/worker.ts` runs BullMQ processors: outgoing mail, and a maintenance queue whose
repeatable jobs (one runner per tick across the cluster) handle subscription renewals and
expiries, monthly included-credit grants, releasing reservations left by crashed AI calls, and
ending expired demo access. Jobs are idempotent, so retries are safe.

The `ai` queue runs the AI sales agent's replies (ADR 0010): the API schedules a job when a
customer writes, and the worker answers after the business's reply delay, one reply at a time
per conversation, reserving and settling AI credits for every model turn.

Messenger, Instagram and WhatsApp use two more queues (ADR 0011). `webhooks`: the API checks a
webhook's signature, enqueues the body and answers Meta at once; the worker stores the events
one at a time so a customer's messages keep their order. `outbox`: every reply on a Meta
channel, from staff or the AI, is stored as `pending` first and sent by the worker through the
Graph API, split to the channel's length limit, in order within a conversation, with retries
for rate limits and outages. A revoked token marks the channel "needs reconnecting", and open
inboxes hear it live (`channel.updated`).

The `media` queue copies customers' photos from Meta into the business's private storage
(ADR 0012): messages are stored at once with the photo `pending`, the worker downloads it from
Meta's hosts only, checks its real type and size against the plan's storage, and marks it
ready or failed with a reason. The AI reply job waits up to 20 s for a pending photo, then
shows the newest saved photos to models that can see images.

## Configuration and secrets

`config/env.ts` validates every variable at start-up. Secrets (JWT keys, data-encryption keys,
SMTP, storage, AI keys) only come from the environment; gateway credentials from the encrypted
database records the admin panel writes. Nothing tenant- or provider-specific is hard-coded in
feature code: plans, modules, limits, credit prices, model ids and model prices are data.

## Super-admin realm

Platform accounts are separate from merchant accounts (own collection, cookies, token
lifetimes). Two-step verification is mandatory: a password alone only yields a short
challenge token. Roles are owner, admin, finance, support and read-only; an admin can only
manage roles below their own, and the last active owner cannot be removed.
