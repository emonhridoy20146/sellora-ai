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

| Command                           | What it does                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Development server with Turbopack.                                                                             |
| `npm run build` / `npm start`     | Production build (standalone output) and server.                                                               |
| `npm run typecheck`               | `tsc --noEmit` (run `npx next typegen` first on a fresh checkout for route types).                             |
| `npm run lint` / `npm run format` | ESLint (Next.js rules) and Prettier.                                                                           |
| `npm test`                        | Unit tests (Vitest): money and date formatting, credit estimates, chart ticks, order, inbox and store helpers. |
| `npm run e2e`                     | Browser smoke test against a running app + API (see below).                                                    |

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
    couriers/             courier account dialog, booking and bulk booking, the order's
                          courier card (timeline, lost replies), risk badges and card
    stores/               store status, web address field, theme picker, section editor,
                          picture picker, preview button, custom domain card with its DNS
                          records, the super-admin's domain decision buttons
    landing/              landing page editor: section list and fields, offer editor
                          (packages, add-on), picture field, address field, preview button
    sms/                  SMS route choice, provider account dialog (shared with the
                          admin), sender name, order texts with preview, message log,
                          opt-outs, and the Admin › SMS cards
  lib/
    api/                  fetch wrapper (CSRF, one refresh on 401), error type, response types
    format.ts             money in minor units, credits, dates (Intl, any currency)
    credit-economics.ts   margin estimates for the AI price editor (mirrors the API's rounding)
    commerce.ts           order statuses and actions, variant combinations, order totals
    upload.ts             photo shrinking and direct-to-storage uploads
    plans.ts              which plan limits apply to which modules
    inbox.ts              inbox views, live list placement, dot command, embed code
    couriers.ts           courier statuses and filters, weights in kg, risk labels
    stores.ts             store statuses and actions, readiness steps, sections, colour
                          contrast, store pages, custom domain statuses and next steps
    landing.ts            landing page statuses, sections and their checks before
                          publishing, package prices, the reviewer's "words on the page"
    sms.ts                SMS part counting (GSM-7 and Unicode, as operators count),
                          template preview, placeholders, status and failure labels
  config/
    site.ts               public settings from env
    marketing.ts          feature list with live/coming-soon flags
  app/widget/[key]/       the website chat page that widget.js frames on merchants' sites
  app/u/[code]/           the public "stop SMS offers" page linked from marketing texts
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

### Customers' photos browser flow

`scripts/photos-flow.mjs` (same set-up, after `meta-flow.mjs` has left the demo channels
connected) sends a Messenger photo and a WhatsApp photo as webhooks and checks that each is
copied into Sellora and shown in the open thread, opens the full-size view, checks that the
AI agent's request carried the photo, that a photo Meta no longer has shows the reason, and
that saved photos load only with a staff session (401 without). The photos are the Graph
stand-in's demo images, and the Claude stand-in cannot see: it only reports how many photos it
received. It proves Sellora's handling of photos, not Meta's or a real model's.

```bash
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
META_APP_SECRET=stand-in-app-secret-0123456789 node scripts/photos-flow.mjs
```

### Voice notes browser flow

`scripts/voice-notes-flow.mjs` (same set-up as the photos flow, plus the speech stand-in:
`node scripts/speech-stand-in.mjs` in sellora-api, and the API and worker started with
`AI_OPENAI_API_KEY=<any>` and `AI_OPENAI_BASE_URL=http://127.0.0.1:4100/v1`) checks the
"Turn voice notes into text" switch and its price, sends a WhatsApp voice note and a Messenger
voice clip as webhooks and checks that each is saved, plays with its length and shows what was
heard, that the AI agent answers those words, that recordings load only with a staff session,
that a recording the service cannot read shows why and "Try again" fixes it, and that with the
switch off a voice note stays audio only; then a phone and dark mode. The recordings are tones
(no speech) and the speech stand-in answers a scripted sentence without listening: it proves
Sellora's handling of voice notes, not a real service's understanding of Bangla.

```bash
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
META_APP_SECRET=stand-in-app-secret-0123456789 node scripts/voice-notes-flow.mjs
```

### Couriers browser flow

`scripts/couriers-flow.mjs` connects Steadfast (after a wrong secret is refused), Pathao and
RedX in Settings › Couriers, then books orders and follows them: a Steadfast parcel moved to
delivered by courier webhooks (the order follows), a courier refusal with its reason,
a Pathao booking with city, zone and area that comes back (staff are asked to mark it
returned), a lost RedX reply linked by hand, bulk sending from the order list, the Couriers
page, delivery risk on orders and customers, the phone and dark layouts, and the super-admin
switch for the shared delivery network with a business opting in and out. Screenshots go to
`smoke-output/couriers/`. It runs against `sellora-api/scripts/courier-stand-in.mjs`, **not
the couriers**: it proves Sellora's side, not Steadfast's, Pathao's or RedX's. Earlier runs'
orders stay in the demo business; the script adds stock when the demo product runs low.

```bash
# in sellora-api
node scripts/courier-stand-in.mjs &
export COURIER_STEADFAST_BASE_URL=http://127.0.0.1:4030/steadfast/api/v1 \
  COURIER_PATHAO_BASE_URL=http://127.0.0.1:4030/pathao \
  COURIER_PATHAO_SANDBOX_URL=http://127.0.0.1:4030/pathao \
  COURIER_REDX_BASE_URL=http://127.0.0.1:4030/redx/v1.0.0-beta \
  COURIER_REDX_SANDBOX_URL=http://127.0.0.1:4030/redx/v1.0.0-beta \
  FRAUD_NETWORK_SECRET=$(openssl rand -hex 32)
npm run dev & npm run dev:worker &
# in sellora-web (the SMOKE_ADMIN_* values are optional: they add the super-admin step)
SMOKE_MERCHANT_EMAIL=owner@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
node scripts/couriers-flow.mjs
```

### Online stores browser flow

`scripts/stores-flow.mjs` clicks through an online store's whole life: the empty store page,
the create wizard (a reserved web address refused, the suggested theme, a colour palette), the
draft checklist, the design editor (a hero picture uploaded, text changed, an announcement, a
section hidden), store details (an invalid link refused), sending for review, the signed
preview link, the "opening soon" page shoppers see before approval, the super-admin's review
queue and approval, then shopping as a visitor on desktop and phone (home, category, product,
cart, checkout, receipt, order tracking), the order arriving in Orders as an online-store
order, pausing and reopening, and the store in Bangla. Screenshots go to
`smoke-output/stores/`. It needs the storefront app (`sellora-storefront`) running on port
3100 with the same `STOREFRONT_API_KEY` as the API, and a business with products and delivery
zones: `npm run dev:seed` in sellora-api makes one (Nakshi Ghor, `shop@demo.sellora.test`),
whose product pictures are generated patterns, not photos. It deletes that business's existing
stores first and leaves one open store behind.

```bash
SMOKE_MERCHANT_EMAIL=shop@demo.sellora.test SMOKE_MERCHANT_PASSWORD='…' \
SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… \
node scripts/stores-flow.mjs
```

### Custom domains browser flow

`scripts/domains-flow.mjs` connects a business's own domain to the open store that
`stores-flow.mjs` leaves behind: the store's Web address tab, a Sellora address refused, a
pasted link cleaned to `www.nakshi-shop.test`, the DNS records to add, a check that asks for
the missing CNAME and one that names a CNAME pointing elsewhere, the domain moving to review,
the super-admin's Custom domains queue and approval, the domain becoming the main address,
shopping on it (home, product, cart), the Sellora address redirecting there, a bare domain
approved from the store's review page, switching the main address both ways (each other
address redirects), the certificate check Caddy would ask, the super-admin disconnecting a
domain with a reason the owner reads, and removing both. Screenshots go to
`smoke-output/domains/`.

