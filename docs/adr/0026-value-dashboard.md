# ADR 0026 — Value dashboard and first analytics

**Status:** accepted (2026-11-09). The "value dashboard" and "first analytics" items of the plan
(M8), built before the first deploy so the two test businesses see what Sellora did for them.

**Context.** The plan asks for a page that "shows each merchant what Sellora saved and earned:
hours saved, chats handled by AI, orders taken by AI, fake orders stopped. Helps sell and renew
plans", plus first reports on sales and chats. The data already exists: messages (with who sent
them), orders (with their source and history), carts (recovered with their order), AI usage
(what each call cost the business) and the fraud check. Nothing new needs collecting.

**Decision.**

- **One read-only report, computed on request.**
  `GET /v1/orgs/:orgId/analytics/overview?from&to` (at most 366 days) runs a few MongoDB
  aggregations through the tenant-scoped repositories, so every stage starts with the business's
  own `orgId`. Nothing is stored or pre-computed, so the numbers can never drift from the
  records. On the demo business (a few hundred messages and orders) it answers at once; it has
  not been timed on months of a busy shop's data. Messages gained an `{ orgId, createdAt }`
  index for it. Days are counted in the business's time zone.
- **Gated like every report.** Needs the "Reports" module (`analytics`) in the plan (402
  `module_not_in_plan` otherwise) and the `analytics.view` permission (owner, admin, manager,
  accountant and viewer roles; not sales agents or fulfillment). Each part is only worked out
  when its own module is in the plan: chats need Inbox, sales need Commerce, AI figures need the
  AI sales agent, carts need Marketing and Commerce, risky orders need the fraud check and
  Commerce. A part not in the plan is `null` and the page leaves it out.
- **What the value tiles count.**
  - _Time saved_ = AI replies × 2 minutes (`MINUTES_PER_AI_REPLY`). It is an estimate and the
    tile says so, with the sum shown.
  - _Chats the AI handled alone_ = conversations with an AI reply in the period and no reply
    from staff in the same period.
  - _Orders taken by the AI_ = orders whose first history entry was written by the AI agent, not
    cancelled or returned, in the business's currency.
  - _AI cost_ = what the business paid for AI calls settled in the period (billed less any
    shortfall the wallet could not cover), in the business's currency, with "AI orders were
    worth N times this" when there are AI orders. Provider cost is never shown to businesses.
  - _Voice notes understood_ = speech-to-text calls settled in the period.
  - _Carts won back_ = carts marked recovered whose order was placed in the period.
  - _Risky orders not sent_ = orders placed in the period, cancelled before ever being shipped,
    whose phone number the fraud check rates high risk **today**; the delivery charge they would
    have cost is shown. At most the newest 500 such orders are checked per request.
- **Sales and chats.** Sales leave out cancelled and returned orders; counts per status, per
  source and per day (AI orders apart), and the five best sellers by value. Chats count
  conversations with a customer message in the period, customer messages, replies per day by the
  AI and by staff, chats per channel, and the typical reply time: the median gap between a
  customer message and the next message, when that next message is a reply by the AI or by staff
  (approximate median, `$median` with `method: 'approximate'`).
- **In the dashboard.** The overview shows the four headline tiles for the last 30 days with a
  link to Analytics. Analytics shows all tiles, sales and chats for 7, 30 or 90 days, with
  column charts (stacked AI and other) that each have a table view, and plain empty states. The
  Analytics item appears in the menu for anyone with `analytics.view`; a plan without Reports
  shows "Not included in your plan".

**Consequences.**

- Numbers are exact counts of stored records except the two estimates, which are labelled as
  such: time saved (2 minutes a reply is a rule of thumb, not measured) and risky orders (the
  risk rating is today's, not the rating when the order was cancelled).
- A report over 90 days of a busy business scans every message in the period. If a business
  outgrows that, daily totals can be stored by the worker without changing the API's answer.
- Not built: ads analytics and forecasts (M8, needs Meta ads access), exports of these reports,
  comparison with the previous period, per-staff numbers, and reports in the super-admin panel
  (the profit report there already covers AI money).
- Checked with e2e tests on seeded records with known answers (both businesses, roles, plans)
  and a browser flow on the demo business's data, whose chats and AI replies come from the Meta
  and Claude stand-ins, not from real customers.
