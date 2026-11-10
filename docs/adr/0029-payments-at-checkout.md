# ADR 0029 — Shoppers pay online at checkout, with the business's own gateways

**Status:** accepted (2026-11-10). Phase 2 module 2, "Payment at checkout" (plan M11).

**Context.** Until now every store and landing page order was cash on delivery (ADR 0014,
0016). Businesses in Bangladesh lose money on fake and refused COD orders, so many ask for the
delivery charge (or more) in advance, and some shoppers would rather pay in full with bKash,
Nagad or a card. The money must go straight to the business: Sellora must not hold shoppers'
money, so each business connects its own merchant account. The platform's own billing
gateways (ADR 0009, Sellora's accounts for plan and credit payments) stay separate.

**Decision.**

- **Five gateways, each business's own account.** `shop_payment_accounts` holds at most one
  account per gateway per business: bKash (tokenized checkout: app key, app secret, username,
  password), Nagad (merchant id, merchant number, merchant private key, Nagad public key),
  SSLCommerz (store id, store password), aamarPay (store id, signature key) and shurjoPay
  (username, password, order prefix). Credentials are encrypted (AES-256-GCM, bound to the
  account id), never returned (only a masked hint), and each account has a sandbox switch and
  an on/off switch. Staff with `org.integrations.manage` manage them.
- **Checked before saving where the gateway allows it:** bKash grants a token, shurjoPay
  gives a token, SSLCommerz answers its transaction query with the store's keys, and Nagad's
  keys must be a readable RSA private and public key. aamarPay has no way to check keys
  without a payment, so it shows "not checked yet" until the first payment. Every payment
  start that fails is kept on the account (time and the gateway's reason) for the business
  to see; the next start that works clears it.
- **Payment options** (`shop_payment_settings`, one per business): cash on delivery on or off,
  "pay the full amount online" on or off, and **advance on cash on delivery**: off, the
  delivery charge, a fixed amount, or a percent of the total (rounded up to whole taka,
  never more than the total), optionally only for some delivery areas (for example outside
  Dhaka) and only from an order total. Cash on delivery cannot be turned off unless full
  online payment is on with a gateway switched on; if every gateway is later turned off,
  cash on delivery is offered again on its own.
- **At checkout** (store and landing page): the quote says what the shopper may choose
  (cash on delivery, full online payment, the gateways, and the advance for this cart and
  area). The order input gains `payment: { method: 'cod' | 'online', gateway }`; without it
  the order is cash on delivery as before (so older storefront builds keep working). An
  advance or full payment needs a switched-on gateway. The order is created as before
  (pending; stock is not taken) with `payment.method` `cod` (advance) or the gateway's method
  (`bkash`, `nagad`, or the new `online` for SSLCommerz, aamarPay and shurjoPay) and
  `payment.online` = gateway, purpose (`full` or `advance`), amount due online, status
  (`awaiting`, `paid`, `failed`) and whether it is a sandbox payment. Then a payment is
  started with the business's account and the shopper is sent to the gateway. If the gateway
  cannot start, the order still stands and the receipt says so and offers to try again.
- **One record per attempt** (`shop_payments`): the order, gateway, account, sandbox, purpose,
  amount, currency, a random reference used as the gateway's order id, the gateway's session
  id, status (`started`, `succeeded`, `failed`, `cancelled`), the gateway's transaction id and
  reason, and where to send the shopper back.
- **Nothing the browser says is trusted.** Every gateway sends the shopper (and SSLCommerz's
  IPN, the server) to `/v1/shop-payments/:ref/return` or `/notify` on the API. The API asks the
  gateway itself with the business's keys: bKash execute (then status query), Nagad verify,
  SSLCommerz validation of the `val_id`, aamarPay transaction check, shurjoPay verification.
  Only an answer that the payment is complete, for this reference, with the same amount and
  currency, counts. A different amount or currency marks the attempt failed, is audited
  (`shop_payment.mismatch`) and logged, and moves no money on the order. The attempt changes
  from `started` once (an atomic update), so the browser return and the IPN cannot count a
  payment twice. Then the order's `paidMinor` goes up, its payment status becomes partial or
  paid, the gateway's transaction id is kept, and `order.paid_online` is audited. The
  shopper is sent to the receipt (store) or thank-you page (landing page) with the outcome.
  These routes read no session (`@GatewayCallback()`): a gateway's form POST from a browser
  that is also signed in to the dashboard carries its cookies but no CSRF token, and must not
  be refused for it. Staff cannot mark an order "online" by hand; only a checkout payment
  sets that method.
- **Shoppers who pay and close the browser.** The worker checks attempts still `started`
  after three minutes every five minutes for two days (bKash status query, Nagad verify,
  SSLCommerz transaction query, aamarPay transaction check, shurjoPay verification) and
  records what the gateway says; after two days they are marked failed (`expired`).
- **Paying again.** The receipt and thank-you page show the online amount still due with the
  gateways to choose from (`POST /v1/storefront/orders/pay` with the receipt), unless the
  order was cancelled or is already paid. Limited to 10 starts an hour per order.
- **In the dashboard.** Settings › Payments connects the gateways and sets the options.
  Orders show the online payment (paid, waiting, failed, test) and the attempts with their
  references; a sandbox payment is marked "Test payment, no real money".
- Gateway addresses default to each gateway's live and sandbox hosts and can be pointed
  elsewhere with `PAYMENT_<GATEWAY>_LIVE_URL` / `_SANDBOX_URL` (also used by the platform's
  own SSLCommerz and bKash billing). Sellora takes no fee on these payments.

**Consequences.**

- An order waiting for online payment is a pending order like any other; the business sees
  that it is not paid yet and decides (call, wait or cancel). Unpaid orders are not cancelled
  on their own.
- Refunds are made in the gateway's own panel; the business then marks the order refunded.
- The gateways were built from their public documentation (bKash tokenized checkout v1.2.0,
  Nagad check-out API v-0.2.0, SSLCommerz v4, aamarPay JSON API, shurjoPay v2) and tested
  against fakes that answer like the documented APIs, and a local stand-in for the browser.
  None has been tried with a real merchant account yet; a business should run one sandbox
  payment per gateway before switching to live. Nagad's sandbox and live addresses in
  particular should be confirmed with Nagad when the merchant account is opened.
- aamarPay's IPN is registered with aamarPay's support, not per payment, so aamarPay relies on
  the browser return and the worker's check.
- Not built: advance only for risky phone numbers (fraud score), a test payment button in
  Settings, refunds through the gateways, partial payments other than the advance, and
  card-saving or EMI options.
