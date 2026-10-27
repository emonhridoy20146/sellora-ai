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

| Command                           | What it does                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Development server with Turbopack.                                                           |
| `npm run build` / `npm start`     | Production build (standalone output) and server.                                             |
| `npm run typecheck`               | `tsc --noEmit` (run `npx next typegen` first on a fresh checkout for route types).           |
| `npm run lint` / `npm run format` | ESLint (Next.js rules) and Prettier.                                                         |
| `npm test`                        | Unit tests (Vitest): money and date formatting, credit estimates, chart ticks, form helpers. |
| `npm run e2e`                     | Browser smoke test against a running app + API (see below).                                  |

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
  lib/
    api/                  fetch wrapper (CSRF, one refresh on 401), error type, response types
    format.ts             money in minor units, credits, dates (Intl, any currency)
    credit-economics.ts   margin estimates for the AI price editor (mirrors the API's rounding)
  config/
    site.ts               public settings from env
    marketing.ts          feature list with live/coming-soon flags
  proxy.ts                redirects signed-out visitors away from /app and /admin
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
- **Honesty on the public site.** `config/marketing.ts` marks each feature `live` or `soon`, and
  `LIVE_MODULES` controls the "coming soon" tag on plan modules. Only flip a flag when the
  feature works end to end.

## What is not built yet

Pages for the inbox, AI agent, orders, products, customers, couriers, store builder,
marketing and analytics appear in the merchant sidebar as disabled "Soon" items. They will be
added milestone by milestone; see `docs/TRACKER.md` in sellora-api.
