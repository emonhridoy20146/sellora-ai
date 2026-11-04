# 0001 — MongoDB as the primary database

**Status:** accepted (2026-10-27)

**Context.** The product plan first proposed PostgreSQL. The owner's master instructions
specify MongoDB, and those override the plan.

**Decision.** MongoDB 8 as a replica set, through Mongoose 9. Transactions are used wherever
money moves. Files never go in the database; MongoDB holds JSON documents only, and files will
go to S3-compatible storage.

**Consequences.**

- Tenant isolation cannot rely on row-level security, so it is enforced in the data layer by a
  plugin on every query (see ADR 0004).
- A replica set is required even in development (a one-node set is enough).
- Mongoose 9 specifics: pipeline updates need `updatePipeline: true`; a field-level `index: true`
  must be switched off before declaring a unique compound index on the same field.
