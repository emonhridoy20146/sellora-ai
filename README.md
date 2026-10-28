# sellora-storefront

The online stores of Sellora AI. One Next.js app serves every business's shop: the `Host`
header says which store a request is for (`<handle>.<STOREFRONT_BASE_DOMAIN>`, set in
sellora-api). Shoppers browse, add to a cart and order with cash on delivery; the order lands
in the business's Orders in the dashboard like any other.

Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS 4. No database: every
page renders on the server from [sellora-api](../sellora-api)'s storefront routes.

Stores are created, designed and sent for review in sellora-web (Online store), and approved by
the super-admin there. See `docs/adr/0014-online-stores.md` in sellora-api for the design.

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

## Scripts

| Command                           | What it does                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Development server on port 3100.                                                                                    |
| `npm run build` / `npm start`     | Production build (standalone output) and server on port 3100.                                                       |
| `npm run typecheck`               | `tsc --noEmit`.                                                                                                     |
| `npm run lint` / `npm run format` | ESLint (Next.js rules) and Prettier.                                                                                |
| `npm test`                        | Unit tests (Vitest): cart lines and limits, money in any currency, phone numbers, colours, proxy and origin checks. |

The whole store life cycle (create, design, review, preview, approval, shopping, checkout,
tracking, pause, Bangla) is checked in a real browser by `scripts/stores-flow.mjs` in
sellora-web.

## Pages

| Path                          | What it shows                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `/`                           | The home page sections the business arranged (hero, categories, products, features …). |
| `/products`                   | All products, by category, search and sort, with pages.                                |
| `/products/[slug]`            | Pictures, sizes and colours with live stock, add to cart.                              |
| `/cart`, `/checkout`          | Cart (kept in the browser), then name, phone, address, delivery area and note.         |
| `/order?receipt=…`            | The receipt after ordering (a signed token valid for 90 days).                         |
| `/track`                      | Order tracking by order number and phone.                                              |
| `/pages/[key]`                | The business's pages: about, delivery, returns, privacy, terms.                        |
| `/sitemap.xml`, `/robots.txt` | Per store; drafts and previews are never indexed.                                      |

A store that is not open yet shows "opening soon", a paused store shows a closed note, a
suspended store shows "not available", and an address with no store shows a page saying so.

## How it fits together

- **One app, many stores.** Every request passes its `Host` to the API, which finds the store
  and refuses it unless it is open (or the request carries a valid preview token). This app
  never decides which store or which business data a shopper may see.
- **The key stays on the server.** Pages call the API from the server with
  `X-Storefront-Key`. The browser only calls this app's own `/api/cart`, `/api/checkout` and
  `/api/track` routes (`lib/forward.ts`), which accept same-site JSON only and pass the
  shopper's address and browser along for the API's rate limits.
- **Checkout.** The API prices the cart and checks stock again, places the order through the
  same engine as manual orders, and returns the receipt token. Each checkout carries an
  `Idempotency-Key`, so a double click or a retried request makes one order. A hidden field
  catches simple bots. Orders are never placed from a preview.
- **Previews.** The dashboard's "Preview" opens `…/__preview?token=…`. The token goes into an
  httpOnly cookie for that store's address only, for an hour; the API checks it on every
  request.
- **Themes.** The API sends the store's theme (palette, fonts, corners, layout choices); the
  layout turns it into CSS variables and `data-*` attributes on `<body>`
  (`lib/theme-style.ts`), so all six themes share one set of components.
- **Language.** Every word shoppers see is in `lib/i18n.ts`, in English and Bangla; the store's
  language picks one. Prices use `Intl` with the business's currency.
- **Security headers.** No framing, no referrer beyond the origin, no camera, microphone or
  location (`next.config.ts`).

## Layout

```
src/
  app/
    page.tsx              home page (sections)
    products/ cart/ checkout/ order/ track/ pages/[key]/
    api/                  cart, checkout and track routes for the browser (same-site only)
    preview/              opens a signed preview (reached as /__preview)
    sitemap.xml/ robots.txt/
  components/
    sections/             home page sections
    header, footer, mobile nav, product card, gallery, add to cart, cart view,
    checkout form, track form, order status, holding page
  lib/
    api.ts                server-side API calls with the storefront key
    forward.ts            browser → API forwarding for the /api routes
    request.ts            shopper address behind proxies, same-origin check
    cart.ts, cart-lines.ts  the cart in localStorage (30 lines, 50 of each)
    money.ts phone.ts color.ts i18n.ts theme-style.ts types.ts
```

## Not built yet

- Custom domains for stores (the merchant's own domain). Stores only live on subdomains.
- Online payments at checkout: cash on delivery only.
- Visit and conversion numbers.
- Tested only on development addresses (`*.sellora.localhost`), not yet on a real domain with
  wildcard DNS and TLS.
