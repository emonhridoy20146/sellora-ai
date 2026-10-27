# 0003 — Separate repositories, no monorepo

**Status:** accepted (2026-10-27)

**Decision.** `sellora-api` (API and workers), `sellora-web` (marketing site, merchant
dashboard, super-admin panel) and `sellora-storefront` (customer-facing stores and landing
pages) are independent repositories with their own versions and deploys.

**Consequences.** Shared types are not imported across repositories: the web app keeps its own
response types (`src/lib/api/types.ts`) that follow the API's OpenAPI document. A contract change
in the API needs a matching change in the web app.
