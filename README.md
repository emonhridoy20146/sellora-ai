# Sellora AI

AI sales assistant and commerce platform for Bangladeshi F-commerce businesses: an AI inbox for
Facebook, Instagram, WhatsApp and web chat, orders and products, couriers and fraud checks, SMS,
online stores and landing pages, with a super-admin panel and a prepaid AI-credit wallet.

This repository holds the three apps, each in its own folder with its own `package.json`:

| Folder                | What it is                                                                 | Port |
| --------------------- | -------------------------------------------------------------------------- | ---- |
| `sellora-api`         | NestJS API and background workers (MongoDB, Redis, BullMQ)                 | 4000 |
| `sellora-web`         | Next.js: public site, merchant dashboard and super-admin panel             | 3000 |
| `sellora-storefront`  | Next.js: the online stores and landing pages merchants publish             | 3100 |

Each folder's `README.md` explains how to set it up and run it. `sellora-api/docs` has the
architecture decisions (ADRs), the feature tracker (what is done, partial or not started) and
the build log.

To put it online for a first test (Railway, MongoDB Atlas, Cloudflare R2), follow
[`DEPLOY.md`](DEPLOY.md); `render.yaml` does the same on Render.

Secrets live only in environment variables: copy each app's `.env.example` to `.env` (API) or
`.env.local` (web, storefront) and fill it in. No real credentials are committed.
