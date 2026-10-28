# 0014 — Online stores: one storefront app for every store, a reviewed launch, and checkout through the order engine

**Status:** accepted (2026-10-28)

**Context.** Many Bangladeshi sellers live on Facebook and want a shop of their own on the
web: a page for each product, a cart and a cash-on-delivery checkout, at an address they
can share. Sellora already holds their products, stock, customers, delivery zones and
orders. A store is public, so it must be fast, safe to expose to anyone, impossible to use
to read another business's data, and checked before it opens so the platform is not used
to sell banned or fake goods. Sellers are on phones; many prefer Bangla.

**Decision.**

- **One storefront app serves every store** (`sellora-storefront`, Next.js, port 3100). The
  Host header says which store: `<handle>.<STOREFRONT_BASE_DOMAIN>`. Pages render on the
  server and call the API's `/v1/storefront/*` routes with `X-Storefront-Key` (constant-time
  compared); the key never reaches browsers. The API is the only place that knows stores,
  so the storefront holds no database credentials and could be replaced or scaled alone.
  Shoppers' browser calls (cart pricing, checkout, tracking) go to the storefront's own
  `/api/*` routes, which accept same-site JSON only (content type and Origin are checked) and
  forward the shopper's address (`X-Shopper-Ip`, from X-Forwarded-For, trusting only
  `TRUST_PROXY_HOPS` proxies) for rate limits.
- **A store is a document per business, themes are manifests.** A store has a handle (a DNS
  label, unique across the platform, refused when reserved), a theme key, theme settings
  (palette, fonts, corners, header and card styles, logo, announcement, up to 12 home page
  sections: hero, categories, product rows, reasons to buy, banner, text), contact, social
  links, SEO, five policy pages and checkout options. A theme is a manifest in
  `src/modules/stores/themes.ts` (tokens, palettes, the categories it suits, defaults) plus
  its token styles in the storefront. Six ship: Bazaar, Nakshi, Volt, Glow, Fresh and Nest.
  Adding a theme does not change the engine. Section ids, colours and images are validated
  with Zod; images are files with purpose `store_asset`, attached to the store in the same
  transaction that saves the design and removed when no longer used.
- **Launch is reviewed.** Draft → sent for review (needs at least one active product and a
  phone or WhatsApp number) → the super-admin approves (live) or asks for changes
  (rejected, with a reason the owner reads). The business can withdraw, pause and reopen;
  the platform can suspend any store and reinstate it to its previous status. Sending a
  store runs an automatic check over its texts and its 300 newest products for words often
  used for banned or misleading goods; the warnings go to the reviewer. With
  `stores.autoApprove` on (Admin › Settings, off by default) a store with no warnings opens
  at once. Every change is audited and the owner gets an email. The handle is locked once
  the store has opened, so shared links keep working.
- **What shoppers see is decided by the API.** `resolve` returns `open`, `preview`,
  `coming_soon` (draft, pending, rejected), `paused` or `unavailable` (suspended store,
  business not active, demo expired, or a plan without the `storefront` module). Only an
  open store or a valid preview shows products; the others show a holding page with the
  store's name and contact.
- **Previews are signed links**, valid for an hour, made for staff and the reviewer. The
  storefront turns `/__preview?token=` into an httpOnly cookie on the store's host and
  shows a preview banner. A preview never takes orders.
- **Checkout goes through the order engine.** The storefront prices the cart with the API
  (`POST /storefront/cart`: current prices, stock, the business's delivery zones, the
  minimum order), and checkout creates a normal order with source `store`, the store's id,
  cash on delivery and status pending, through the same service as manual orders (customer
  matching by phone, blocked customers, plan order limits, order numbers). Pending orders do
  not take stock; the business confirms by phone first, as Bangladeshi COD sellers do.
  Checkout needs an `Idempotency-Key`: the result is kept in Redis for 24 hours under the
  store and key, a lock stops two concurrent attempts, and reusing a key with a different
  cart is refused. A hidden field catches bots. Limits: 10 checkouts per address per 10
  minutes, 5 per phone number per hour per business, 30 tracking lookups per address per 10
  minutes. Refusals that would reveal something (a blocked number, a plan limit) all answer
  "the shop cannot take this order online".
- **Receipts and tracking without accounts.** The checkout returns a signed receipt token
  (valid 90 days) for the order page; the phone number on it is masked. Anyone else tracks
  an order with its number plus the phone number used.
- **Tenant isolation as everywhere else.** Each storefront request resolves the store, then
  runs inside that business's tenant scope with a `visitor` actor, so every query goes
  through the tenant-pinned repositories. The isolation tests also open one business's
  products and orders through another business's store and expect nothing.

**Why.** A single storefront app keeps the public surface small and separately deployable,
and keeps secrets and data access in the API. Reviewing a store once at launch is the
balance between safety and speed that small sellers accept; the automatic check makes the
review quick, and suspension covers what changes later. Reusing the order engine means
store orders behave exactly like every other order (couriers, fraud check, stock, reports)
with no second code path to keep correct.

**Consequences and limits.**

- Edits after approval are not reviewed again; the platform relies on suspension and the
  automatic check when the store is next sent. A later version could re-check on save.
- Pending store orders do not hold stock, so two shoppers can order the last item; the
  business sees both and confirms one.
- Store pictures are public files (`o/<orgId>/store/…`). On S3 the bucket may make
  `o/*/store/*` public alongside `o/*/products/*`; chat photos stay private.
- Custom domains (a business's own `www.shop.com`, with TLS on demand) are the next part of
  this milestone: `GET /v1/public/store-domains/check` already answers whether a domain
  belongs to a live store, for the TLS server to ask before issuing a certificate.
- Online payment at checkout (bKash, SSLCommerz) is not offered yet; checkout is cash on
  delivery only.
- Search engines get a sitemap, robots.txt, page titles and descriptions, and JSON-LD
  `Product` data on product pages. Store visit and conversion analytics are not built yet.
