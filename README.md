# sellora-web

The Sellora AI web app: the public marketing site, the merchant dashboard (`/app`) and the
super-admin panel (`/admin`). It talks only to [sellora-api](../sellora-api); it has no
database of its own.

Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, TanStack Query,
react-hook-form + Zod, Radix UI primitives.

## Run it locally

```bash
nvm use                  # Node 24 (see .nvmrc); Node 22.12+ works
npm install
cp .env.example .env.local
npm run dev              # http://localhost:3000
```

The API must be running (see sellora-api's README). The browser never calls the API directly:
`/v1/*` on this site is proxied to `API_INTERNAL_URL` (see `next.config.ts`), so the auth
cookies are first-party and `SameSite=Strict` works.

| Variable                    | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `API_INTERNAL_URL`          | Where the Next.js server reaches the API (server-side only).            |
| `NEXT_PUBLIC_SITE_URL`      | Public URL of this app, for metadata and absolute links.                |
| `NEXT_PUBLIC_BRAND_NAME`    | Product name shown everywhere (white-label without code changes).       |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Fallback support address when the API's platform status is unavailable. |

No secrets live in this app. Payment gateway keys, AI keys and so on are set by the
super-admin in the panel and stored encrypted by the API.

## Scripts

| Command                           | What it does                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Development server with Turbopack.                                                                      |
| `npm run build` / `npm start`     | Production build (standalone output) and server.                                                        |
| `npm run typecheck`               | `tsc --noEmit` (run `npx next typegen` first on a fresh checkout for route types).                      |
| `npm run lint` / `npm run format` | ESLint (Next.js rules) and Prettier.                                                                    |
| `npm test`                        | Unit tests (Vitest): money and date formatting, credit estimates, chart ticks, order and inbox helpers. |
| `npm run e2e`                     | Browser smoke test against a running app + API (see below).                                             |

### Browser smoke test

`scripts/smoke.mjs` signs in as a merchant and as a platform admin, opens every built page
(desktop, mobile and dark mode), and fails on console errors, API errors (5xx, unexpected 4xx)
or error panels. Screenshots are written to `smoke-output/`. It needs Playwright with Chromium
(not a dependency of this app) and credentials in environment variables:

```bash
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
SMOKE_ADMIN_EMAIL=admin@demo.sellora.test SMOKE_ADMIN_PASSWORD='…' SMOKE_ADMIN_TOTP_SECRET='…' \
npm run e2e
```

Demo accounts come from `npm run dev:seed` in sellora-api.

### Commerce browser flow

`scripts/commerce-flow.mjs` walks through a merchant's day as a real browser: set delivery
zones, add a product with sizes, take a manual order, check stock went down, pack and take
payment, edit items (including the "refund due" warning), print the invoice and packing
slip, cancel a pending order, and check the customer page, phone layout and dark mode. It
creates real data, so run it against a demo business only:

```bash
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
node scripts/commerce-flow.mjs
```

### Inbox browser flow

`scripts/inbox-flow.mjs` adds the website chat in Settings › Channels, embeds it on a stand-in
merchant site served from another origin, chats as a visitor and answers from the inbox in a
second browser, checking that both sides update live: the new conversation and its unread
badge, typing, replies, notes staying internal, the "." command, the AI pausing when staff
reply, the unread badge on the closed bubble, closing and reopening, dark mode, the phone
layout, and that the browser refuses to show the chat on a site that is not allowed. Run it
against a demo business:

```bash
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
node scripts/inbox-flow.mjs
```

### AI sales agent browser flow

`scripts/ai-agent-flow.mjs` fills in the AI agent's settings, chats with it in the "Try it"
panel, turns it on, has a visitor ask about a product on a stand-in merchant site and checks
the agent's live answer in the chat and the inbox, that a complaint is handed to the team
(the AI pauses with a reason), that staff can correct what the AI remembers, and that the
replies were paid from the AI credit wallet. The API and worker need an AI provider. Without
a real key, use the scripted stand-in in `sellora-api/scripts/claude-stand-in.mjs` (the
expected replies in the flow are the stand-in's; it is not an AI):

```bash
# in sellora-api
node scripts/claude-stand-in.mjs &
AI_ANTHROPIC_API_KEY=sk-ant-stand-in AI_ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm run dev &
AI_ANTHROPIC_API_KEY=sk-ant-stand-in AI_ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm run dev:worker &
# in sellora-web
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
node scripts/ai-agent-flow.mjs
```

## Layout

```
src/
  app/
    (marketing)/          landing page, legal pages (server-rendered, plans from the API)
    (auth)/               sign in, sign up, verify email, reset password, accept invitation
    app/                  merchant dashboard: business picker, account, /app/[orgId]/…
    admin/                super-admin: login + setup (2-step is mandatory), (panel)/…
    billing/return/       where payment gateways send the browser back
  components/
    ui/                   design-system primitives (button, dialog, table, …)
    charts/               SVG column chart (tooltips, keyboard, table view)
    billing/ auth/ layout/ marketing/
    commerce/             product form, item editor, order table, badges, print helpers
    inbox/                conversation list, thread, customer panel, live updates (Socket.IO),
                          the website chat widget
  lib/
    api/                  fetch wrapper (CSRF, one refresh on 401), error type, response types
    format.ts             money in minor units, credits, dates (Intl, any currency)
    credit-economics.ts   margin estimates for the AI price editor (mirrors the API's rounding)
    commerce.ts           order statuses and actions, variant combinations, order totals
    upload.ts             photo shrinking and direct-to-storage uploads
    plans.ts              which plan limits apply to which modules
    inbox.ts              inbox views, live list placement, dot command, embed code
  config/
    site.ts               public settings from env
    marketing.ts          feature list with live/coming-soon flags
  app/widget/[key]/       the website chat page that widget.js frames on merchants' sites
  proxy.ts                redirects signed-out visitors away from /app and /admin; sets which
                          sites may frame each chat widget (frame-ancestors)
public/widget.js          the embed script merchants paste into their site
```

### Messenger, Instagram and WhatsApp browser flow

`scripts/meta-flow.mjs` connects a Facebook page with its Instagram account and a WhatsApp
number in Settings › Channels, then plays the customer side with webhooks it signs with the
app secret, exactly as Meta sends them. It checks that messages arrive live in the inbox, that
staff and AI replies reach the Graph API, "Seen" from read receipts, replies sent from the
Instagram app showing in the thread and pausing the AI, a refused message with Retry, the
24-hour reply window (notes only), and a revoked token asking for a reconnect, then fixing it.
It runs against `sellora-api/scripts/graph-stand-in.mjs`, **not Meta**: Facebook's login page
is replaced by an instant redirect back to Sellora. It proves Sellora's side of the flows, not
Meta's.

```bash
# in sellora-api (with the Claude stand-in from the AI flow above, for the AI's replies)
export META_APP_ID=100200300400500 META_APP_SECRET=stand-in-app-secret-0123456789 \
  META_WEBHOOK_VERIFY_TOKEN=stand-in-verify-token-123 META_GRAPH_BASE_URL=http://127.0.0.1:4020
node scripts/graph-stand-in.mjs &
npm run dev & npm run dev:worker &
# in sellora-web
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
META_APP_SECRET=stand-in-app-secret-0123456789 node scripts/meta-flow.mjs
```

## How it fits together

- **Sessions.** The API sets httpOnly cookies. `lib/api/client.ts` sends the CSRF header from
  the readable `sl_csrf` / `slp_csrf` cookie on every write, refreshes once on a 401, and
  tells `SessionGate` when the session is gone. Merchant and platform sessions are separate
  (different cookies and paths), so one browser can hold both.
- **Permissions.** The API is the authority; the UI only hides what a role cannot use. Merchant
  pages check `can('…')` from the business membership, admin pages from the platform role.
- **Money.** Every amount is an integer in the currency's minor unit. `parseMoney` turns typed
  text into minor units without floating point; `formatMoney` uses `Intl` so BDT, USD and
  zero-decimal currencies all work.
- **Live updates.** The inbox connects to the API's Socket.IO `agents` namespace through this
  site's `/socket.io` rewrite (cookies ride along), joins the business, and writes events
  straight into the React Query caches (`components/inbox/data.ts`). On every reconnect it
  refetches. Visitors' widgets use the `webchat` namespace with their visitor token.
- **Website chat.** `public/widget.js` adds an iframe of `/widget/<key>` to the merchant's
  page and resizes it when the chat opens (postMessage, checked against this site's origin).
  The iframe page is always light so its background stays transparent. Every other page
  sends `X-Frame-Options: DENY`; widget pages send `frame-ancestors` with the channel's
  allowed sites (cached for a minute in `proxy.ts`), so the browser itself refuses to show a
  chat on a site the merchant did not allow.
- **Honesty on the public site.** `config/marketing.ts` marks each feature `live` or `soon`, and
  `LIVE_MODULES` controls the "coming soon" tag on plan modules. Only flip a flag when the
  feature works end to end.

## What is not built yet

Orders, products, customers and product photo uploads are live (M3). The inbox works with the
website chat, Messenger, Instagram and WhatsApp, and the AI sales agent answers on all of them
(M4). Two things are still unproven with the real services: Messenger, Instagram and WhatsApp
have only run against a stand-in for Meta's API, and the AI agent only against a stand-in for
Claude. So the public site keeps labelling the inbox and the AI "coming soon" until both have
run for real. Couriers, store builder, marketing and analytics appear in the merchant sidebar
as disabled "Soon" items. They will be added milestone by milestone; see `docs/TRACKER.md` in
sellora-api.

Photo uploads (`lib/upload.ts`) shrink photos to 1600 px in the browser, ask the API for an
upload link, send the bytes straight to storage with progress, then ask the API to check the
file. With the API's local storage driver the link points at the API itself; with S3 it points
at the bucket, which needs a CORS rule allowing `PUT` from this site.
