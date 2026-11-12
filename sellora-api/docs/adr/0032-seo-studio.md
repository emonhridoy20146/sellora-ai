# ADR 0032 — AI SEO studio and content studio

**Status:** accepted (2026-11-12). Phase 2 module 5, "AI SEO studio + AI content studio"
(plan M11).

**Context.** Most Sellora businesses sell through Facebook first; their store and landing
pages get little search traffic because product pages have no search title, no meta
description, photos without alt text and addresses made from English names that nobody
types. Their customers search in three ways: Bangla script (জামদানি শাড়ি), English
(jamdani saree) and Banglish (jamdani shari). The businesses do not know SEO words and will
not learn them, so the studio must say plainly what to fix, write it for them and let them
check it before anything changes. Keyword numbers cost money (Google gives them only to
advertisers, so a data provider is needed) and AI writing costs tokens, so both must come
out of the wallet at the super-admin's price and never be paid twice for the same thing.

**Decision.**

- **One writer, structured answers.** `AiWriterService` (`src/modules/ai/writer/`) asks the
  AI provider for JSON that matches a schema (the provider's structured output) and checks it
  again on our side. Each task (product SEO, page SEO, keyword ideas, content) is a prompt and a
  schema in `seo/writer-tasks.ts`, written for small Bangladeshi shops, in Bangla or English.
  The tokens are reserved before the call and settled after it, like the AI sales agent
  (ADRs 0005 and 0010); an answer that does not fit the schema is refused with a clear error
  and still charges what the model used. Usage history names: `seo_product_writer`, `seo_page_writer`,
  `seo_keyword_ideas`, `content_writer`, plus `seo_keyword_volumes` for lookups. Every
  route needs the `seo` module in the plan.
- **Product SEO fields.** Products gain `seo { title, description, keywords[], faq[] }` and
  `previousSlugs[]`. Changing the address keeps the old one, and the shop answers the old
  address with a permanent (308) redirect; a rename moves an address that was made from the
  name. The address may be Bangla (the slug keeps Bengali letters). The product form has a
  "Search engines (SEO)" card: a live score (the same `seo-score.ts` on the API and the web),
  "Write with AI" with a suggestion to take field by field or all at once, title and meta
  counters, a Google preview, alt text per photo, up to 10 questions and answers, a duplicate
  check for titles and metas across the business, and the old addresses that still work.
- **Score.** 11 weighted checks out of 100: a focus keyword, search title length, keyword in
  the title, meta description, keyword in the meta, description length (50 words), alt text on
  every photo, a keyword in the address, a title and a meta no other product uses, and at
  least two questions. Each failing check has a plain sentence on how to fix it. 80 or more is
  good, 50–79 needs work, under 50 is poor.
- **Store technical SEO** (`sellora-storefront`): canonical tags on every shop page; JSON-LD
  `Product` with `Offer` (price, currency, stock) on product pages, `BreadcrumbList`,
  `FAQPage` when the product has questions, and `Organization` plus `WebSite` on the home
  page; the product's search title and meta when set; photo alt text in the page and in
  social previews. The sitemap and robots.txt from the store builder (ADR 0014) list the
  products' current addresses.
- **Keyword research.** A seed phrase and a line about the business give up to 50 AI ideas,
  each marked Bangla, English or Banglish and with an intent (buy, compare, learn, local,
  brand). Monthly searches, competition and a 12-month trend come from DataForSEO's Google
  Ads search volume endpoint for Bangladesh (`KEYWORDS_LOCATION_CODE`, 2050), behind a
  `KEYWORD_FETCH` interface so another provider can replace it.
  - The numbers are cached platform-wide for 30 days (a "no data" answer too), so the
    second business asking for the same phrase pays nothing. Only the missing phrases go to
    the provider, at most 100 per lookup, and one lookup costs the business the flat credit
    price the super-admin sets (Super-admin › AI pricing; empty means no lookups). The credits
    are reserved first and given back when the provider fails.
  - Without a provider login, a price, or credit, ideas still come back and say why there are
    no numbers. A platform-wide rate limit protects the provider account.
  - The last 100 researches per business are kept and can be opened again.
- **Keyword lists** (30 per business, 500 keywords each): add ideas to a list; the list shows
  which active products target each keyword (focus or other keywords) and the gaps nobody
  targets, and looks up missing volumes for the whole list in one lookup.
- **Audit and bulk optimiser.** The overview scores up to 2,000 active products, lowest first,
  with the most common problems and the store's own checks (title, description, sitemap,
  Search Console). "Fix with AI" writes suggestions for up to 50 chosen products, or the
  products under 80, in a queued run (`seo` queue in the worker), one product at a time; a
  run stops by itself when the wallet is empty and can be stopped by hand. Nothing changes a
  product until a person picks the fields to save (title, meta, keywords, FAQ, description,
  tags, alt text, address) per product or for all ready ones. One run at a time.
- **Google Search Console.** The business connects with Google (OAuth, scopes
  `webmasters` and `siteverification`; the Google Drive client from ADR 0021 with a second
  redirect URI). Sellora then, as background steps with retries: gets a meta tag
  verification code and puts it on the store's home page, asks Google to verify, adds the
  site and submits the sitemap. Every day it copies 90 days of clicks, impressions, CTR and
  position by date, and 28 days of search phrases and pages. The report shows totals with the
  change from the period before, daily charts, top phrases and pages, and opportunities:
  phrases almost on page one (average position 5–20) and phrases on page one that are
  clicked less than half as often as usual for their position,
  each linked to its product. Refresh tokens are encrypted per business. A refused consent
  without Search Console, a revoked access, and a failed step each show a plain message and a
  "Try again". Disconnecting revokes the token; the verification tag stays so ownership is not
  lost.
- **Content studio.** Facebook ad copy, captions, product descriptions and translation
  (Bangla, English, Banglish), with tone and the number of versions (1–5), from a product or
  pasted text. Results are kept as drafts (the last 200 per business) to copy or delete.
  "Write with AI" also fills the store's and each landing page's search title and
  description.
- **Tenant data.** All new collections carry `orgId` and go through the tenant repository;
  backups include research, lists, runs and drafts, never the Google connection (the
  keyword cache is platform data, not a business's).

**Stand-ins for trying it locally.** `scripts/claude-stand-in.mjs` answers structured
requests with scripted text (translations say "Stand-in, not a real translation");
`scripts/keyword-stand-in.mjs` imitates DataForSEO with made-up volumes from a hash of the
keyword; `scripts/google-stand-in.mjs` imitates Google's consent screen, Site Verification
and the Search Console API with made-up search numbers. None of them is the real service.

**Consequences.**

- Businesses get usable SEO fields without learning SEO, and nothing is written to a product
  without a person choosing it.
- Keyword numbers are Google Ads estimates rounded into buckets; rare Bangla and Banglish
  phrases often have none, which the page says ("No data") instead of guessing.
- Search Console needs the store's own address to be reachable by Google, so it works only on
  a deployed store (a subdomain or a custom domain), and Google's data arrives two to three
  days late.
- The real DataForSEO, Google Search Console and Claude answers have not been tried yet;
  only the stand-ins and the test fakes have.
- Not built: competitor gap analysis, rank tracking, a blog writer, a content calendar, a
  broken link checker, category page SEO fields and review (rating) markup.
