# 0006 — Payment gateways configured in the admin panel

**Status:** accepted (2026-10-27)

**Decision.** SSLCommerz, bKash and Stripe credentials, and the manual transfer instructions,
are entered by the super-admin and stored AES-256-GCM encrypted (key from
`DATA_ENCRYPTION_KEYS`, bound to the gateway name). The API never returns secrets, only whether
a gateway is configured, enabled and in sandbox mode. Money is credited only after a
server-to-server confirmation of the exact amount and currency.

**Why.** The owner can switch gateways, rotate keys and go from sandbox to live without a
deploy, and no secret sits in the repository or in plain text in the database.
