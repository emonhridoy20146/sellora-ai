# ADR 0023 — Catalog sync: products from Shopify, WooCommerce, Google Sheets and CSV

**Status:** accepted (2026-11-04). Part 1 of "AI data sync" in the plan (Phase 1). The website
crawl (part 2) and voice notes (part 3) have their own records.

**Context.** The AI sales agent answers from the business's catalog (ADR 0010): the prompt
lists the best sellers and the tools search the rest. Many merchants already keep their
products somewhere else: a Shopify or WooCommerce shop, or a spreadsheet. Typing them in again
is the biggest reason a new business never turns the agent on, and a catalog that drifts from
the real shop makes the agent quote wrong prices. The plan's exit test for data sync: a change
at the source reaches the AI's answers within the sync window.

**Decision.**

- **Sources.** A business adds catalog sources in Products › Import and sync (permission
  `catalog.manage`, module `commerce`, since a sync writes products):
  - **Shopify**: the shop's `*.myshopify.com` address and an Admin API access token from an
    app the merchant creates in their Shopify admin with `read_products` and
    `read_inventory`. Read through the GraphQL Admin API (`/admin/api/<version>/graphql.json`;
    the REST product endpoints are legacy). The version is `SHOPIFY_API_VERSION`.
  - **WooCommerce**: the shop's address and a read-only REST API key (consumer key and
    secret, HTTP Basic over HTTPS). Products and, for variable products, their variations from
    `/wp-json/wc/v3`.
  - **Google Sheets / CSV link**: a sheet shared as "anyone with the link can view" (turned
    into its CSV export link) or any HTTPS link to a CSV file.
  - **CSV upload**: a file of up to 700 KB, imported when uploaded; uploading a new version to
    the same source updates the same products. Nothing is fetched on a schedule.
- **Credentials** (Shopify token, WooCommerce key and secret) are encrypted with the
  application key (`EncryptionService`, bound to the business and the source). The API shows
  only the last four characters.
- **Schedule.** Linked sources sync every 15 minutes, hourly (default), every 6 hours, daily,
  or only when asked. The worker sweeps every minute for due sources, takes a lease on the
  source (one run at a time; a crashed run's lease expires after 30 minutes) and writes a run
  record (kept 90 days) with counts and up to 50 problems. "Sync now" queues a run at once.
  After a failed run the next try waits twice as long (up to a day), and the source shows the
  error; a successful run resets it.
- **What a sync does.** Each source product is mapped to one Sellora product, remembered on
  the product (`sync.sourceId`, `sync.externalId`, its variants' external ids, and a hash of
  what was imported):
  - New at the source: created (as active, or as a draft when the source says so) within the
    plan's product limit; over the limit the run stops creating and says so.
  - Changed at the source (the hash differs): name, description (HTML turned into text), tags,
    category (found or created by name), photos, options, variants and prices are replaced.
    Variants are matched by their external id, so existing variants keep their id and order
    history; stock is set to the source's count when "Sync stock" is on, through the inventory
    ledger (reason `sync`, note "Synced from …"), never by writing the number directly.
  - Unchanged: skipped. A product the merchant archived stays archived.
  - Gone from the source, or no longer active there: archived when "Archive removed products"
    is on (default), and restored when it comes back, but only if the sync archived it.
    Nothing is archived unless the whole source was read without error, and a run that reads
    no products at all from a source that had some archives nothing and fails, so an emptied
    sheet or a broken API answer cannot hide the catalog.
  - SKU clashes with the business's own products, duplicates at the source and rows that
    cannot be read are reported per product and skipped; the rest of the run continues.
  - Photos are copied into the business's storage (ADR 0008) the first time their address is
    seen (at most 8 per product); a photo that cannot be fetched is skipped and reported.
  - Prices must be in the business's currency; a source in another currency is refused when
    it is added (no conversion).
- **Edits in Sellora.** A synced product shows where it comes from. Fields the source owns are
  replaced at the next change at the source, so the product page says to edit them there.
  Status, and everything Sellora has that the sources do not (delivery zones, landing pages),
  stay Sellora's. Disconnecting a source keeps its products and forgets the link.
- **Sheets and CSV columns.** The header row is matched by name, in English and Bangla, case
  and spacing ignored: name, price, old price (compare at), SKU, barcode, stock, description,
  category, tags, image (several links separated by spaces, commas or new lines), status,
  and options either as `Option1 Name` / `Option1 Value` pairs (Shopify's export) or as
  columns named after the option (Size, Colour). Rows with the same `Handle` / `Group`
  (or, without one, the same name) are variants of one product. Prices may be written
  `1,250`, `৳1,250`, `Tk 1250.00` or in Bangla digits. "Check the link" shows the matched
  columns and the first products before anything is saved.
- **Fetching the outside world safely.** Every request a sync makes (APIs, sheets, photos)
  goes through one client that allows only `http(s)` on the default ports, resolves the host
  itself and refuses private, loopback, link-local and other non-public addresses (checked
  again on every redirect, at most 5, and on the address actually connected to), caps the
  response size and time, and never sends credentials to a host the redirect moved to. Local
  development may allow private addresses (`SYNC_ALLOW_PRIVATE_NETWORK=true`, refused in
  production) so stand-ins can run on localhost.
- **The AI.** Synced products are ordinary products, so the agent's catalog and tools see a
  change as soon as the sync has written it: the sync window is the delay.

**Consequences.**

- One sync code path for all sources: each source is a connector that turns its API or file
  into the same `SourceProduct` shape; adding Facebook catalog or others later is one file.
- Webhooks from Shopify and WooCommerce (instant updates) are not used yet; the shortest
  window is 15 minutes.
- Shopify shops with more than 100 variants on one product import the first 100.
- WooCommerce and Shopify weights are not imported (their unit is a shop setting, and Shopify keeps it on the inventory item, which would cost more query points). Sheets can carry a weight column in grams or kg.
- Not tried with real Shopify, WooCommerce or Google: only with `scripts/shop-stand-in.mjs`,
  which is none of them.
