# 0004 — Tenant isolation in the data layer

**Status:** accepted (2026-10-27)

**Decision.** Every tenant document carries `orgId`. Besides repositories that always add it,
a Mongoose plugin rejects any query, update, aggregate or save on a tenant collection that is
not pinned to exactly one `orgId` equal to the request's tenant, or that would change a
document's `orgId`. Cross-tenant reads (platform reports) must pass an explicit `crossTenant`
option. Foreign business ids answer 404, never 403.

**Why.** A single missed filter in a multi-tenant app leaks one shop's customers to another.
The plugin turns that mistake into an exception in development and tests, and a route sweep
test calls every business route with another business's id.
