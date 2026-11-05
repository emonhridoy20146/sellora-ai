# ADR 0024 — Website crawl: products and pages from the business's own website

**Status:** accepted (2026-11-05). Part 2 of "AI data sync" in the plan (Phase 1). Part 1 is
ADR 0023 (Shopify, WooCommerce, Google Sheets, CSV); voice notes (part 3) get their own record.

**Context.** Many businesses in Bangladesh already have a website (WordPress, a site builder, a
custom build) that is not a Shopify or WooCommerce shop Sellora can read through an API, or
whose API they cannot give access to. Their site holds two things the AI sales agent needs:
the products with prices, and pages such as delivery, returns, size guides and "about us"
that answer most customer questions. The plan asks for a crawler that reads the sitemap,
schema.org product data and page text, re-crawls on a schedule with change detection, applies
price and stock changes (large changes need approval), respects robots.txt, and reads only
sites the merchant proves they own. Exit test: change a price on the merchant's own website,
and the AI's answers use the new price within the sync window.

**Decision.**

- **A catalog source kind.** "Your website" is a fifth kind in Products › Import and sync
  (ADR 0023), so it shares the schedule, leases, run history, product writing, photo copying,
  archive and restore rules, and permission (`catalog.manage`). Two switches choose what a
  crawl keeps: **Import products** (default on) and **Let the AI read the pages** (default on).
  A business that also syncs Shopify keeps products off here to avoid duplicates (SKU clashes
  are reported, never merged).
- **Ownership first.** Adding a website gives it a random token. Nothing beyond the home page is
  read until the merchant proves the site is theirs, with either:
  - a DNS TXT record at `_sellora-verify.<host>` or `_sellora-verify.<registrable domain>` with
    the value `sellora-verify=<token>` (the custom-domain format, ADR 0015), or
  - `<meta name="sellora-site-verification" content="<token>">` in the home page's `<head>`.
    "Verify" checks both and queues the first crawl. Every crawl checks again; when the home page
    was read and DNS answered but neither proof is there, the crawl stops and the source asks to
    be verified again (a site or DNS that is down is a failed run, not a lost proof). Two
    businesses may each prove the same site.
- **What is read.**
  - `robots.txt` first (RFC 9309): the group for `SelloraBot`, else `*`; longest match wins,
    `Allow` wins ties, `*` and `$` patterns. A missing file (4xx) allows everything; a file that
    cannot be read (5xx, timeout) stops the crawl until the next try. `Crawl-delay` is honoured
    up to 5 seconds.
  - Pages are visited in this order: the home page, pages that held products last time (so
    every product is re-checked), sitemap entries (from `robots.txt` or `/sitemap.xml`,
    sitemap indexes and `.gz` files included, newest `lastmod` first), then links found on
    the pages, same origin only.
  - Only HTML (up to 2 MB each), at most two requests at a time and at least 250 ms apart, with
    the user agent `CRAWL_USER_AGENT`. Links to carts, checkouts, accounts, log-ins, admin
    pages, files (images, PDFs, archives), and addresses with more than one query parameter or
    with sorting and filter parameters are not followed, so faceted lists cannot use up the
    budget. `noindex` (meta tag or `X-Robots-Tag`) pages are not kept; `nofollow` stops links.
    A page whose canonical address is another page on the site is kept once, under the
    canonical address.
  - Pages per crawl: the plan's `websitePages` limit (set by the platform owner per plan, `null`
    for no plan limit), never more than `CRAWL_MAX_PAGES`. A crawl that stops at the limit
    ends "Done with problems" and says how many pages were left.
  - Pages are read as the server sends them; JavaScript is not run. A home page with almost no
    text but scripts is reported ("This site seems to build its pages with JavaScript…").
- **Products.** schema.org data in JSON-LD (`Product`, `ProductGroup` with `hasVariant`, inside
  `@graph` or arrays; products inside lists such as category pages are ignored), and OpenGraph
  product tags (`product:price:amount`) when a page has no JSON-LD product. One product per
  page; the page address (path and query) is its external id. Offers give the price
  (`price`, a `StrikethroughPrice` specification as the old price), currency and availability;
  several offers with their own name or SKU become one "Option" choice each. A price range
  without each choice's price (`AggregateOffer` only) is not imported, because quoting the
  lowest price for every size would be wrong; the run says to connect the shop's API instead.
  A product priced in another currency is skipped and reported.
- **Stock from availability.** A website says whether something is in stock, not how many. With
  **Follow sold out** (the website's "Sync stock") on: sold out at the site (`OutOfStock`,
  `SoldOut`) sets the variant's stock to 0 through the inventory ledger (reason `sync`); back
  in stock at the site turns a variant Sellora holds at 0 back to "stock not counted". A
  variant whose count Sellora tracks above 0 keeps its count. `Discontinued` counts as gone.
  With it off, Sellora's stock settings are never touched by the crawl.
- **Gone products.** A crawl may not reach every page, so "not seen" never archives. A product is
  archived (when "Archive removed products" is on) only when its page was read and answered
  404 or 410, redirected elsewhere, became `noindex`, is now disallowed by `robots.txt`, or no
  longer carries the product.
- **Large changes wait for the merchant.** With **Hold large changes** on (default for
  websites; available for every source kind, off by default for the API kinds so their
  behaviour is unchanged):
  - a change that moves any variant's price by more than half (up or down) is not applied;
  - a run that would archive more than half of the source's products (and more than 5) archives
    none.
    Each is listed on the source ("2 changes wait for you") with the old and new prices; the
    merchant chooses **Apply** (applied at the next sync, which starts at once) or **Keep
    Sellora's** (that version at the source is ignored until it changes again). A held run ends
    "Done with problems". At most 100 held changes per source.
- **Page text for the AI.** Each kept page stores its title, description and main text (`<main>`
  when the page has one, otherwise the body without header, navigation, footer, sidebars and
  forms; at most 20,000 characters), a hash for change detection (counts of added, changed and
  removed pages per run), and the run that saw it. After a crawl that read the whole site, pages
  it did not see are removed; after a crawl cut short, only pages confirmed gone are. Pages
  with fewer than 20 words are not kept.
  The agent gets a `search_website` tool when the business has kept pages: a MongoDB text
  search (language-neutral, so Bangla and Banglish words match as written) over title,
  description and text, returning the best three pages with their address and the passages
  that match. The prompt names the site and up to 15 page titles, and says prices and stock
  come only from the catalog tools, never from page text.
- **Cost.** Crawling uses no AI, so it is not charged in AI credits; the plan's page limit is
  the control. If page reading later uses AI (for example, summarising pages), it will be
  metered like any other AI call.
- **Schedule.** Websites are crawled daily by default, or every 6 hours, hourly, or only when
  asked; every 15 minutes is not offered for websites.

**Consequences.**

- One product-writing path for every source; the website connector only turns pages into the
  same `SourceProduct` shape and adds page text.
- Sites that render products only in the browser (JavaScript) give little or nothing until a
  headless-browser reader is added; that needs its own network sandbox and is not built.
- Microdata (`itemprop`) product markup is not read; most shop platforms also print JSON-LD.
- Tried only against `scripts/site-stand-in.mjs` (a local demo website, not a real one) and the
  test suite's fake site; the DNS proof only against `scripts/dns-stand-in.mjs`.
