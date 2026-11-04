# 0018 — Abandoned cart reminders: saved carts, two timed SMS, a restore link, recovered orders

**Status:** accepted (2026-11-04)

**Context.** Many shoppers in Bangladesh start an order on a shop page or a landing page,
type their phone number, and stop before pressing "Confirm order": they want to ask
someone at home, the data pack ran out, or the page was slow. The plan (section 6, M7) asks
for abandoned cart reminders by SMS. ADR 0017 already gives each business an SMS route
(Sellora SMS paid from the wallet, or its own gateway), marks `cart_recovery` as a
marketing purpose (opt-outs apply and every message carries an opt-out link), and writes
each message down once by a key. What is missing is knowing which carts were left, when to
text, what to say, how the shopper gets back to the same cart, and whether the reminder
brought an order.

**Decision.**

- **A cart is saved only when the business asked for it and the shopper gave a number.**
  Marketing › Abandoned carts has an on/off switch (off by default) and needs the
  `marketing` plan module. While it is off, or the plan lacks the module, the storefront's
  capture call answers `{saved: false}` and stores nothing. With it on, the checkout form
  of the online store and the order form of a landing page send the cart a moment after
  the shopper has typed a valid mobile number (and again when the cart or the number
  changes). The storefront shows a one-line notice under the phone field ("If you do not
  finish, we may text this number a reminder. Each text has a link to stop them.") only while reminders are on.
  Saved: the phone (E.164), the name if typed, the lines with names and prices as the
  catalog priced them at that moment (store carts are priced by the same `quote()` as
  checkout; landing carts by the page's package, option and add-on), the total, the store
  and the landing page. No address is kept. A cart is forgotten 60 days after its last
  change (TTL index).
- **Each cart has a random token from the browser and a short code for the link.** The
  token (kept in the shopper's browser with the cart) lets later saves update the same cart;
  it is unique per business. The code (10 letters and digits, unique across Sellora) is the
  only thing in the SMS link `<store address>/r/<code>`. Opening the link restores the cart
  in that browser (items and the shopper's name and number for the store's checkout; the
  package, option and add-on for a landing page) and counts a click. The code only works on
  the store the cart belongs to.
- **Two reminders, each with its own delay and text.** Step 1 (on by default) goes 60
  minutes after the shopper's last change; step 2 (off by default) 24 hours after. Delays
  are chosen from 30 minutes, 1, 2, 3, 6 and 12 hours, 1 and 2 days, and step 2 must come
  after step 1. Texts use `{name}`, `{shop}`, `{items}`, `{total}` and `{link}`; `{link}` is
  required, so every reminder can bring the shopper back. Sellora appends the opt-out link
  (" Stop: <link>" or " বন্ধ করতে: <link>"), so a business cannot leave it out. Defaults are
  in English and Bangla. Each step's preview shows the parts and what one reminder costs on
  the business's route.
- **The worker sends reminders; the rules are checked when each one is due.** A `carts`
  queue runs a sweep every minute: open carts whose `nextReminderAt` has come, across all
  businesses, a few hundred at a time. For each cart, in this order: reminders still on and
  the module still in the plan (otherwise the cart waits with no next time); the step and
  its delay under the settings as they are now (a cart already past a step's time by more
  than 12 hours skips that step, so turning reminders on, or a long worker outage, never
  texts yesterday's carts); quiet hours (default 22:00 to 09:00 in the business's time zone;
  the reminder moves to the end of them); an order from the same number since the cart was
  made (the cart is marked ordered instead); another cart reminder to the same number in the
  last 24 hours (the reminder waits until 24 hours have passed); the business's minimum cart
  total; SMS switched off (waits and tries again every 30 minutes until the step's time runs
  out); a number that opted out (no more reminders). Then the cart is claimed with a
  compare-and-set on its next step, so two workers never send the same step, and the
  message is written with key `cart:<id>:<step>` and purpose `cart_recovery`. The SMS layer
  holds and charges the wallet as for any message, and records failures (no balance, daily
  limit, unreachable number) on the message, which the cart shows.
- **Changing the settings moves the waiting carts.** Saving the settings sets every open
  cart of the business to be looked at on the next sweep, which works out its next time
  under the new delays. Turning reminders off clears the next time of every open cart.
- **Staff can send one now, or stop a cart.** "Send reminder now" (at most 3 per cart) uses
  the next step's text, skips quiet hours and the 24-hour rule (a person decided), but not
  opt-outs, SMS being off, or the wallet. "Stop reminders" marks the cart dismissed.
- **An order closes the cart; it counts as recovered only when a reminder went out.** When
  any order is created (online store, landing page, inbox or by hand), open carts of the
  business with the customer's number are marked ordered. The storefront also sends the
  cart's token with the checkout, so the cart the order came from is closed even if the
  shopper changed their number. A cart is *recovered* when it was ordered within 7 days of a
  reminder that was not refused (queued, sent, delivered or uncertain). The page shows
  carts left, reminded, recovered (count and order value), still open (value), the cart SMS
  spend and the recovery rate for the last 30 days, and lists carts by what happened.
- **Tenancy.** Carts and cart settings are tenant documents (`TenantScopedRepository`);
  every storefront call finds the business from the store address first, and the sweep
  enters each cart's business with `RequestContext.withTenant` before reading anything
  else. Tests prove that one business cannot list, remind, dismiss or restore another's
  carts, and that a code does not restore on another business's store.

**Consequences.**

- A reminder is sent only after the shopper typed a mobile number in a form whose notice
  says reminders may come, and only for businesses that turned it on; the opt-out link and
  the opt-out list of ADR 0017 apply to every reminder.
- Prices in a cart are a snapshot for the message; the restored cart is priced again by the
  storefront, so a changed price or stock shows at checkout as usual.
- A shopper who types a number and orders by phone instead is closed by the order listener
  if the business records the order in Sellora; otherwise they may get one reminder.
- Carts with no phone number (a shopper who only browsed) are not saved: there is no one to
  remind and nothing to measure them against yet.
- Not done yet: reminders over WhatsApp or Messenger (needs Meta-approved templates),
  carts saved before the shopper types a number, and a discount code in the reminder.