The domains are made up and nothing reaches a real DNS provider: start
`node scripts/dns-stand-in.mjs` in sellora-api, start the API with
`DNS_SERVERS=127.0.0.1:5300 STOREFRONT_DOMAIN_TARGET=edge.sellora.test
STOREFRONT_DOMAIN_IPS=127.0.0.1`, and the script sets the stand-in's records over HTTP where a
person would use their provider's page. Chromium reaches the made-up names through
`--host-resolver-rules`. Automatic domain approval must be off in Admin › Settings. Same
credentials as above:

```bash
node scripts/domains-flow.mjs
```

### Landing pages browser flow

`scripts/landing-flow.mjs` follows a landing page from the first click to a cancelled order,
on the open store `stores-flow.mjs` leaves behind: the empty Landing pages list, a new page
(product, template, a reserved address refused), the editor (the template's sample words and
sample reviews listed as things to fix before publishing, then replaced or hidden; headline,
two packages, an add-on, a video and a countdown added, a section hidden, saved), the signed
preview on the shop address, publishing for review while shoppers still get "not found", the
super-admin's queue, review page and approval, then a shopper on a phone arriving from a
Facebook ad: the sticky order button, a package, a size and the add-on, ordering, and the
thank-you page. It then checks the order in Orders with the page and the ad it came from, the
page's numbers, the same phone ordering again within 15 minutes getting its first order back,
the "only 9 left" stock line after the order is confirmed, pausing and resuming, the
super-admin taking the page down and putting it back, a short page in Bangla, and the sitemap.
Screenshots go to `smoke-output/landing/`. It deletes the business's earlier landing pages
first and cancels the orders it placed at the end. Automatic landing page approval is turned
off for the run. YouTube cannot be reached from the build machine, so the browser answers the
video player with a stand-in page; the check is that the page embeds the right player. Same
credentials as above:

