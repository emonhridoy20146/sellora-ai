# 0016 — Landing pages: one product, a reviewed published version, orders in the same engine

**Status:** accepted (2026-10-28)

**Context.** Bangladeshi sellers run most of their ads to a single long page for one
product: a big offer, pictures, benefits, reviews, a countdown, and an order form at the
bottom where the shopper types a name, phone and address and pays cash on delivery. Today
they pay a developer or use a page builder that knows nothing about their stock, delivery
charges or orders, and copy orders into a spreadsheet by hand. The plan (section 4) wants
a builder inside Sellora whose orders land in Orders like any other. Ads send real money to
these pages, so they must load fast, take orders reliably, and not let a business publish
claims Sellora would not allow. Everything a business publishes is checked before
shoppers see it (stores already are, ADR 0014), but a store reviewed once can change freely
afterwards (an M6 limit); a landing page changes far more often, so its changes need review
too.

**Decision.**

- **A landing page belongs to a store** (`landing_pages`, tenant-scoped) and lives at
  `<store address>/<slug>`, so it uses the store's subdomain or custom domain (ADR 0015),
  its colours, fonts and logo (the brand kit), its contact numbers and policy pages. Every
  plan with the `landing_pages` module also allows a store. The store does not have to be
  open: a business can sell from one landing page while its store is still being built.
  Slugs are unique per store and may not take the storefront's own paths (`products`,
  `cart`, `checkout`, `order`, `track`, `pages`, `api` and a few reserved for later). The
  plan limit `landingPages` caps pages per business (Inbox + Shop 10, Growth 50,
  All-in-one unlimited).
- **One product per page, sold as packages.** The page's offer names one product and up to
  6 packages (`1 jar`, `2 jars: save ৳100`): a quantity and either a fixed package price or
  the product's own price. When the product has variants (sizes, colours) the shopper picks
  one, and the package applies to it. With no packages the shopper picks a quantity (1 to
  10). One optional add-on ("order bump": another product at a special price) can be
  ticked in the form. Prices are always computed on the server from the published page and
  current stock; the browser only says which package, variant and add-on were chosen. A
  package price below the regular price is recorded as the order's discount, so invoices
  show the real price and the saving.
- **Sections.** A page is an ordered list of up to 30 typed sections, each validated by a
  schema (Zod) and hideable per device: hero, image, gallery, video (YouTube or Facebook
  links only, stored as an embed id), benefits, problem and solution, specifications, how
  to use, before and after, reviews (with screenshot pictures), countdown, stock left (from
  real stock), price box, FAQ, guarantees, delivery (with the real delivery areas and
  charges), contact buttons, text, and the order form (exactly one, required to publish).
  No section can contain HTML or scripts: text is text, links and pictures are checked.
  Pictures are uploaded files of the business (`store_asset`), attached to the page.
- **Draft, submitted and published versions.** The business edits a _draft_ and saves it as
  often as it likes; shoppers never see the draft. "Publish" sends a snapshot of the draft
  for review (the automatic word check of ADR 0014 runs over its text and the product). The
  super-admin approves that snapshot, not whatever the draft became afterwards, or asks for
  changes with a reason; approval makes it the _published_ version. With
  `stores.autoApproveLandingPages` (Admin › Settings, off by default) a snapshot with no
  warnings is published at once. A live page keeps showing its published version while new
  changes wait for review. Every published version is kept (the last 20) and can be copied
  back into the draft. The super-admin can take a live page down with a reason; publishing
  a fixed version brings it back after review.
- **What shoppers see.** A page is live when it has a published version, is not paused by
  the business or taken down, the store is not suspended or paused, the business is
  active and its plan has `landing_pages`. Otherwise its address shows a short "this offer
  is not available" page (or 404 when there is no such page). A signed preview link (one
  hour, the store preview key with its own token type) shows the draft to the business and
  reviewers; orders are refused from previews.
- **Orders.** The order form posts to the storefront app, which forwards it to the API with
  the storefront key, an `Idempotency-Key` and the shopper's address (as store checkout
  does, ADR 0014): same rate limits per address and phone, the same hidden bot field, the
  same answer for blocked customers. The order is created by the order engine with source
  `landing_page`, the store, the page (id, name, slug) and the visit's attribution
  (`utm_*`, `fbclid`, `gclid`, `ttclid`, referrer host), so Orders can filter by page and
  the ads milestone can join ad spend to real orders. The same phone ordering again from
  the same page within 15 minutes, while the first order is still pending, gets the first
  order's receipt instead of a second order (shoppers double-submit on slow connections
  far more often than they really want two). The thank-you page shows the receipt from a
  signed token, like store receipts.
- **Numbers.** The page counts visitors (once per browser and day, by a beacon after the
  page renders, so link previews and most bots do not count) and orders and order value
  per day (`landing_page_stats`). The dashboard shows the last 30 days and the conversion
  rate.
- **Templates.** A new page starts from a template (three in v1: a full offer page, problem
  and solution, and a short quick-order page), in English or Bangla, filled with the
  product's name, pictures, description and price. Duplicating a page copies its draft.
  Some template words are instructions to the business ("Write what makes this product
  good.") or sample reviews ("A happy buyer"). A page cannot be sent for review while a
  shown section still has one of them (`starterTextProblems`, error `page_not_ready`): the
  business writes its own words or hides the section. The API serves the list with the
  templates, so the editor marks those sections before the business presses Publish. A
  sample review on a live page would be a made-up review.
- **Empty fields.** An empty hero headline shows the product's name and an empty hero
  picture its first picture, as the editor says.

**Why.** Tying pages to a store reuses everything a page needs (address, domain, brand,
policies, receipts) and the existing approval of the address; requiring the store to be
_open_ would force sellers who only want an ad page through a full store review, so it is
not required. Reviewing each published version, rather than the page once, closes the gap
stores still have, and approving the snapshot rather than the live draft means the
reviewer approves exactly what shoppers will see. Server-side prices and the order engine
mean a page cannot sell at a price the business did not set, and stock, fraud checks,
couriers and printing work unchanged.

**Limits (v1).**

- 19 section types and 3 templates, not the plan's 40+ blocks and 30 templates. The editor
  is a section list with forms and a preview in a new tab, not a drag-and-drop canvas;
  there is no undo history beyond "discard changes" and restoring a published version.
- No A/B tests, scheduled publishing, custom code blocks, coupons, advance payment with
  bKash or Nagad, OTP checks, or per-page pixels and Conversions API yet (payments and
  tracking come with later milestones).
- Visitor counts are approximate (one per browser and day); they are not ad-platform
  numbers.
