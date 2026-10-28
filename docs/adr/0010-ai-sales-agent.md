# 0010 — AI sales agent: provider interface, tool loop, metered per turn, queued replies

**Status:** accepted (2026-10-28)

**Context.** Merchants want the inbox to answer customers on its own: suggest products, quote
prices with delivery, take orders, remember the customer, and hand the chat to a person when it
should, in Bangla, Banglish or English. The platform's margin is the AI credit price, so every
call must be metered and a business must never spend more than its wallet holds. Model names
and provider details must not be hard-coded in features.

**Decision.**

- **Provider interface.** Features talk to `AiProvider` (`src/modules/ai/provider`): a neutral
  turn request (system, messages, tools, effort, end-user id) and result (stop reason, text,
  tool calls, token usage, the raw assistant turn to replay). `AnthropicProvider` implements it
  with the official SDK. The model id always comes from the model catalogue in the database
  (the tier's default model); the provider name on that model picks the implementation. A
  model whose provider is not set up answers "unavailable", which hands the chat to people.
  Adding OpenAI or Gemini is one more class in the `AI_PROVIDERS` list.
- **Claude specifics, in one place.** Strict tool schemas (all properties required, nullable
  fields as `null` unions; bounds are checked with Zod after the call, since strict schemas do
  not support them), automatic tool choice, adaptive thinking with `effort: low`, a top-level
  `cache_control` so the stable prefix (tools, instructions, catalog) is cached between turns,
  and `metadata.user_id` set to a hash of the business and contact, never a raw id. The
  assistant turn is replayed unchanged (thinking and tool_use blocks). Tools are never run on
  a `refusal` or `max_tokens` turn. SDK errors are mapped by type (rate limit, overloaded,
  timeout, auth, bad request), never by message text.
- **Tool loop with seven tools.** `search_products`, `get_product`, `quote_order`,
  `create_order`, `get_my_orders`, `save_customer_details`, `handover_to_human`. Tools run
  inside the business's tenant context, so they cannot reach another business's data (tested).
  Prices and totals always come from the tools, which use shop prices; the model cannot set a
  price or a discount. `create_order` re-checks stock, refuses a duplicate of an order placed
  in the same chat in the last 15 minutes, links the chat's contact to the customer, and
  places the order as Pending (or Confirmed if the merchant chose so). At most six model
  turns per reply.
- **Metered per model turn.** Before each call, the worst case (estimated prompt plus the full
  output budget) is reserved from the wallet; after it, the real token count is settled and
  the rest released. A call that fails is released in full. Cache reads and writes are billed
  to the merchant as ordinary input tokens (one simple price); the platform's cost uses the
  provider's cache prices, so the profit report stays exact. Merchants see credits only, never
  the model or its cost.
- **Replies run in the worker.** A customer message schedules a BullMQ job after the
  business's reply delay (default 3 s). The newest message per conversation is kept in Redis,
  so a burst of messages gets one answer. A per-conversation lock (Redis `SET NX` with a
  compare-and-delete unlock) stops two replies at once; a busy job is requeued. Retryable
  provider errors are retried by the queue (3 attempts with backoff); on the last attempt the
  chat goes to people. Before posting, the reply is dropped if a person answered or paused the
  AI meanwhile.
- **Handover.** The AI pauses itself in a conversation, tells the customer (in their script,
  or the merchant's own message), and adds a line for the team with the reason, when: the
  model calls `handover_to_human`, the customer uses a handover phrase (no model call), the
  daily per-chat reply limit is reached, credits run out, the service is unavailable, the
  model refuses or cannot finish, or retries are exhausted. A person turns it back on with the
  switch or by sending `.`; if the customer is still waiting, the agent answers then.
- **Settings and the test chat.** One settings document per business. Behaviour (on/off,
  tone, language, quality tier, orders, handover, timing) needs `ai.settings.manage`; the
  knowledge (business info, FAQs, rules) also `ai.knowledge.manage`, so managers can keep it
  current without being able to turn the agent on. The test chat runs the real agent on the
  real catalog with unsaved settings; it spends credits, places no order and messages nobody.
- **Customer memory.** Short facts (up to 20) and a delivery address on the contact, written
  by the agent through `save_customer_details` and correctable by staff in the inbox. The
  prompt includes them with the customer's last three orders.

**Consequences.**

- Replies go out on website chat now. Messenger, Instagram and WhatsApp conversations are
  skipped (`channel_send_unavailable`) until those connections are built (M4c).
- Tests drive the real SDK through an injected `fetch` that plays the Messages API
  (`test/helpers/fake-anthropic.ts`). They prove our side of the contract, not the model's
  answers. For browser checks without a key, `scripts/claude-stand-in.mjs` answers in the
  API's format with fixed rules; it is not an AI and must never be used in production.
- The real model's quality in Bangla and Banglish has not been measured yet. Before launch,
  run a set of real customer chats against Claude with a real key and review the answers.
