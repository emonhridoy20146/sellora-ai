# 0002 — NestJS for the API and workers

**Status:** accepted (2026-10-27)

**Decision.** NestJS 12 with Express, ESM, TypeScript strict mode, SWC for builds and dev.
The HTTP server and the BullMQ worker are two entry points of one codebase.

**Why.** Modules and dependency injection keep a large feature set organised; guards and
decorators give one place for authentication, CSRF, tenancy, permissions and plan modules.
Validation uses Zod rather than class-validator so schemas are plain values shared by tests.
