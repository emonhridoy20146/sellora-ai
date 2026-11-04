# 0019 — SMS campaigns and automations: audiences, paced sending, short links, orders after

**Status:** accepted (2026-11-04)

**Context.** The plan (section 6, M7) asks for marketing automation: Bangladeshi online
shops text their customers about a new collection, an Eid offer or a restock, and want a
"thank you" after delivery and a nudge for customers who stopped ordering. ADR 0017 gives
each business an SMS route, a wallet hold per message, opt-outs with a stop link and a key
that makes each message once. ADR 0018 added the first marketing texts (cart reminders).
Missing: choosing who gets a text, sending thousands without running out of money or the
daily limit half-way, short links that do not double the SMS cost, and knowing whether a
campaign brought orders.

**Decision.**

- **Campaigns go to the business's customers, chosen by what they did.** An audience is a
  filter over the customers Sellora already keeps (ADR on orders, M3): everyone with a phone,
  or only those who ordered, or only those with a delivered order; at least N orders; spent
  at least an amount; ordered in the last N days; or no order for N days; any of some tags;
  where they came from (store, Messenger, WhatsApp, added by hand, imported). Blocked
  customers, numbers that asked to stop, and numbers the route cannot reach (a Bangladeshi
  gateway and a foreign number) are never sent to; the preview counts each group, so the
  business sees "1,240 customers, 31 asked to stop, 1,209 get the text" before sending.
  Each number gets a campaign at most once (customers are unique by phone).
- **The text.** Written by the business, with `{name}`, `{shop}` and `{link}`. A link is
  optional; when chosen, it points at the store's home page, a live landing page or a
  product page, and `{link}` must be in the text. The stop link is added to every campaign
  text, as for cart reminders. The preview shows the text with sample values, the parts it
  needs (at most 6) and the price per message and for everyone. A test goes to one number
  (at most 5 per campaign; purpose `test`, so not counted as a campaign message).
- **Short links.** `{link}` becomes `<store address>/c/<code>` (8 letters and digits, one code
  per campaign and per automation), not the full address with tracking tags, so a text with a
  link still fits one part in English. The storefront asks the API where the code goes,
  counts the click and redirects to the page with `utm_source=sms&utm_medium=sms&utm_campaign=
<name>`, which landing page orders already record. Clicks are counted per campaign, not per
  shopper.
- **Sending is paced and stops before it hurts.** "Send now" or "Send at <time>" (the
  business's time zone). When it starts, the audience is written down as recipients (so later
  changes to customers do not change who was chosen) and a worker sweep, every 30 seconds,
  sends batches of up to 500. Before each batch it checks, in this order:
  - SMS still works (otherwise the campaign pauses with "SMS is off");
  - the hour is between 9 AM and 9 PM in the business's time zone (texts are not sent at
    night; the campaign waits for the morning, and scheduling a start outside these hours is
    refused);
  - today's SMS limit (ADR 0017) has room (a batch is cut to what is left; with none left the
    campaign waits until tomorrow morning);
  - on Sellora SMS, wallet cash covers the batch (otherwise the campaign pauses with "Top up
    to continue" and the owner gets an email). Starting a campaign needs cash for the whole
    estimate.
    Each message has the key `campaign:<id>:<phone>`, so a batch run twice (a crash, a retry)
    makes no second message. Staff can pause, resume and cancel; cancelling leaves the messages
    already handed to the SMS worker.
- **Orders after a campaign.** When an order comes in from a number that got a campaign text
  in the last 7 days (and the message was not refused or failed), the latest such campaign
  counts the order and its value, once per recipient. The campaign page shows recipients,
  sent, failed and skipped, the spend, link clicks, orders and their value, and numbers that
  pressed stop after it.
- **Automations: two texts that run by themselves.** Marketing › Automations, both off by
  default:
  - **After delivery** — N days (1–30) after an order is marked delivered, a thank-you (the
    business writes it; `{name}`, `{shop}`, `{order}`, `{link}`). Planned when the order
    becomes delivered; skipped if the order was returned or the automation was switched off
    meanwhile.
  - **Win back** — when a customer's last order turns N days old (30, 45, 60, 90, 120 or 180),
    one text (`{name}`, `{shop}`, `{link}`). Only customers whose N days run out after the
    automation was switched on, so switching it on never texts the whole customer list at
    once; once per customer per last order.
    The same sweep sends them, in the same 9 AM–9 PM hours; a number that got a campaign or
    automation text in the last 24 hours waits a day (and is skipped after three days). Purpose
    `automation` (a marketing purpose: opt-outs apply, stop link added). Keys
    `auto:after_delivery:<order>` and `auto:win_back:<customer>:<last order time>`.
- **Plan and roles.** Campaigns and automations need the `marketing` module; marketing
  managers create, send and switch; marketing viewers look. Starting, cancelling a campaign
  and changing an automation are in the audit log.

**Consequences.**

- Sending a campaign to a large list is safe to retry and cannot overspend: the wallet hold
  per message (ADR 0017) is still the final guard, and the campaign stops at the first batch
  the cash cannot cover.
- The 9 AM–9 PM window and the 7-day order window are constants in `campaign-rules.ts`,
  documented here; they apply to every business.
- Delivery reports exist only for Twilio (ADR 0017), so "delivered" is mostly "sent".
- Not done: shopper-level click tracking, A/B texts, campaigns by WhatsApp or Messenger
  (Meta's rules for marketing messages need templates and approval), birthdays (Sellora does
  not ask for them), imports of phone lists from outside the business's customers.
