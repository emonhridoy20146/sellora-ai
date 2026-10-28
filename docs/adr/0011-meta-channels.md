# 0011 — Messenger, Instagram and WhatsApp: one webhook, an outbox, and Meta's rules in one module

**Status:** accepted (2026-10-28)

**Context.** Bangladeshi sellers take most orders on Facebook Messenger, Instagram and
WhatsApp. These conversations must land in the same inbox as website chat, the team and the AI
agent must be able to answer them, and the platform must follow Meta's rules: signed webhooks,
replies only within 24 hours of the customer's last message, message length limits, and rate
limits. Tokens are long-lived secrets that give access to a merchant's page or WhatsApp number.
Several businesses share one Meta app, so every incoming event has to be routed to the right
business without trusting anything in it but the account id.

**Decision.**

- **One Meta app for the platform, configured by environment.** `META_APP_ID`,
  `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` must be set together (checked at start-up);
  `META_LOGIN_CONFIG_ID` and `META_WHATSAPP_CONFIG_ID` switch on Facebook Login for Business
  and WhatsApp Embedded Signup; `META_GRAPH_VERSION` (default `v23.0`) and
  `META_GRAPH_BASE_URL` are the only places the Graph API's address appears. Without the app
  settings the channels page says Meta channels are not switched on, and the webhook answers 503.
- **`src/modules/meta` holds everything Meta-specific.** `MetaGraph` (HTTP client: bearer token
  plus `appsecret_proof`, timeouts, error classification), `parseMetaWebhook` (Messenger,
  Instagram and WhatsApp payloads into one neutral event list), `MetaInbound` (stores events
  through the inbox's `MessagingService`), `MetaSender` (sends a stored reply), and
  `MetaConnectService` (login and connect flows). The inbox module stays channel-neutral: it
  knows a channel's type and its 24-hour rule (`reply-window.ts`), nothing about the Graph API.
- **Errors are classified by code, never by type or message.** Meta labels nearly every error
  `OAuthException`, so the type says nothing. Codes 102, 190, 10 and 200–299 mean the token or
  a permission was revoked (the channel is marked "needs reconnecting" and replies stop); 4, 17,
  32, 613 and WhatsApp's throughput codes are rate limits (retried with backoff); 1, 2, 131000,
  131016, `is_transient` and HTTP 5xx are transient (retried); 131047 and the Messenger
  "outside the allowed window" subcodes mean the 24-hour window closed. Everything else is a
  permanent refusal shown on the message with a Retry button.
- **Webhook: verify, enqueue, answer.** `POST /v1/webhooks/meta` checks `X-Hub-Signature-256`
  (HMAC-SHA256 of the raw body with the app secret, constant-time compare) and only then puts
  the body on the `webhooks` queue and answers 200 at once, as Meta requires. The worker
  processes that queue with concurrency 1, so a customer's messages are stored in the order Meta
  sent them. Events are routed by account id (page, Instagram account or phone number id) with
  an explicit cross-tenant lookup, then handled inside that business's tenant context.
  Duplicate deliveries are ignored by the unique `(channelId, externalId)` message index.
- **Outbox for replies.** A staff or AI reply on a Meta channel is stored first with delivery
  `pending` and a job on the `outbox` queue (`send-<messageId>`, 6 attempts, exponential
  backoff from 10 s). The worker splits long text at sentence or line breaks to each channel's
  limit (Messenger 2000, Instagram 1000, WhatsApp 4096 characters), records which parts went
  out in Redis so a retry never sends a part twice, and waits while an earlier reply in the
  same conversation is still pending, so replies arrive in order. Delivery states only move
  forward (pending → sent → delivered → read, or failed); Messenger read watermarks and
  WhatsApp status webhooks drive them.
- **The 24-hour window is enforced on our side.** `replyWindowEndsAt` is
  `lastInboundAt + 24 h` for Meta channels (null for website chat). Staff replies outside it get
  409 `outside_reply_window`; the AI skips the turn (`outside_reply_window`); the inbox shows a
  notice and offers notes only. Message tags (HUMAN_AGENT) and WhatsApp templates are not used
  yet.
- **Replies sent from Meta's own apps are shown and respected.** Page echoes from our own app
  id are ignored (we stored them already). Echoes from anything else (the Facebook page inbox,
  the Instagram app) are stored as "Sent from Messenger/Instagram" and pause the AI in that
  conversation, as a staff reply in Sellora would.
- **Connecting.** Facebook Login (scopes `pages_show_list`, `pages_messaging`,
  `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`,
  `instagram_manage_messages`, `business_management`, or a Login for Business configuration)
  returns to `/app/connect/meta` in the web app. The `state` is the business id plus a sealed,
  10-minute, single-use payload (AES-GCM with its own context; the nonce is claimed once in
  Redis). The code is exchanged for a long-lived user token, the merchant's pages are kept for
  15 minutes under a session id (encrypted in Redis), and the merchant picks Messenger and/or
  Instagram per page. Sellora checks the page role allows messaging, subscribes the page to
  `messages, messaging_postbacks, message_echoes, message_deliveries, message_reads`, and
  stores the page token. WhatsApp connects with Embedded Signup (code plus phone number and
  WABA ids from Facebook's window) or with a system user token pasted by the merchant; the
  number must belong to the WABA, and Sellora subscribes the app to the WABA.
- **One account, one business.** A page, Instagram account or WhatsApp number can be
  connected to one business only (409 `account_connected_elsewhere`, unique index). Connecting
  it again in the same business refreshes the token and clears "needs reconnecting". Removing a
  channel unsubscribes the page or WABA only when no other channel of that business still uses
  it.
- **Tokens are encrypted with their account as context.** `EncryptionService` with associated
  data `meta:<type>:<externalId>`, so a token copied onto another channel record does not
  decrypt. Tokens never leave the API.
- **Live channel status.** When a channel is switched off, removed, reconnected or marked
  "needs reconnecting", staff sockets of the business (room `org:<id>:staff`) get
  `channel.updated` and reload the channel list, so an open inbox stops offering replies at
  once.

**Why.** Meta retries webhooks that do not answer fast and disables apps that fail too often,
so the endpoint does nothing but verify and enqueue. Storing a reply before sending it means
a crash, a rate limit or a revoked token never loses what the merchant wrote, and the merchant
sees exactly which message did not go out. Classifying by code is the only reliable signal
Meta gives. Keeping Meta's specifics in one module keeps the inbox and the AI agent identical
for every channel.

**Consequences.**

- **Not yet tried with a real Meta app.** Everything is tested against a fake Graph API that
  checks the bearer token and `appsecret_proof` (`test/helpers/fake-meta.ts`, 33 end-to-end
  tests including a real BullMQ worker run), and in real browsers against
  `scripts/graph-stand-in.mjs`, which is not Meta. Before launch: create the Meta app, pass App
  Review for the permissions above and WhatsApp Business Platform onboarding, set the webhook
  URL and verify token in the app dashboard, and run one real conversation per channel.
- Embedded Signup's Facebook window has not been run in a browser (it needs a real app); the
  message parsing is unit-tested and the server side is covered end to end.
- Not built yet: keeping customers' photos. Messenger and Instagram photos are stored as links
  to Meta's CDN, which expire after a while; WhatsApp photos and files need an authorised
  download, so the inbox only shows that one arrived (with its caption). Also not built:
  sending photos, typing indicators, the HUMAN_AGENT 7-day tag, WhatsApp templates for
  messaging after 24 hours, and Instagram comments and story replies.
- The webhook queue runs with concurrency 1 for ordering. At high volume this should become
  per-account ordering (a group key per page or number) instead of one global line.
