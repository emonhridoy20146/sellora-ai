# 0012 — Customers' photos: copied from Meta into private storage, shown to staff and the AI

**Status:** accepted (2026-10-28)

**Context.** On Messenger, Instagram and WhatsApp, customers often start with a photo
("do you have this?", a screenshot of a product, a payment slip). Until now Sellora kept only
Meta's link: Messenger and Instagram CDN links expire within days, WhatsApp media can only be
fetched with the channel's token, and the AI agent saw "[The customer sent a photo]". The team
needs to see the photo in the inbox long after Meta's link expired, and the AI agent should be
able to look at it when the model supports images. The photos are customers' personal data,
so they must never be publicly readable.

**Decision.**

- **Store the message first, copy the photo after.** A webhook stores the message at once with
  each photo as an attachment `{status: 'pending', source}` (`source` is the CDN link, or
  `wa:<media id>` for WhatsApp) and puts a job on the `media` queue (`media-<messageId>`,
  5 attempts, exponential backoff from 5 s). The worker (`MetaMedia`, concurrency 4)
  downloads each pending photo and saves it with `FilesService.saveBytes`, then marks it
  `ready` (with the file id) or `failed` with a reason staff can read. The inbox hears each
  change live (`message.updated`).
- **Download only from Meta.** `MetaGraph.download` accepts https links on Meta's media hosts
  (`fbcdn.net`, `fbsbx.com`, `cdninstagram.com`, `facebook.com`, `whatsapp.net` and their
  subdomains) and the configured `META_GRAPH_BASE_URL` origin (for local stand-ins). Redirects
  are followed by hand, at most 3, and every hop must stay on those hosts, so a crafted link
  cannot make the server fetch an internal address. The channel's token is sent only to the
  first link (WhatsApp's media store), never to a redirect target. Downloads stop at
  `CHAT_MEDIA_MAX_MB` (declared length or bytes read) and time out after 30 s.
- **WhatsApp:** `GET /<media id>` with the channel's token returns a short-lived link, its MIME
  type, size and SHA-256; the file is fetched with the same token and must match the checksum.
- **Trust the bytes, not the label.** `saveBytes` reads the image type from the first bytes
  (JPEG, PNG, WebP, GIF, AVIF), refuses anything else ("not a photo type Sellora can show"),
  checks the size, reserves space against the plan's storage limit (402 when full), and
  stores the file under `o/<orgId>/chat/<fileId>.<ext>` as `chat_media`: private, counted in
  the business's storage, kept with the message (not removed by the unused-file sweep).
- **Retry only when it can help.** A gone link (403, 404, 410, unknown WhatsApp media), a
  revoked token, a file too large, a non-image or a full plan fail at once with a reason. Rate
  limits, outages, network errors and checksum mismatches are retried; photos already saved
  stay saved and are not downloaded again. After the last attempt the photo is marked failed
  ("the download from Meta kept failing").
- **Served only to staff who can see the chat.** `GET
/v1/orgs/:orgId/conversations/:cid/messages/:mid/attachments/:index` applies the inbox's
  rules (the inbox module, `inbox.view` or `inbox.view_assigned` with its "assigned to me"
  scope, the monthly lock), checks the message is
  in that conversation, and streams the file with `Cache-Control: private`, `nosniff` and a
  sandboxing CSP. The public storage route refuses private files without a signature, and an
  S3 bucket must only make `o/*/products/*` public. The message DTO gives this route as the
  attachment URL; the website-chat visitor DTO never includes saved chat files.
- **The AI looks at the newest photos.** Each AI model in the catalogue has `imageInput`
  (edited by the super-admin; the seeded Claude models have it on). When the business's model
  can see images, the reply job takes the customer's newest 3 saved photos, re-encodes each
  with `sharp` (turned upright, fitted inside 1280 px, JPEG quality 80, metadata such as
  location removed, inputs over 50 megapixels refused) and sends them as image blocks labelled
  "Photo 1", "Photo 2" in the customer's turn; the text says which message each came with.
  Older photos stay as "[The customer sent a photo]". Credit reservation counts each photo as
  width × height / 750 tokens and leaves the base64 out of the text estimate; billing uses the
  provider's real token count as for any reply. The system prompt tells the model to describe
  what it sees in its product search and to be honest about similar versus exact matches.
  When the model cannot see images, the prompt asks it to have the customer describe the item.
- **The reply waits briefly for photos.** If a customer message being answered still has a
  photo `pending`, the reply job puts itself back for 2 s, up to 10 times (20 s), then answers
  without it.

**Consequences.**

- Photos survive Meta's link expiry and count against the plan's storage, like product photos.
- Customers' photos never become public URLs; viewing one needs a staff session in the
  business, with the same visibility as the conversation.
- Files (PDFs and other documents) on Messenger and Instagram still keep Meta's link and are
  not copied; WhatsApp documents and audio are not fetched yet.
- The AI sees at most 3 photos per reply, which bounds the cost of a reply with photos (a
  1280 × 960 photo is about 1,640 input tokens).

**Verified against stand-ins only.** API tests drive all of this with a fake Graph API and a
fake Anthropic API (`test/e2e/meta-media.e2e.ts`, unit tests for the downloader and image
preparation), and `sellora-web/scripts/photos-flow.mjs` checks it in a real browser against
`scripts/graph-stand-in.mjs` (demo photos and WhatsApp media) and `scripts/claude-stand-in.mjs`
(which cannot see; it reports how many photos it received). Not yet tried with real Meta
webhooks or a real Claude model looking at a real product photo.