```bash
node scripts/landing-flow.mjs
```

### SMS browser flow

`scripts/sms-flow.mjs` needs the API and worker pointed at the SMS stand-in
(`node scripts/sms-stand-in.mjs` in sellora-api, with `SMS_BULKSMSBD_BASE_URL` and
`SMS_ALPHA_BASE_URL` set as its header says). The super-admin connects Sellora's BulkSMSBD
account in Admin › SMS (a wrong key refused first), switches Sellora SMS on, sets prices and
costs and sends a platform test; the business chooses Sellora SMS in Settings › SMS, turns on
and edits the "Order confirmed" text, sends a test (charged from wallet cash), and a new order
gets its text, which the order page lists. A sender name is asked for, approved by the
super-admin and used (charged at the sender-name price); a dropped provider answer shows as
Unknown and leaves the wallet untouched; a number is stopped and allowed again; the
super-admin sees the revenue report and changes the business's daily limit. Every SMS is
checked against what the stand-in received. Screenshots go to `smoke-output/sms/`. It starts
by turning the business's SMS off and disconnecting the platform account, so it can run again.
Needs the admin credentials as well:

```bash
node scripts/sms-flow.mjs
```

### Cart reminder browser flow

`scripts/carts-flow.mjs` needs what sms-flow leaves behind (Sellora SMS ready for the demo
shop, the SMS stand-in), the live store from stores-flow and the storefront on :3100. The
business opens Marketing › Abandoned carts, sees a text without `{link}` refused while typing,
writes its first reminder, turns on a second one and switches reminders on. A shopper types a
phone number at the store checkout and another on a landing page order form (the flow makes
and approves that page); both carts show as "Still shopping". The flow then moves the two
carts' last change back in MongoDB (it reads `../sellora-api/.env`, or `SELLORA_API_DIR`) so
it need not wait an hour: the worker sends the first reminder by itself and staff send the
other by hand. The shopper opens the link from the SMS, finds the same cart with their name
and phone, and orders; the cart shows as Recovered with the order. The landing page link
brings back the offer, and staff stop reminders for that cart. Screenshots go to
`smoke-output/carts/`. It turns reminders off and cancels its order at the end, so it can run
again. Needs the admin credentials as well:

```bash
node scripts/carts-flow.mjs
```

### Campaign and automation browser flow

`scripts/campaigns-flow.mjs` needs the same as carts-flow (Sellora SMS ready for the demo
shop, the SMS stand-in, the live store and the storefront on :3100), and must run between
9 AM and 9 PM in the business's time zone, because campaigns only go out then. It adds three
customers with a new tag (one of them asked to stop) and opens Marketing › Campaigns. A new
campaign to that tag shows "2 get the text"; a placeholder the campaign cannot use is refused
while typing; picking a product adds `{link}`, and the preview shows the stop link and the
price. A test text arrives at the stand-in with a real short link. The campaign is scheduled
for tomorrow at 10 AM and cancelled; its copy is sent now, and only the two reachable numbers
get it. One customer opens the short link on a phone, lands on the product and orders; the
report counts the click and the order. On Marketing › Automations the thank-you after delivery
gets a store link and is switched on, the language switch swaps the default texts (and not
the business's own), and delivering the customer's order plans the thank-you. Screenshots go
to `smoke-output/campaigns/`. It switches the automations off at the end; the customers it
added and the delivered order stay. Needs the admin credentials as well:

```bash
node scripts/campaigns-flow.mjs
```

### Backups browser flow

`scripts/backups-flow.mjs` needs the API and the worker (the worker makes the files), the
demo business and the platform admin details. It adds a product to the demo shop, opens
Admin › Backups and presses "Back up now"; the backup must become Verified, and a test restore
must pass. Downloading asks for a reason and a fresh 2-step code; the saved `.slbk` file must
have the size and checksum the list shows and must not contain the product's name (it is
encrypted). The business then deletes the product; on the business's admin page "See what
would change" shows it coming back, Products are restored with the name typed and another
fresh code, and the business sees the product again. Each 2-step code works once, so the flow
waits for the next 30-second code each time. Screenshots go to `smoke-output/backups/`. It
deletes its product at the end.

