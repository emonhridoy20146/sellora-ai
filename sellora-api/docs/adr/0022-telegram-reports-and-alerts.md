# ADR 0022 — Owner reports and alerts on Telegram

**Status:** accepted (2026-11-04).

**Context.** The plan (section 8) gives the platform's owners a daily summary and instant alerts
on Telegram: business numbers, AI use and profit, platform activity and the backup result, and
an alert when a backup fails, payments fail, the AI provider fails, sign-in failures spike or
queues back up. Server alerts (a server down, CPU or disk thresholds, certificates, a database
failover) come from the monitoring system so they still arrive when the app is down; that is
the deployment milestone's work, not this one.

**Decision.**

- **One bot, set by the operator.** `TELEGRAM_BOT_TOKEN` (from @BotFather) is a secret in the
  environment, never in the database. `TELEGRAM_API_URL` (default `https://api.telegram.org`)
  lets a stand-in play Telegram locally (`scripts/telegram-stand-in.mjs`, not Telegram).
  Without a token, Admin › Telegram says it is not set up and alerts go to email only.
- **Allowed chats.** Admin › Telegram (permission `platform.telegram.manage`, owners and
  admins) lists the chats that get messages. A chat is added with a single-use link code
  (15 minutes): the admin opens `t.me/<bot>?start=<code>` for a private chat, or adds the bot
  to a group and sends `/link <code>`. A chat can also be added by its id, if a test message
  reaches it. Each chat chooses its topics (`reports`, `backups`, `billing`, `ai`, `security`,
  `system`); a chat linked by an admin can only get the topics that admin's permissions allow
  (for example `billing` needs `platform.billing.view`). Removing a chat stops all messages.
- **Webhook.** "Connect" calls `setWebhook` with `<API_PUBLIC_URL>/v1/telegram/webhook` and a
  random secret token (Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`; only its SHA-256
  is stored). Updates from chats not in the list are ignored except `/start <code>` and
  `/link <code>`. Real Telegram needs a public HTTPS address.
- **Commands** (read-only, allowed chats, each needs the chat's topic): `/status` (queues,
  last backup, this host), `/today` (the day so far), `/backup` (the last backups), `/servers`
  (the worker's host: load, memory, disk), `/help`.
- **Reports.** Daily at 21:00 in the report time zone (default `PLATFORM_REPORT_TIMEZONE`)
  covering the 24 hours before; weekly on Mondays (7 days) and monthly on the 1st (the month
  before), at the same hour; each can be turned off. Contents: sign-ups, new businesses, trials,
  new paying businesses, active businesses (an order or a customer message), revenue
  (subscriptions and wallet top-ups) and MRR per currency, failed payments; AI replies, chats
  handed to people, tokens, real AI cost per provider, credits billed, AI profit and margin,
  cost per conversation; orders, SMS sent and their cost, campaigns started; the last
  platform backup and test restore, queue backlog, and the worker host's load, memory and disk.
  Counts only: never customers' names, phone numbers, messages or secrets. A worker claims a
  report's slot in the settings document before sending, so two workers send it once; on a
  new install (nothing sent yet) a slot more than an hour old is skipped, not sent late.
  "Send now" sends the 24 hours, 7 days or 30 days up to now and does not move the schedule.
- **Alerts** come from the app: a platform backup that fails or is not verified, a failed
  off-site copy or test restore, no verified backup for 26 hours, payment failures, AI provider
  errors over a threshold in 15 minutes, a daily AI spend spike (today over 3× the 7-day
  average), failed sign-ins (and 2-step codes) over a threshold in 15 minutes, and a queue
  backlog. A refused AI key or a provider that is not set up alerts at once. Repeats of the
  same alert within 30 minutes are grouped: the next one says how many were held back (every
  6 hours while no backup is verified, once in 12 hours for the spend spike). Thresholds are
  settings, read at most every 15 seconds. Modules raise alerts as events (`platform.alert`,
  `platform.signal`) and never wait on delivery; sign-in failures are read from the audit
  log's events, handovers from the AI's.
- **Delivery.** Each message is a row in `telegram_messages` (kept 90 days) and a job on the
  `telegram` queue: up to 5 tries, Telegram's `retry_after` respected on 429, a chat that
  blocked or removed the bot is marked "unreachable" and skipped. When Telegram is not set up,
  no chat takes the alert's topic, or delivery fails for good, the alert is emailed to the
  platform's owners (email fallback, a setting, on by default).

**Consequences.**

- The worker must run for reports, alerts and command replies; the webhook only stores the
  update and queues it.
- Server-level alerts and the plan's error-spike alert wait for the monitoring stack.
- Handovers are counted from the moment this is deployed (an hourly count in `platform_counts`,
  kept 400 days), not from history.
- Spike windows are fixed 15-minute blocks, not sliding: a burst across two blocks can stay
  under the threshold in each.
