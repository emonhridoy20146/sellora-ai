# 0013 — Couriers and the fraud check: adapters, a written-down booking, and statuses only from the courier

**Status:** accepted (2026-10-28)

**Context.** After an order is confirmed, a Bangladeshi seller books it with a courier
(Steadfast, Pathao or RedX), the courier collects cash on delivery, and the parcel is either
delivered or comes back. Returns cost the seller both delivery fees, so sellers want to know
before shipping whether a phone number usually accepts parcels. Each business has its own
courier merchant accounts; Sellora must book with them, follow every parcel, and move the order
along, without ever booking an order twice and without letting a forged webhook mark a parcel
delivered. Courier APIs are slow at times, and a booking request can time out after the
courier has already created the parcel.

**Decision.**

- **One adapter per courier behind `CourierProvider`** (`src/modules/couriers/providers`). An
  adapter knows its courier's HTTP API, credential fields, limits (weight, pickup store,
  delivery-area fields), status words, webhook proof and tracking link, and translates
  statuses into Sellora's neutral `ShipmentStatus` (queued, sending, booked, picked_up,
  in_transit, on_hold, delivered, partly_delivered, returning, returned, cancelled, failed).
  Nothing outside the adapters names a courier's fields or words. Errors are classified into
  `auth`, `refused`, `invalid`, `unavailable` and `uncertain` (the request may have reached the
  courier). Addresses are environment settings (`COURIER_*_BASE_URL`, sandbox URLs, tracking
  link templates, `COURIER_HTTP_TIMEOUT_MS`) defaulting to each courier's published API.
  Steadfast uses its Api-Key and Secret-Key headers; Pathao an OAuth password grant whose
  token is cached in Redis, encrypted, keyed by a hash of the credentials; RedX a static token.
- **Courier accounts belong to a business.** Credentials are checked with the courier before
  they are saved (balance or store list), stored AES-256-GCM encrypted with the account id as
  associated data, and never returned (only a hint such as "API key …ab12"). Each account
  gets a random webhook address (`/v1/webhooks/couriers/cw_…`) and, where the courier supports
  one, a webhook secret. Settings changes merge with what is saved (`null` clears a value); a
  new pickup store or new credentials are checked with the courier again, and the store's
  name is taken from the courier's own list. One account can be the default; up to 10 per
  business. Managing accounts needs `org.integrations.manage`; booking needs `orders.manage`.
- **A booking is written down before the courier is called.** Booking an order validates it
  (confirmed or packed, no current parcel, a Bangladeshi mobile number, taka, whole-taka cash
  to collect, the courier's weight limits, pickup store and delivery area), then inserts a
  `queued` parcel. A unique partial index on `(orgId, orderId)` where `current` is true makes a
  second live parcel for the same order impossible, even with two clicks at once. Sending
  first claims the parcel (`queued` → `sending`) with a conditional update; only the claimer
  calls the courier. Each attempt has its own invoice (`SL-1042`, then `SL-1042-2`), so a
  courier that deduplicates by invoice never confuses two attempts.
- **Lost replies are resolved, never retried blindly.** When the courier does not answer
  (timeout, 5xx, network) the parcel stays `sending` and Sellora asks the courier by invoice
  whether the booking exists after 2, 5, 10, 20 and 30 minutes. If it is found, the parcel is
  booked; if the courier cannot be asked, staff see "Did this reach the courier?" with "It is
  booked: link it" (enter the consignment id) and "Not booked". A parcel found mid-send after
  a crash goes to the same check. Sellora never sends a booking twice.
- **Statuses only come from the courier's API.** Webhooks prove who sent them where the
  courier allows it (Steadfast: the bearer token the merchant pasted; Pathao: its signature
  header, answered with the integration-secret header and 202; RedX does not sign, so its
  secret address is the only proof). Even a verified webhook only says _which_ parcels to look
  at: the webhook queues a status check for each, and the check asks the courier's API. A
  forged or replayed webhook can at most cause an extra check.
- **One queue for courier work** (`couriers`, in the worker, concurrency 4). `send` jobs carry
  the id `send-<parcelId>` (one send per parcel, ever). `check` jobs use BullMQ deduplication
  (`check-<parcelId>`, `keepLastIfActive`): checks requested while one waits collapse into
  it, and one requested while a check runs is kept and runs after it, so a webhook that
  arrives during a check is never lost. (A fixed job id was tried first; BullMQ keeps
  completed jobs, so a second webhook in the same window was silently dropped. A test with a
  real worker covers this.) A scheduler job every 5 minutes queues checks for parcels whose
  `nextCheckAt` is due: hourly while booked or moving, every 2 hours while returning, every
  3 while on hold. Tracking ends at a final status or after 45 days.
- **The order moves with its parcel.** Picked up (or later) moves a confirmed or packed order
  to shipped; delivered moves it to delivered. A return or a partial delivery is not applied
  automatically, because restocking needs a person: the parcel is flagged "needs a look" with
  the courier's words, and the order page asks staff to mark it returned. While a parcel is
  queued, sending or booked, the order cannot be cancelled or its items edited (the courier
  would carry the wrong parcel); staff first cancel the booking with the courier and mark it
  cancelled in Sellora. "Check now" is limited to once per 30 seconds per parcel.
- **Order list and Couriers page.** Each order carries a copy of its current parcel
  (`shipment`), written by the parcel code only, so lists filter by courier status without
  joins (`shipment=ready|none|attention|<status>`). `GET /parcels/summary` aggregates counts
  and the cash couriers still have to collect.
- **The fraud check is a pure, documented rule** (`src/modules/fraud/fraud-rules.ts`) over
  courier-confirmed outcomes, never over guesses. It counts this business's delivered,
  returned and cancelled orders for the phone number, plus (when enabled) other businesses'
  courier-confirmed outcomes. Success rate = delivered ÷ (delivered + returned). At least 80 %
  is low risk, at least 50 % some risk, below that high risk (only after 3 outcomes; one early
  return is at most "some risk"); a number the team blocked is always high; 3 or more
  cancellations, more than deliveries, raise it to at least "some risk". No history is "new
  customer". Every result carries plain reasons.
- **The shared delivery network is off unless three parties agree.** The super-admin switch
  (off by default), `FRAUD_NETWORK_SECRET` in the environment, and each business's own opt-in.
  Only courier-confirmed outcomes are shared, stored with an HMAC-SHA256 of the E.164 number
  (no number, name, address or order), one row per parcel, deleted after 730 days. A business
  that stops sharing deletes everything it shared at once. A business sees other shops' counts
  only while it shares too, and never which shops. Before switching it on in production, the
  platform owner should have the data-sharing terms reviewed by a lawyer; the admin panel
  says so.

**Consequences.**

- Adding a courier is one adapter file plus its descriptor; booking, tracking, webhooks, the
  UI and the fraud check need no change.
- The courier field names and status words come from each courier's public documentation and
  are exercised against `scripts/courier-stand-in.mjs`, which follows those documents. **They
  have not been tried with real Steadfast, Pathao or RedX merchant accounts.** Before launch,
  book one parcel per courier in each courier's sandbox (Pathao and RedX have one) or with a
  real account, and compare the status words the webhooks send.
- Hourly polling across many businesses is one courier call per tracked parcel per hour; the
  check queue's concurrency and the courier's rate limits bound it. Webhooks make most checks
  happen within seconds instead.
- The network rule is deliberately simple and explainable; it may later weigh recent outcomes
  more, but it should stay a pure function with tests.