### Merchant backups browser flow

`scripts/merchant-backups-flow.mjs` needs the API and the worker, the demo business, and the
Google stand-in (`node scripts/google-stand-in.mjs` in sellora-api, with the API's `GOOGLE_*`
settings pointing at it; it is not Google). As the owner it opens Settings › Backups, prepares
a download and saves the ZIP (products.csv must hold the product it added, the JSON files no
secrets), connects Google Drive through the stand-in's consent page, waits for the worker's
first copy in the stand-in's Drive and saves another with "Copy now", makes a restore point,
deletes the product, previews and restores Products (a wrong password first, which must be
refused), and disconnects Drive. Screenshots go to `smoke-output/merchant-backups/`.

```bash
node scripts/merchant-backups-flow.mjs
```

### Telegram browser flow

`scripts/telegram-flow.mjs` needs the API and the worker (the worker sends every message), the
platform admin details, and the Telegram stand-in (`node scripts/telegram-stand-in.mjs` in
sellora-api, with the API's `TELEGRAM_BOT_TOKEN` and `TELEGRAM_API_URL` pointing at it; it is
not Telegram). It opens Admin › Telegram, presses Connect, links the stand-in's private chat
with `/start <code>` and its group with `/link <code>` (the code must work only once), asks
`/status` and `/today`, limits the group to reports and sends the daily report with "Send
now" (it must name no business), sets the sign-in threshold to 3 and makes three wrong
sign-ins (the owner's chat must get the alert, the group must not), blocks the bot in the
stand-in (the chat must show Unreachable and come back after a test) and checks "Sent lately".
It clears the sign-in alert's counters with `redis-cli`, so set `REDIS_URL` to the API's if it
is not `redis://127.0.0.1:6379/0`. Screenshots go to `smoke-output/telegram/`.

```bash
REDIS_URL=redis://127.0.0.1:6379/0 node scripts/telegram-flow.mjs
```

### Catalog sync browser flow

`scripts/catalog-sync-flow.mjs` needs the API and the worker (the worker runs every sync) and
the shop stand-in (`node scripts/shop-stand-in.mjs` in sellora-api, with
`SYNC_ALLOW_PRIVATE_NETWORK=true` in the API's `.env`; it is not Shopify, WooCommerce or
Google). On Products › Import and sync it tries a wrong Shopify token (it must be explained),
checks and adds Shopify (the draft is not imported), opens a synced product, changes a price
and a stock count at the stand-in and presses Sync now (the new price must show and stock
history must say "Synced from source"), adds WooCommerce, a sheet (its bad row must be named
before importing and the source must end "Done with problems") and a CSV file with a second
version, opens the history, makes the stand-in answer 500 (the sync must fail and say why),
pauses and resumes a source, checks a phone width for sideways scrolling, and removes a
source (its products must stay). It removes the sources and products it made, before and
after. Screenshots go to `smoke-output/catalog-sync/`.

```bash
node scripts/catalog-sync-flow.mjs
```

### Website crawl browser flow

`scripts/website-crawl-flow.mjs` needs the API and the worker, the website stand-in
(`node scripts/site-stand-in.mjs` in sellora-api, a demo shop site on :4095 that is not a real
shop), the DNS stand-in (`node scripts/dns-stand-in.mjs`, with `DNS_SERVERS=127.0.0.1:5300`)
and the Claude stand-in (with `AI_ANTHROPIC_BASE_URL` pointing at it), and
`SYNC_ALLOW_PRIVATE_NETWORK=true` in the API's `.env`. It adds "Your website" (the check must
read only robots.txt, the sitemap and the home page), presses Verify before the tag is there
(it must say what was not found), puts the tag on the stand-in and verifies (the first crawl
must import 5 products, a sold-out one with stock 0, and keep the pages), opens the pages and
asks "ডেলিভারি চার্জ কত?" (the delivery page must be found), asks the AI test chat the same
(it must answer from the website), drops a price by more than half (it must wait; "Keep" must
keep Sellora's price) then changes it a little (it must go through), hides a product page (its
product and page must go), checks every request named SelloraBot and none went where
robots.txt forbids, removes the tag (reading must stop) and verifies again with a DNS record,
checks the settings, dark mode and a phone, and removes the source (its pages must go).
Screenshots go to `smoke-output/website-crawl/`.

