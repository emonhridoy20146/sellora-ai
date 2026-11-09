# ADR 0027 — Store visits and sales numbers

**Status:** accepted (2026-11-09). The "store visits and conversion numbers" item of the online
store (plan M9), built as part of Phase 2 module 1, "Online store live".

**Context.** A business with an online store wants to know how many people came, from where,
how far they got and what they bought, so it can tell whether a Facebook ad or a price works.
Orders already exist with their items and totals, but visits were not counted anywhere. The
numbers must not turn Sellora into a tracker of shoppers: no shopper profile, no address kept,
nothing a business could use to follow a person.

**Decision.**

- **Four shopper steps, each counted once per shopper and day.** The storefront app sends
  `visit` (from every page of an open store, once per browser tab and day), `product_view`
  (with the product), `cart_add` and `checkout` to `POST /api/events`, which passes them to
  `POST /v1/storefront/events`. A shopper is a random id the browser keeps (`sl_vid` in local
  storage); without storage, the shopper's address stands in. The API hashes it and keeps a
  Redis marker per store, day, step (and product) and shopper for two days (`SET NX EX`), so a
  repeated step answers `{ counted: false }`. Only counts reach MongoDB: `store_stats` (one
  row per store and day: visitors, product viewers, cart, checkout, orders, order value,
  visitors and orders per source) and `store_product_stats` (per store, product and day:
  viewers, orders, units, sales). No browser id or address is stored.
- **Nothing counts unless the store is open to shoppers.** Steps from a closed store, a
  preview (the business's or the reviewer's: the storefront app refuses to send a step from a
  browser holding a preview link, and the API's preview state is never `open`), an unknown or
  inactive product, or bad input (`visitorId` must be 8 to 64 letters, digits, `-` or `_`) are
  not counted. Steps are rate limited per address (120 a minute).
- **Where shoppers came from.** The visit carries the ad's tags (`utm_source` and the rest),
  click ids (`fbclid`, `gclid`, `ttclid`) or the referring site, read from the landing URL and
  kept for the tab. `trafficSource()` turns that into one of facebook, instagram, whatsapp,
  google, tiktok, youtube, sms, other or direct: the `utm_source` first, then click ids, then the
  referring host. The checkout sends the same tags, so an order keeps its `attribution` (shown
  with the order) and counts for its source.
- **Orders.** When the storefront checkout places an order (not on an idempotent retry), the
  day's orders, order value and the source's orders go up, and each product's orders, units and
  sales. Counting never fails an order; a miss is logged. Order value is the order total before
  cancellations, and the page says so.
- **Days are the business's days.** Rows are keyed by the day in the business's time zone
  (`dayKey`), and the numbers page says which zone.
- **Reading.** `GET /v1/orgs/:orgId/stores/:storeId/stats?days=7|30…90` (`stores.view`)
  returns every day of the period (oldest first, empty days as zero), totals, the same length of
  time before for comparison, conversion (orders per visitor), the funnel (visited, viewed a
  product, added to cart, opened the checkout, ordered), sources and the ten products looked at
  most. It reads through the tenant-scoped repositories, so another business gets 404.
- **In the dashboard.** The store's new "Numbers" tab shows 7, 30 or 90 days: visitors and
  orders with the change from the period before, conversion, order value, the funnel as bars,
  visitors and order value per day as column charts with a table view, and tables of sources and
  products.

**Consequences.**

- A shopper on two devices, or who clears their storage, counts twice; shoppers behind one
  address without storage count once. The numbers are "about this many people", which is what
  a small business needs, not an exact audience.
- Ad blockers that block requests named "events" from the shop's own address would hide those
  steps; the order counts are unaffected because they come from the order itself.
- Landing pages keep their own visit and order counts (ADR 0016); the store numbers cover the
  store's own pages and checkout.
- Not built: per-campaign numbers (the `utm_campaign` is kept on orders but not counted per
  day), exports, and numbers in the super-admin panel. Ad tracking (Meta Pixel, Conversions
  API, TikTok, GA4) is Phase 2 module 3.
- Checked with API e2e tests (counting once per step, sources, a retried order counted once,
  products, the funnel, previews and closed stores not counted, other businesses refused) and a
  browser flow with two shoppers (one from a Facebook ad who orders, one from Instagram), the
  business's own preview, the Numbers page against the API, and phone and dark views.
