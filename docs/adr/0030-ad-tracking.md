# ADR 0030 — The business's own ad tags on its store and landing pages, with server copies

**Status:** accepted (2026-11-11). Phase 2 module 3, "Ad tracking".

**Context.** Businesses in Bangladesh sell mostly through Facebook, Instagram and TikTok ads.
Those ads learn who buys only when the shop tells the platform: the browser tag (Meta Pixel,
TikTok Pixel, Google's gtag) on the shop, and, because ad blockers and phone browsers stop
many browser tags, the platform's server API (Meta Conversions API, TikTok Events API, GA4
Measurement Protocol). Each business uses its own ad accounts, so Sellora must take the
business's own ids and keys and never mix businesses. Most orders are cash on delivery, so a
business may want a purchase to count only once the courier delivered it. Inbox orders
(Messenger, WhatsApp) never pass through a web page at all.

**Decision.**

- **Tracking ids** (`addestinations`, at most 12 per business): Meta Pixel (pixel id;
  optional Conversions API access token and test event code), TikTok Pixel (pixel code;
  optional Events API access token and test event code), Google Analytics 4 (measurement id;
  optional Measurement Protocol API secret) and Google Ads (conversion id and the purchase
  conversion label; browser only). Ids are checked against each platform's pattern; one id
  once per business. Keys are encrypted (AES-256-GCM, bound to the id's record) and never
  returned, only a hint of the last four characters. A Meta token is checked before saving by
  reading the pixel's name with it (`GET /{pixel}?fields=id,name`); a refused token is a 422.
  TikTok and GA4 have no read call that proves a key, so they show "not checked" and the
  business sends a test event. Staff with `org.integrations.manage` manage them; every change
  is audited (`ad_tracking.*`).
- **Where each id loads:** everywhere (the store and every landing page, also later ones) or
  chosen stores and landing pages. Each id can be switched off.
- **When a purchase counts** (`purchaseWhen`): when the order is placed (the default, browser
  and server), or when it is delivered (server only, so it needs the server key). Meta and GA4
  can also be sent inbox and hand-made orders (`chatOrders`, server key needed): Meta as
  `action_source: chat` (inbox) or `other` (by hand or the API); TikTok's web events take only
  web pages, so it cannot.
- **In the shopper's browser** the storefront loads each platform's standard snippet for the
  page's ids (`GET /v1/storefront/resolve` and the landing view return `tracking` with the
  public ids only; previews get none). Page views go to Meta and TikTok as the shopper moves
  (Meta's own history tracking is turned off so nothing counts twice) and to GA4 by gtag
  itself. Product view, add to cart and checkout start go to each tag with a fresh event id,
  and the same event, with the same id, is posted to `POST /v1/storefront/ad-events` (or the
  landing page's) for a server copy. On the receipt or thank-you page the purchase goes to
  Meta and TikTok with the event id `purchase.<orderId>`, and to Google Ads as a conversion
  with the order number as `transaction_id` and, for enhanced conversions, only the SHA-256
  of the normalized email and E.164 phone. GA4 purchases are sent from the server only. A
  browser reports a purchase once (kept in local storage) and only on the day it was placed.
- **From the server** (queue `ad-events`, worker): server copies of browser events go only to
  ids with a server key, priced from the catalog (never from the browser). Purchases come from
  the order itself: once per order and id (the log is checked first), with the same event id
  as the browser's, so each platform counts the purchase once. Sent details: email, phone
  (E.164; Meta without the plus), first and last name, city, country (`bd` only for a
  Bangladeshi number) and `customer:<id>` as external id, all normalized and SHA-256 hashed;
  the browser's `_fbp`, `_fbc` (or one made from the ad's `fbclid`), `_ttp`, `ttclid`, GA's
  client and session ids, IP and user agent as they are. What the browser knew at checkout is
  kept for 35 days (`adordercontexts`) for purchases counted on delivery. A cancelled or
  returned order whose purchase was sent goes to GA4 as a refund; Meta and TikTok have no
  refund event for web purchases, so they are not told. Each send is logged for 14 days
  (`adeventlogs`: event, id, sent or failed and what the platform said), shown in Settings ›
  Ad tracking with the last 7 days' counts. A temporary fault (5xx, rate limits, Meta's
  temporary codes) is tried again (3 times for browser events, 6 with back-off for orders);
  a refusal is logged at once and shown on the id until a send works.
- **Asking shoppers first** (`adtrackingsettings.consent`): "don't ask" (the default) or "ask
  first". With "ask first" the store and landing pages show a banner (English and Bangla) and
  load no tag until the shopper allows it; the browser sends `consent: false` with the order
  otherwise, and the server then sends nothing about the shopper or the order, now or on
  delivery. The choice is kept in the shopper's browser (`sl_consent`).
- **Test events:** Meta and TikTok send a product view with the test event code (so it shows
  in Events Manager › Test events and is not counted); GA4 checks the request with the
  validation endpoint, then sends `sellora_test` in debug mode. Google Ads has no test from
  Sellora. Limited to 30 an hour per business; shopper events to 240 a minute per address.
- Platform addresses default to the real ones and can be pointed elsewhere with
  `TRACKING_META_BASE_URL`, `TRACKING_TIKTOK_BASE_URL` and `TRACKING_GA4_BASE_URL` (Meta's
  Graph version is `META_GRAPH_VERSION`, shared with the inbox).

**Consequences.**

- Built from the platforms' public documents (Meta Conversions API and Pixel, TikTok Events
  API 2.0 and Pixel, GA4 Measurement Protocol and gtag, Google Ads enhanced conversions for
  web) and tested against fakes that answer like those documents (API tests) and a local
  stand-in (`scripts/tracking-stand-in.mjs`) with fake browser tags in the browser flow. No
  real ad account was used: a business should send a test event from Settings and look in
  Events Manager or DebugView before relying on it.
- GA4's collect endpoint accepts anything, even a wrong secret, so a "sent" GA4 event only
  means it was delivered; Settings says so.
- Google Ads gets browser conversions only. Offline conversion uploads (for purchases counted
  on delivery, or inbox orders) need the Google Ads API with a developer token and OAuth, and
  are not built.
- TikTok gets no inbox orders, and Meta and TikTok are not told about cancellations.
- A shopper who refused tracking can only change their mind by clearing the site's storage;
  a "tracking choices" link is not built yet.
- Not built: Google Tag Manager containers, Snapchat or other platforms, Meta's advanced
  matching in the browser, value adjustments, and server copies of page views.