```bash
node scripts/website-crawl-flow.mjs
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
- **Online stores.** The dashboard edits a store through the API; shoppers never touch this
  app. The API enforces which status changes are allowed; `lib/stores.ts` mirrors those rules
  only to decide which buttons to show, and the checklist comes from `readiness` on the store
  response. Previews open in a new tab with a signed link from the API, valid for an hour. The
  design editor keeps unsaved changes in one draft and compares it with the saved theme to
  enable Save. The Web address tab lists the store's domains with the exact records to add
  (as DNS providers label them), the problems from the last check, and polls every 30 seconds
  while a domain waits; the API does the checking.
- **Honesty on the public site.** `config/marketing.ts` marks each feature `live` or `soon`, and
  `LIVE_MODULES` controls the "coming soon" tag on plan modules. Only flip a flag when the
  feature works end to end.

## What is not built yet

Orders, products, customers and product photo uploads are live (M3). The inbox works with the
website chat, Messenger, Instagram and WhatsApp, and the AI sales agent answers on all of them
(M4). Two things are still unproven with the real services: Messenger, Instagram and WhatsApp
have only run against a stand-in for Meta's API, and the AI agent only against a stand-in for
Claude. So the public site keeps labelling the inbox and the AI "coming soon" until both have
run for real. Courier booking, tracking and the fraud check work (M5), but only against a
stand-in for the couriers' APIs, so the public site also keeps couriers "coming soon" until a
parcel has been booked with each real courier. Online stores work (M6 part 1: the dashboard's
Online store pages, the super-admin's review queue, custom domains, and the shops themselves
in `sellora-storefront`), but only on development addresses (`*.sellora.localhost`, and made-up
custom domains answered by a DNS stand-in) so far, so the public site keeps "Your own online
store" coming soon until stores run on a real domain with real certificates. Landing pages
work (M7 part 1: the dashboard's Landing pages editor and numbers, the super-admin's review
queue, and the pages in `sellora-storefront`) on the same development addresses. SMS works
(M7 part 2: Settings › SMS, Admin › SMS, the order page's SMS list and the opt-out page `/u/…`),
but only against a stand-in for the SMS providers; no real SMS has been sent. Abandoned cart
reminders work (M7 part 3: Marketing › Abandoned carts, with the settings, the 30-day numbers
and every saved cart), through the same SMS stand-in, and so do campaigns and automations
(M7 part 4). Backups work (M9: Admin › Backups and the restore section on a business's admin page, and
the business's own Settings › Backups with downloads, restore points and Google Drive copies),
with Google Drive tried only against a stand-in. Owner reports and alerts on Telegram work
(Admin › Telegram: linked chats, scheduled reports, alert settings and what was sent), but only
against a stand-in for the Telegram Bot API; no message has reached real Telegram yet.
Products › Import and sync brings products in from Shopify, WooCommerce, a Google Sheet or a
CSV file and keeps them up to date, tried only against a stand-in for those shops. "Your
website" reads the business's own site once it proves ownership (DNS record or meta tag):
products from its product pages, and its pages for the AI sales agent to answer from, tried
only against a demo site stand-in and the DNS and Claude stand-ins.
Analytics appears in the merchant
sidebar as a disabled "Soon" item. They will be added milestone by milestone; see
`docs/TRACKER.md` in sellora-api.

Photo uploads (`lib/upload.ts`) shrink photos to 1600 px in the browser, ask the API for an
upload link, send the bytes straight to storage with progress, then ask the API to check the
file. With the API's local storage driver the link points at the API itself; with S3 it points
at the bucket, which needs a CORS rule allowing `PUT` from this site.
