# 0007 — The web app proxies the API on its own origin

**Status:** accepted (2026-10-27)

**Decision.** `sellora-web` rewrites `/v1/*` to the API (`API_INTERNAL_URL`). Browsers only talk
to the web origin; auth cookies are httpOnly, `SameSite=Strict`, and scoped by path
(merchant and platform realms use different cookies). Writes carry a CSRF header copied from a
readable cookie.

**Why.** First-party cookies avoid third-party cookie blocking and keep tokens out of
JavaScript. In production the API can also be served on a sibling subdomain with
`COOKIE_DOMAIN` set to the parent domain.
