# 0005 — Money, wallet ledger and AI credits

**Status:** accepted (2026-10-27)

**Decision.**

- All amounts are integers in minor units; credits are counted in hundredths.
- A wallet per business plus an append-only ledger; each movement is one conditional update
  and one ledger row in a transaction, with an idempotency key.
- Plans are priced by the super-admin. AI use is prepaid: merchants buy credits; each call is
  priced from a versioned credit price list by tier (fast, standard, advanced) and token
  counts, rounded up. Real provider cost is computed from model prices stored in the database
  and recorded next to the charge, so profit is exact per call.
- Merchants see credits and their own currency only. Provider names, models and costs are
  platform-only fields.
- Free credit pays only for AI and is never withdrawable. Withdrawals need approval and are
  off by default.

**Why.** The AI credit margin is the main profit line, so it must be visible to the owner per
call, day, business, model and feature, and changing the price must never rewrite history.
