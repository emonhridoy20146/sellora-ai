# ADR 0031 — Landing page extras: more blocks and templates, coupons, scheduled publishing, offer end, A/B tests

**Status:** accepted (2026-11-12). Phase 2 module 4, "Landing page builder extras" (plan M10).

**Context.** The first landing page builder (ADR 0016) had 19 blocks and a few templates, one
publish button and no discounts. Businesses in Bangladesh run short offers (Eid, Chand Raat,
11.11), want a page to go live at midnight and stop when the offer ends, hand out codes in
ads and posts, and want to know which headline sells better. Most of them write in Bangla and
sell health, beauty, fashion, gadgets, food, courses, home and kids' products. Custom code
blocks were left out on purpose: they would let a business run scripts on Sellora's domains.

**Decision.**

- **22 new blocks** (41 in all): announcement bar, video top offer, features with icons,
  checklist, comparison table, ingredients, timeline, who it is for, stats, orders today
  (`{count}` filled from the page's real orders today, in the business's time zone, shown
  only once the count reaches the block's minimum), video reviews,
  quote, certificates, picture and text, about the shop, size chart, package cards, payment
  methods (from the store's real checkout options), coupon code banner, order button band,
  shop address (a map link only, no embedded map) and space. Video blocks take a YouTube or
  Facebook link, never an embed code. The add menu groups blocks (top of the page, pictures and
  video, about the product, trust, buying). Each block has the same draft and publish checks
  as the first ones.
- **30 templates in 9 categories** (general, health, beauty, fashion, gadgets, food, courses,
  home, kids), each in English and Bangla, written for that kind of product. Template words
  that must be changed (for example `[your product]`) hold publishing back until changed.
  **My templates:** a business saves a page's sections as its own template (at most 20; the
  product and prices are not saved) and picks it under "My templates" for a new page.
- **Coupons** (`coupons`, at most 200 per business; Coupons in the dashboard menu, needs the
  `commerce` module and `marketing.view` / `marketing.manage`):
  - Kinds: percent (1–90, with an optional cap), amount off, free delivery. Optional smallest
    order, start and end, uses in total and uses per customer (by phone; 1 by default).
  - Where: the store checkout (on or off) and landing pages (all, chosen ones, or none).
  - The server prices every coupon; the browser only shows what the server said. A refused
    code says why (unknown or off, not started, ended, used up, not on this page, order too
    small, already used by this phone, nothing to save). Each new code an address tries costs
    one of 20 tries per 10 minutes; asking about the same code again is free.
  - A use is taken in the order's transaction, so the last use cannot go to two orders; a
    cancelled or returned order gives its use back. The order keeps the code and the discount; the
    order page and printed orders show it.
  - The coupon box shows only when a coupon could work there (an active coupon valid at that
    place) or the page has a coupon banner, so shoppers without a code are not sent hunting.
- **Scheduled publishing:** "At a time" sends a version for the usual check (automatic or by
  a reviewer); once approved it waits as `scheduled` and goes live by itself between 1 minute
  and 90 days later. One scheduled version at a time (a newer one replaces it). The business
  can publish it now, change the time or cancel; the live version stays until then. Preview
  shows the scheduled version.
- **Offer end:** the business sets `pauseAt` (1 minute to 1 year ahead). At that time a live
  page pauses itself (shoppers see the paused page, ads keep their address) and the business
  resumes it by hand.
- **A/B tests:** "As an A/B test" sends version B for the usual check; once approved, a share
  of visitors (10–90%, 50 by default) sees B and the rest the live version (A).
  - Which version a browser sees comes from a random id in the httpOnly cookie `sl_ab`
    (90 days), set by the storefront only on landing page addresses and sent to the API as
    `x-shopper-ab`; the API hashes it with the test id, so a browser always sees the same
    version. Nothing else about the shopper is used.
  - A visitor is counted once per test (Redis marker), a buyer once, and every order with its
    value. Orders remember the test and version.
  - The winner is the version with more buyers per visitor, by a two-sided two-proportion
    z-test at 95%, once each version had the visitors set (50–100,000, 300 by default).
    "Choose the winner by itself" (on by default) makes the winner live; if no version is
    clearly better after the days set (3–60, 14 by default) the test ends and A stays. The
    business can also end it: keep A, or make B live (B is already approved).
  - While a test runs nothing else is published, scheduled or tested on that page.
- **The worker** runs one sweep every minute (`landing-pages` in the maintenance queue):
  scheduled versions due, offers ended, automatic tests decided. Each step is idempotent and
  works in the page's own business. Every change is audited.
- A draft that is already the scheduled version or version B is not reported as "changes
  shoppers do not see yet".

**Consequences.**

- Publishing still always goes through the same check, so scheduled versions and B versions
  are never unreviewed.
- The minute sweep means "at 12:00" goes live between 12:00 and about 12:01.
- A/B tests need real traffic: with a few dozen visitors a day most tests end without a clear
  winner, which the page says instead of guessing.
- Not built: custom code blocks, coupons in the inbox (AI agent orders), automatic codes per
  customer, one-time-password checks on orders, tests with more than two versions, and
  splitting by ad or device.
