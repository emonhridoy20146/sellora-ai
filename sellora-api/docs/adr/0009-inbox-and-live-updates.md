# 0009 — Inbox: one message pipeline, live updates through Redis, visitor tokens

**Status:** accepted (2026-10-27)

**Decision.**

- **Data.** A `Channel` is a place customers write from (`web_chat` now; `messenger`,
  `instagram`, `whatsapp` next). A `Contact` is one person on one channel, identified by the
  channel's id for them. Each contact has exactly one `Conversation` (unique index), which new
  messages reopen. `Message`s carry the channel's message id (`externalId`) or the sender's own
  id (`clientId`); both have unique indexes, so a webhook delivered twice or a retried send is
  stored once.
- **One pipeline.** `MessagingService.receiveInbound` and `postOutgoing` are the only ways a
  message is stored. Web chat, the Meta channels and the AI agent all go through them, so
  dedupe, unread counts, the monthly limit and live events behave the same everywhere. After a
  customer message is stored, an `inbox.message.received` event is emitted; the AI agent
  subscribes to it rather than the inbox calling the AI.
- **Who sees what.** Staff with `inbox.view` see every conversation. Staff with only
  `inbox.view_assigned` see the ones assigned to them; anything else answers 404, in lists,
  threads and live events alike.
- **Human handover.** A staff reply takes the conversation: it is assigned to them if nobody
  had it, and if the plan has the AI agent and the channel has AI on, the AI pauses for that
  conversation, with a line in the thread saying so. A reply of just `.` toggles the AI instead
  of being sent (needs `inbox.ai_control`). Notes and system lines are never shown to customers.
- **Monthly limit.** A conversation counts toward `conversationsPerMonth` the first time the
  customer writes in a month (business time zone). Past the limit the message is still stored
  but the conversation is locked: its preview is blank, opening or replying answers 402, and
  the AI will not answer. When the plan has room again (an upgrade), opening it unlocks and
  counts it. Two first messages in the same instant can both count, so the limit can be passed
  by one or two; it is a soft limit by design (customer messages are never dropped).
- **Live updates.** Socket.IO on `/socket.io` with two namespaces: `agents` (staff, signed in
  with the session cookie or a bearer token, then `join` a business) and `webchat` (visitors,
  with their visitor token). Every process publishes events to one Redis pub/sub channel and
  every API instance emits them to the sockets it holds, so the worker can post AI replies and
  several API instances work without a Socket.IO adapter package. Staff sockets are re-checked
  every minute and dropped when the session ends or the role loses the inbox. Live delivery is
  best effort; clients refetch when they reconnect.
- **Website chat.** The widget has no account. `POST /v1/webchat/:key/session` returns an
  HMAC-signed visitor token (`WEBCHAT_TOKEN_SECRET`, 180 days) that the widget keeps and sends
  as a bearer token. These routes skip the session guard entirely (`@OwnTokenAuth`), so a
  merchant signed in with cookies in the same browser can still use their own widget. Sends are
  rate limited per visitor and per IP (`webchat:visitor`, `webchat:ip`). A widget whose channel
  is off, whose business is suspended or whose plan lacks the inbox answers 404.

**Why.** One pipeline is the only way the rules above stay true when the fourth channel and the
AI arrive. Redis pub/sub is already in the stack and keeps the worker and API decoupled. Visitor
tokens instead of cookies avoid third-party cookie blocking in iframes.

**Consequences.** Behind a load balancer with several API instances, Socket.IO's HTTP
long-polling needs sticky sessions (or clients use the WebSocket transport only). Pub/sub
messages published while an API instance is restarting are lost for its sockets; clients
refetch on reconnect. Messenger, Instagram and WhatsApp joined the same pipeline in M4c
(ADR 0011).
