# sellora-storefront

The online stores of Sellora AI. One Next.js app serves every business's shop: the `Host`
header says which store a request is for (`<handle>.<STOREFRONT_BASE_DOMAIN>`, set in
sellora-api, or a business's own domain once it is connected). Shoppers browse, add to a cart
and order with cash on delivery (perhaps with an advance paid online) or pay online with the
business's own gateway, or order one product straight from a landing page (`<store>/<slug>`);
the order lands in the business's Orders in the dashboard like any other.

Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS 4. No database: every
page renders on the server from [sellora-api](../sellora-api)'s storefront routes.

Stores are created, designed and sent for review in sellora-web (Online store), and approved by
the super-admin there; landing pages likewise (Landing pages). See
`docs/adr/0014-online-stores.md` (stores), `docs/adr/0015-store-custom-domains.md` (custom
domains), `docs/adr/0016-landing-pages.md` (landing pages) and
`docs/adr/0029-payments-at-checkout.md` (paying at checkout) in sellora-api for the design.

## Run it locally

```bash
# Node 22.12 or newer
npm install
cp .env.example .env.local
npm run dev              # http://<handle>.sellora.localhost:3100
```

| Variable             | Purpose                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_INTERNAL_URL`   | Where this server reaches the API (server-side only).                                                                                           |
| `STOREFRONT_API_KEY` | Must equal `STOREFRONT_API_KEY` in the API's environment (32+ characters). Server-side only; the browser never sees it.                         |
| `TRUST_PROXY_HOPS`   | How many proxies in front of this app add to `X-Forwarded-For` (Caddy in production: 1). The shopper's address is read that far from the right. |

The API must be running with the same key; without it the API answers storefront calls with 503. In development the API's `STOREFRONT_BASE_DOMAIN` is `sellora.localhost:3100`: browsers
send `*.localhost` to your own machine, so `http://nakshi-ghor.sellora.localhost:3100` opens
the demo shop that `npm run dev:seed` in sellora-api makes (once it has a store; the browser
flow below creates one). In production, point a wildcard DNS record (`*.shops.example.com`)
at the server, give Caddy a wildcard certificate, and set the API's `STOREFRONT_URL_SCHEME`
to `https`.

Custom domains reach the same app. Give the server a name for businesses to point their CNAME
at (the API's `STOREFRONT_DOMAIN_TARGET`, e.g. `stores-edge.example.com`, an A record to this
server) and list its public addresses in `STOREFRONT_DOMAIN_IPS` for bare domains. Caddy then
gets each domain's certificate on the first visit, after asking the API whether the name is
an active store address:

```caddyfile
{
	on_demand_tls {
		ask http://127.0.0.1:4000/v1/public/store-domains/check
	}
}

*.shops.example.com {
	tls {
		dns <your DNS provider's plugin> …
	}
	reverse_proxy 127.0.0.1:3100
}

# Any other name: a business's own domain, only once the API says it is active.
https:// {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:3100
}
```

This configuration has not been run against a real Caddy and Let's Encrypt yet (see "Not
built yet"). To try custom domains locally, run the DNS stand-in from sellora-api
(`node scripts/dns-stand-in.mjs`) and start the API with `DNS_SERVERS=127.0.0.1:5300
STOREFRONT_DOMAIN_TARGET=edge.sellora.test STOREFRONT_DOMAIN_IPS=127.0.0.1`. Custom domains
then use this app's port too (`http://www.nakshi-shop.test:3100`); point the made-up name at
127.0.0.1 in `/etc/hosts` or with Chromium's `--host-resolver-rules`.

## Deploying

`Dockerfile` builds a standalone server on port 3100. Its settings (`API_INTERNAL_URL`,
`STOREFRONT_API_KEY`, `TRUST_PROXY_HOPS`) are read when it starts, so one image fits every
setup; a bare `host:port` API address is read as `http://`. `/api/health` answers without
calling the API, for the host's health check. `DEPLOY.md` at the root of the GitHub repository
puts it on Railway behind a wildcard domain (`*.shops.yourdomain.com`), and `compose.yaml` there
runs it locally at `http://<shop>.sellora.localhost:3100`.

## Scripts

| Command                           | What it does                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Development server on port 3100.                                                                                                            |
| `npm run build` / `npm start`     | Production build (standalone output) and server on port 3100.                                                                               |
| `npm run typecheck`               | `tsc --noEmit`.                                                                                                                             |
| `npm run lint` / `npm run format` | ESLint (Next.js rules) and Prettier.                                                                                                        |
| `npm test`                        | Unit tests (Vitest): cart lines and limits, money in any currency, phone numbers, colours, proxy and origin checks, main-address redirects. |

The whole store life cycle (create, design, review, preview, approval, shopping, checkout,
tracking, pause, Bangla) is checked in a real browser by `scripts/stores-flow.mjs` in
sellora-web, and connecting a custom domain by `scripts/domains-flow.mjs` there.

## Pages

| Path                          | What it shows                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                           | The home page sections the business arranged (hero, categories, products, features …).                                                                                           |
| `/products`                   | All products, by category, search and sort, with pages.                                                                                                                          |
| `/products/[slug]`            | Pictures, sizes and colours with live stock, add to cart, questions and answers; structured data for search engines. An old address redirects to the new one.                    |
| `/cart`, `/checkout`          | Cart (kept in the browser), then name, phone, address, delivery area, note and how to pay.                                                                                       |
| `/order?receipt=…`            | The receipt after ordering (a signed token valid for 90 days), with what came back from the gateway (`&payment=`) and Pay now while something is due online.                     |
| `/track`                      | Order tracking by order number and phone.                                                                                                                                        |
| `/pages/[key]`                | The business's pages: about, delivery, returns, privacy, terms.                                                                                                                  |
| `/[slug]`                     | A landing page: its sections, the order form, a sticky order button on phones.                                                                                                   |
| `/[slug]/thanks?receipt=…`    | The thank-you page after a landing page order (signed receipt, never indexed).                                                                                                   |
| `/r/[code]`                   | The link in a cart reminder SMS: puts the cart and the shopper's details back, then opens checkout or the landing page offer. Never indexed.                                     |
| `/c/[code]`                   | The short link in a campaign or automation SMS: the API counts the click, then the shopper goes to the store page, landing page or product with `utm_source=sms`. Never indexed. |
| `/sitemap.xml`, `/robots.txt` | Per store, with its live landing pages; drafts and previews are never indexed.                                                                                                   |

A store that is not open yet shows "opening soon", a paused store shows a closed note, a
suspended store shows "not available", and an address with no store shows a page saying so.

## How it fits together

- **One app, many stores.** Every request passes its `Host` to the API, which finds the store
  and refuses it unless it is open (or the request carries a valid preview token). This app
  never decides which store or which business data a shopper may see.
- **The key stays on the server.** Pages call the API from the server with
  `X-Storefront-Key`. The browser only calls this app's own `/api/cart`, `/api/checkout`, `/api/track`
  and `/api/events` routes (`lib/forward.ts`), which accept same-site JSON only and pass the
  shopper's address and browser along for the API's rate limits.
- **Checkout.** The API prices the cart and checks stock again, places the order through the
  same engine as manual orders, and returns the receipt token. Each checkout carries an
  `Idempotency-Key`, so a double click or a retried request makes one order. A hidden field
  catches simple bots. Orders are never placed from a preview.
- **One main address.** A store can be reached at its Sellora address and at up to three
  connected domains, but an open store lives at one of them: the business picks it, and the
  API's store `url` is it. The root layout sends a shopper on any other address to the same
  page there with a permanent (308) redirect. A layout cannot see the path, so `src/proxy.ts`
  copies it into an `x-sl-path` request header (replacing whatever the browser sent), and
  `lib/main-address.ts` builds the target from the store's own origin, so the redirect can
  never leave the store. Previews, holding pages and the `/api` routes are not redirected.
- **Previews.** The dashboard's "Preview" opens `…/__preview?token=…`. The token goes into an
  httpOnly cookie for that store's address only, for an hour; the API checks it on every
  request.
- **Themes.** The API sends the store's theme (palette, fonts, corners, layout choices); the
  layout turns it into CSS variables and `data-*` attributes on `<body>`
  (`lib/theme-style.ts`), so all six themes share one set of components.
- **Language.** Every word shoppers see is in `lib/i18n.ts`, in English and Bangla; the store's
  language picks one. Prices use `Intl` with the business's currency.
- **Landing pages.** The app has two root layouts in route groups: `(shop)` for the store
  (header, footer, cart) and `(landing)/[slug]` for landing pages (a slim header and footer,
  no cart). The API decides whether a slug is a live page, a paused or unavailable one (a
  short holding page) or nothing (404); `getLanding` is cached per request so the layout and
  the page share one call. A preview of the draft comes from the dashboard as
  `?preview=<token>`, which `src/proxy.ts` moves into the `x-sl-landing-preview` header
  (replacing whatever the browser sent). The order form (`components/landing/order-form.tsx`)
  shows the same prices the API will charge (`lib/landing-offer.ts` mirrors its package
  arithmetic) and posts to `/api/landing/[slug]/order` with an `Idempotency-Key`; the API
  prices it again. Where the shopper came from (UTM tags, ad click ids, the referring site)
  is kept for the visit in session storage and sent with the order; a small beacon counts the
  visit once the page has rendered.
- **Landing page extras** (ADR 0031 in sellora-api). The 22 newer blocks are drawn by
  `components/landing/more-sections.tsx`. A coupon box (`components/coupon-box.tsx`) shows on
  the landing order form and the store checkout only when the API says a coupon could work
  there (`couponBox`) or the page has a coupon banner; the code is checked with
  `/api/landing/[slug]/coupon` or priced with the cart quote, and the API prices it again on
  the order. "Use this code" and "Choose" on package cards talk to the order form through
  window events (`components/landing/offer-actions.tsx`). For A/B tests `src/proxy.ts` gives a
  browser on a landing page address a random id in the httpOnly cookie `sl_ab` (90 days) and
  passes it on as `x-shopper-ab`, which the API uses to pick the version; nothing else about
  the shopper is used.
- **Cart reminders** (ADR 0018 in sellora-api). When the business has reminders on, the
  API's quote and landing page answers say so (`cartReminders`), the phone field says a
  reminder text may come, and `lib/cart-capture.ts` sends the cart 1.5 seconds after the
  shopper stops typing a valid number (`/api/carts`, `/api/landing/[slug]/carts`) with a
  random token kept in local storage (`lib/cart-keys.ts`); the order then carries the token,
  so the saved cart closes as ordered. The reminder link `/r/[code]` asks the API for the
  cart, reprices store carts, writes the cart, token, name and phone back into the browser
  (`app/r/[code]/restore.tsx`) and moves on to `/checkout` or to `/<slug>?cart=1…#order`,
  where `restoredChoice` (`lib/landing-offer.ts`) picks the same package, options and add-on.
- **SMS short links** (ADR 0019 in sellora-api). `app/c/[code]/route.ts` asks the API
  where an 8-letter code goes on this store (`/v1/storefront/links/<code>`, which counts the
  click) and redirects there with `utm_source=sms&utm_medium=sms&utm_campaign=<name>`; the
  landing page and store already keep those tags with the order. A code that is not this
  store's goes to the home page; `lib/short-link.ts` never sends the shopper off the store.
- **Store numbers** (ADR 0027 in sellora-api). On an open store (never in a preview),
  `components/shop-beacon.tsx` and `lib/shop-steps.ts` send four steps to `/api/events`:
  a visit (once per tab and day, with the ad tags, click ids or referring site kept for the
  tab), a product view, an add to cart and the checkout opening. Each carries a random
  browser id from local storage (`sl_vid`, shared with landing pages); the API counts a
  shopper once per step and day and stores only counts. The checkout sends the kept tags with
  the order. `/api/events` answers without counting when the browser holds a preview link.
- **Payments at checkout** (ADR 0029 in sellora-api). The cart quote says how the shopper may
  pay (`payments`: cash on delivery, the whole amount online, the switched-on gateways and the
  advance for this cart); landing pages get the advance rule instead and work out the amount
  as the form changes (`lib/payments.ts` mirrors the API's rule). `components/payment-choice.tsx`
  shows the choice; the order goes out with `payment`, and when the answer has a
  `redirectUrl` the browser goes to the gateway's page. The gateway sends the shopper to the
  API, which asks the gateway before counting anything and then sends them to the receipt or
  thank-you page with `payment=paid|pending|failed|cancelled` (`unstarted` when the gateway
  could not start). The page believes the order over that word (`returnMessage`), and
  `components/pay-now.tsx` starts a new try through `/api/orders/pay` or
  `/api/landing/[slug]/pay`. A gateway in test mode is marked "Test" everywhere.
- **Ad tracking** (ADR 0030 in sellora-api). The store and landing page views carry
  `tracking`: the public ids of the business's own Meta Pixel, TikTok Pixel, GA4 and Google
  Ads for that page (none in previews). `components/ad-tags.tsx` loads each platform's
  standard snippet (`lib/ad-tags-browser.ts`) once the shopper may be tracked: at once, or,
  when the business asks first, after the shopper allows it on the banner (kept as
  `sl_consent`). Product view, add to cart and checkout start go to the tags with a fresh
  event id and, with the same id, to `/api/ad-events` or `/api/landing/[slug]/ad-events` for
  the server copy. Orders carry `tracking` (the tags' cookies, the page and the consent); the
  receipt and thank-you page report the purchase with the server's event id, once per browser
  and only on the day it was placed (Google Ads gets only hashed email and phone). GA4
  purchases come from the server only. `lib/ad-tags.ts` holds the formats and is unit tested.
- **Search engines** (ADR 0032 in sellora-api). Every shop page has a canonical tag; a product
  page uses the product's search title and meta when set, its photos' alt text, and JSON-LD
  from `lib/structured-data.ts` (`Product` with `Offer`, `BreadcrumbList`, and `FAQPage` when
  the product has questions); the home page carries `Organization` and `WebSite`
  (`ldJson` escapes `<` so text cannot end the script tag). An address the product
  used before answers a permanent redirect to its address now. When the business connects
  Google Search Console, the layout puts Google's verification meta tag on the home page.
- **Security headers.** No framing, no referrer beyond the origin, no camera, microphone or
  location (`next.config.ts`).

## Layout

```
src/
  proxy.ts                gives the layout the page's path (for main-address redirects)
  app/
    (shop)/               the store's root layout and pages
      page.tsx            home page (sections)
      products/ cart/ checkout/ order/ track/ pages/[key]/
      [...rest]/          the store's 404 for deeper unknown paths
    (landing)/[slug]/     a landing page's own root layout, the page and thanks/
    api/                  cart, checkout, orders/pay, track, ad-events and landing (order,
                          visit, pay, ad-events) routes for the browser (same-site only)
    preview/              opens a signed preview (reached as /__preview)
    sitemap.xml/ robots.txt/
  components/
    sections/             home page sections
    landing/              landing page sections, order form, countdown, sticky button,
                          visit beacon
    header, footer, mobile nav, product card, gallery, add to cart, cart view,
    checkout form, payment choice, pay now, payment summary, track form, order status,
    holding page
  lib/
    api.ts                server-side API calls with the storefront key
    forward.ts            browser → API forwarding for the /api routes
    request.ts            shopper address behind proxies, same-origin check
    main-address.ts       where to send shoppers on another address of the store
    landing.ts            the landing page for a slug (server, cached per request)
    landing-offer.ts      package prices, totals, countdown, video and attribution helpers
    payments.ts           the advance rule, the shopper's pick, receipt payment words
    ad-tags.ts            what each ad tag is told, browser ids, consent and purchase rules
    ad-tags-browser.ts    loads Meta's, TikTok's and Google's snippets and reports events
    shopper.ts            the shopper's saved name, phone and address
    cart.ts, cart-lines.ts  the cart in localStorage (30 lines, 50 of each)
    money.ts phone.ts color.ts i18n.ts theme-style.ts types.ts
```

## Not built yet

- Ad tags ran only with fake tag scripts in the browser test and the tracking stand-in on the
  server side, never with a real Meta, TikTok or Google account. A shopper who said no to
  tracking cannot change their mind without clearing the site's storage.
- Payments at checkout ran only against the API's fakes and the payment stand-in, never a real
  bKash, Nagad, SSLCommerz, aamarPay or shurjoPay account.
- Landing page videos were checked only by the player address: YouTube is not reachable from
  the build machine, so a stand-in answered the player in the browser test.
- Tested only on development addresses (`*.sellora.localhost` and made-up custom domains
  answered by a DNS stand-in), not yet on a real domain with wildcard DNS, Caddy and
  certificates.
