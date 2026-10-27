# Feature tracker

Status of every feature in the plan. **Done** means it works end to end and is covered by
automated tests that ran green. **Partial** says exactly what is missing. A screen existing
is never enough to call a feature done.

Last updated: 2026-10-27.

## M0 / M1 — Foundation (sellora-api, sellora-web)

| Feature                                                                                             | Status  | Notes                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Merchant sign-up, email verification, login, logout                                                 | Done    | Mail goes to the outbox collection in development (`MAIL_TRANSPORT=log`); SMTP delivery is wired but not tested against a real server. |
| Two-step verification (TOTP + recovery codes)                                                       | Done    | Merchant optional, platform mandatory.                                                                                                 |
| Sessions, refresh rotation with reuse detection, sign out everywhere                                | Done    |                                                                                                                                        |
| Password reset and change                                                                           | Done    |                                                                                                                                        |
| Businesses, business settings, business picker                                                      | Done    |                                                                                                                                        |
| Staff invitations, 7 system roles, custom roles, ownership transfer                                 | Done    | Anti-escalation: you cannot grant permissions you do not have.                                                                         |
| Tenant isolation (data-layer guard + route sweep test)                                              | Done    |                                                                                                                                        |
| Hash-chained audit log, merchant activity page, platform verify                                     | Done    |                                                                                                                                        |
| Super-admin realm: login, setup link, admins and roles                                              | Done    |                                                                                                                                        |
| Super-admin: businesses (suspend, demo access), merchant users (lock, disable, sign out, reset 2FA) | Done    |                                                                                                                                        |
| Platform settings (sign-up, trial, maintenance notice, support, billing rules)                      | Done    |                                                                                                                                        |
| Rate limiting (global and auth) | Done | The sign-in limit and account lockout are tested; the global per-minute limit is configured but has no dedicated test. |
| Public marketing site with live plan prices                                                         | Done    | Feature cards are flagged live / coming soon in `sellora-web/src/config/marketing.ts`.                                                 |
| Terms and privacy pages                                                                             | Partial | Draft text; needs a lawyer's review before launch.                                                                                     |

## M2 — Billing

| Feature                                                                                          | Status               | Notes                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Plans, modules, limits, `@RequireModule` enforcement                                             | Done                 | Five starter plans seeded; prices are placeholders the super-admin edits.                                                        |
| Plan editor in the admin panel                                                                   | Done                 |                                                                                                                                  |
| Wallet, ledger, idempotent movements, freeze                                                     | Done                 | 20 concurrent debits never overspend (tested).                                                                                   |
| AI credit price lists (versioned) and provider model catalogue                                   | Done                 | Editor shows a margin estimate per tier before publishing.                                                                       |
| AI metering: reserve, settle, release; cost and profit per call                                  | Done (service level) | No real AI call yet; tested with token counts. Real calls arrive with the AI agent (M4).                                         |
| Subscriptions: trial, purchase from wallet, pro-rata switch, renewal, past due, grace, downgrade | Done                 |                                                                                                                                  |
| Included monthly credits                                                                         | Done                 |                                                                                                                                  |
| SSLCommerz, bKash, Stripe checkout and verification                                              | Partial              | Tested against fakes that mimic the sandboxes. Must be checked once per gateway with real sandbox credentials before going live. |
| Manual bKash / Nagad / bank transfers with admin approval                                        | Done                 |                                                                                                                                  |
| Invoices (numbered, printable)                                                                   | Done                 | No PDF file yet; the invoice page prints cleanly.                                                                                |
| Withdrawals (request, approve, reject, paid)                                                     | Done, switched off   | Off by default until the legal review.                                                                                           |
| Super-admin: overview, AI revenue and profit report, payment and withdrawal queues, gateways     | Done                 |                                                                                                                                  |
| Tenant billing tools: wallet adjust, freeze, assign plan, extend trial, module overrides         | Done                 |                                                                                                                                  |
| Telegram daily stats to the super-admin                                                          | Not started          | Planned with M9 (platform operations).                                                                                           |

## M3 — Commerce (next)

| Feature                                                      | Status                                                |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| Products, variants, stock, categories, images                | Not started                                           |
| Customers                                                    | Not started                                           |
| Manual orders, order statuses, receipts and invoice printing | Not started                                           |
| File storage (S3-compatible, signed URLs)                    | Not started (configuration exists, no implementation) |

## M4 — Inbox and AI agent

| Feature                                                                     | Status      |
| --------------------------------------------------------------------------- | ----------- |
| Unified inbox: Messenger, Instagram, WhatsApp, web chat                     | Not started |
| AI sales agent (replies, product suggestions, customer memory, dot command) | Not started |
| Human handover and AI on/off rules                                          | Not started |

## Later milestones

| Milestone | Features                                                                                                                        | Status      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| M5        | Couriers (Steadfast, Pathao, …), tracking, fraud check                                                                          | Not started |
| M6        | Store builder, themes, subdomain and custom domain with super-admin approval (`sellora-storefront`)                             | Not started |
| M7        | Landing page builder, marketing automation, SMS, abandoned carts                                                                | Not started |
| M8        | Ads analytics and forecasts, AI SEO studio, reports                                                                             | Not started |
| M9        | Backups (daily, weekly, monthly; client Google Drive; super-admin restore and download), Telegram stats, VPS deployment scripts | Not started |

## Known gaps and follow-ups

- Default business currency is `BDT` in the organization schema; make it configurable when the
  first non-Bangladesh customer signs up.
- Top-up limits in platform settings are one pair of numbers applied to every wallet currency;
  make them per currency before supporting a second currency.
- Seeded AI model prices match Anthropic's published prices on 2026-10-27; the super-admin must
  keep them current (they only affect reported cost and profit, never what merchants pay).
