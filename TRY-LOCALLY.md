# Try Sellora on your own computer

One set of Docker commands runs everything: the database, Redis, the API, the background
worker, the web app, the online stores and a test email inbox. You do not need to install MongoDB, Redis or
Node.js.

This setup is for trying Sellora, not for real customers. Messenger, Instagram and WhatsApp
need a public web address that Meta can reach, so test those on the deployed version
(`DEPLOY.md`).

## What you need

- Docker Desktop (Windows or Mac) or Docker Engine with Compose 2.24 or newer.
- About 4 GB of free disk space, and at least 4 GB of memory given to Docker.
- Git, to download the code.

## Start it

```bash
git clone https://github.com/emonhridoy20146/sellora-ai.git
cd sellora-ai

# 1. Once: make fresh secrets for this computer.
docker compose run --rm keys > local-secrets.env

# 2. Build and start everything. The first build takes several minutes.
docker compose up --build -d

# 3. Once: add the demo businesses and get the super-admin setup link.
docker compose run --rm tools
```

On **Windows PowerShell 5**, write step 1 like this instead, so the file is plain text:

```powershell
docker compose run --rm keys | Out-File -Encoding ascii local-secrets.env
```

Step 3 ends with a list like this:

```
Owner:     owner@demo.sellora.test
Password:  sellora demo password   (all demo users)
Finish the platform owner account (password + 2FA) within 24 hours:
  http://localhost:3000/admin/setup?token=…
```

## Use it

| What                 | Where                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app              | http://localhost:3000. Sign in as `owner@demo.sellora.test` (Dhaka Fashion House) or `shop@demo.sellora.test` (Nakshi Ghor). The password for both is `sellora demo password`.                |
| Super-admin          | Open the setup link from step 3. Choose a password, scan the QR code with an authenticator app, then use http://localhost:3000/admin.                                                         |
| Emails Sellora sends | http://localhost:8025 (Mailpit). This covers sign-up links, password resets and staff invites. Nothing leaves your computer.                                                                  |
| Online stores        | `http://<shop address>.sellora.localhost:3100`, for example http://nakshi-ghor.sellora.localhost:3100. Use Chrome, Edge or Firefox, which send any `.localhost` address to your own computer. |

### Open a demo online store

1. Sign in as `shop@demo.sellora.test` and open **Online store**. Create a store with the
   address `nakshi-ghor`, choose a theme, then **Send for review**.
2. In the super-admin panel, open **Online stores**, open the store and approve it.
3. Open http://nakshi-ghor.sellora.localhost:3100. Shop, check out with cash on delivery, and
   the order appears in **Orders**.
4. Open the store again in the dashboard and choose the **Numbers** tab: your visit, the
   product you looked at, the cart, the checkout and the order are counted (each shopper once
   a day). To see a source, open the store with `?utm_source=facebook` at the end of the
   address in a private window. Your own **Preview** is never counted.
5. Change something shoppers read, for example **Pages › About us**, and save. It is live at
   once, and the store appears in the super-admin panel under **Online stores › Changed since
   approval** with the words before and now. Try **Ask for a fix** (the owner sees the note on
   the store page and gets an email in Mailpit, http://localhost:8025) and **Looks fine**.

Landing pages work the same way (**Landing pages**, then approve them under **Landing pages**
in the super-admin panel) and open at `http://nakshi-ghor.sellora.localhost:3100/<page address>`.

### Try payments at checkout

Shoppers can pay online with the business's own bKash, Nagad, SSLCommerz, aamarPay or
shurjoPay account, in full or as an advance on cash on delivery. To try it without merchant
accounts, use the payment stand-in. It is **not** a payment gateway: no money moves, and its
Pay and Cancel page stands in for the gateway's page.

1. Add these lines to the `.env` file next to `compose.yaml` (create it if needed):

   ```
   PAYMENT_BKASH_SANDBOX_URL=http://payment-stand-in:4110/bkash
   PAYMENT_NAGAD_SANDBOX_URL=http://payment-stand-in:4110/nagad
   PAYMENT_SSLCOMMERZ_SANDBOX_URL=http://payment-stand-in:4110/sslcommerz
   PAYMENT_AAMARPAY_SANDBOX_URL=http://payment-stand-in:4110/aamarpay
   PAYMENT_SHURJOPAY_SANDBOX_URL=http://payment-stand-in:4110/shurjopay
   ```

2. Run `docker compose --profile payments-demo up -d`.
3. Sign in as `shop@demo.sellora.test` and open **Settings › Payments**. Connect a gateway
   with **Test mode** on and these demo keys:

   | Gateway    | Keys                                                                                                                                 |
   | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
   | bKash      | App key `demo-bkash-app-key`, app secret `demo-bkash-app-secret`, username `demo-bkash-user`, password `demo-bkash-password`         |
   | SSLCommerz | Store ID `demosellora01`, store password `demosellora01@ssl`                                                                         |
   | aamarPay   | Store ID `aamarpaytest`, signature key `demo-aamarpay-signature-key`                                                                 |
   | shurjoPay  | Username `demo-shurjopay`, password `demo-shurjopay-password`, order prefix `DEMO`                                                   |
   | Nagad      | Merchant ID `683002007104225`, number `01711428036`, and the two keys shown at http://localhost:4110/__nagad-keys (new each restart) |

4. Under **How shoppers can pay**, choose an advance (for example **Delivery charge** for
   Outside Dhaka) and save.
5. Order from the store or a landing page, choose how to pay, and press Pay or Cancel on the
   stand-in's page. The receipt says what happened (and offers **Pay now** after a cancel),
   and the order in **Orders** shows the payment and every try.

With real sandbox keys from a gateway instead, leave those lines out: Sellora then uses the
gateway's own sandbox. Live keys take real money; switch **Test mode** off only when one
sandbox payment has worked.

### Try ad tracking

A business can put its own Meta Pixel, TikTok Pixel, Google Analytics 4 and Google Ads tags on
its store and landing pages, and send the same events from the server. To see what would be
sent without ad accounts, use the tracking stand-in. It is **not** Meta, TikTok or Google:
nothing reaches an ad account. (The browser tags still try to load Meta's, TikTok's and
Google's real scripts; with the demo ids those platforms simply ignore them.)

1. Add these lines to the `.env` file next to `compose.yaml`:

   ```
   TRACKING_META_BASE_URL=http://tracking-stand-in:4120/meta
   TRACKING_TIKTOK_BASE_URL=http://tracking-stand-in:4120/tiktok
   TRACKING_GA4_BASE_URL=http://tracking-stand-in:4120/ga4
   ```

2. Run `docker compose --profile ads-demo up -d`.
3. Sign in as `shop@demo.sellora.test` and open **Settings › Ad tracking**. Add:

   | Platform           | Demo ids and keys                                                                                             |
   | ------------------ | ------------------------------------------------------------------------------------------------------------- |
   | Meta Pixel         | Pixel ID `1234567890123456`, access token `demo-meta-capi-token-not-real`, test event code `TEST12345`        |
   | TikTok Pixel       | Pixel ID `CDEMOPIXEL000000001`, access token `demo-tiktok-events-token-not-real`, test event code `TEST67890` |
   | Google Analytics 4 | Measurement ID `G-DEMO123456`, API secret `demo-ga4-api-secret-not-real`                                      |
   | Google Ads         | Conversion ID `AW-123456789`, label `AbCdEf12` (browser only: nothing reaches the stand-in)                   |

4. Press **Send test event** on each, then look at http://localhost:4120: each test arrives
   there with its test code.
5. Open the store, look at a product, add it to the cart and order. The stand-in's page shows
   the product view, add to cart, checkout and purchase as Meta, TikTok and Google Analytics
   would receive them, and **What was sent** in Settings lists them too. Try **Ask first** to
   see the banner shoppers get.

With your real ids and keys instead, leave those lines out, and send a test event from
Settings: it shows in Meta's and TikTok's **Events Manager › Test events**, or Google
Analytics' **DebugView**.

### Try the landing page extras

Do this after the store is open (above). In the super-admin panel, **Settings › Publish landing
pages without a person reviewing them** saves approving each version by hand; otherwise
approve each one under **Landing pages**.

1. Sign in as `shop@demo.sellora.test`. In **Landing pages › New page**, pick a product and a
   template, for example **Fashion › Eid and festive wear** or a Bangla one. Change the words
   the editor lists as still to change. **Add section** shows all 41 blocks in groups.
2. Open **Coupons** in the menu and create a code, for example 10% off with a ৳300 cap, for the
   store and all landing pages. Add a **Coupon code** block on the page with that code.
3. **Publish changes › Now**. Open the page on your phone or in a narrow window: **Use this
   code** puts the code in the order form, **Choose** on a package card picks the package, and
   the total shows the discount. Order, then see the code on the order and the use counted in
   **Coupons**. The same code works at the store checkout ("Have a coupon code?").
4. Change the headline, then **Publish changes › At a time** a few minutes ahead. The page
   shows **Goes live on …** with **Publish now**, **Change time** and **Cancel**; at the time,
   the new headline is live within about a minute.
5. Change the headline again, then **Publish changes › As an A/B test**. Open the page in a few
   private windows: each window keeps seeing one version. **A/B tests** counts visitors, buyers
   and orders for each and says when one sells clearly better; **Make B live** or **Keep A**
   ends it by hand.
6. In the page's **Settings**, set **Offer ends at** a few minutes ahead: at that time the page
   pauses itself. **Resume** brings it back.
7. In the page's **⋯** menu, **Save as template**, then find it under **My templates** when you
   make a new page.

### Turn on the AI sales agent

Create a file named `.env` next to `compose.yaml` (never commit it) with your key:

```
AI_ANTHROPIC_API_KEY=sk-ant-...
# Optional: voice notes to text
AI_OPENAI_API_KEY=sk-...
# Optional: owner reports on Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
```

Then run `docker compose up -d` again. Without a key, the AI sales agent hands every chat to
your team. Each AI reply is charged in the business's AI credits, and costs you real
Anthropic tokens.

## What works here, and what needs the deployed version

**Works on your computer:**

- Sign-up and staff.
- Plans, the wallet and AI credits.
- Products, customers and manual orders.
- The website chat with the AI sales agent. Add it in **Settings › Channels**, then press
  **Try it**.
- The value dashboard and Analytics.
- Catalog sync from Shopify, WooCommerce, Google Sheets or CSV links.
- Reading your own website.
- Couriers with your sandbox or real courier credentials.
- SMS with your provider's credentials.
- Backups. Copies to Google Drive need a Google OAuth client with the redirect
  `http://localhost:3000/v1/backups/google/callback`.
- Online stores and landing pages, with cash on delivery or online payment (with the payment
  stand-in or a gateway's sandbox keys). Businesses' own domains need the deployed version.
- Coupons, scheduled publishing, offer ends and A/B tests on landing pages.
- Ad tracking with the tracking stand-in, or with your own Meta, TikTok and Google ids and
  keys (server events go out from your computer to the real platforms).

**Needs the deployed version:**

- Messenger, Instagram and WhatsApp, including customers' photos and voice notes. Meta must
  reach Sellora's webhook at a public `https://` address.
- Telegram commands. Sending reports works locally, but commands need Telegram to reach the
  webhook.

## Stop, update, start over

```bash
docker compose down             # stop; your data stays
docker compose up -d            # start again
git pull && docker compose up --build -d   # update to the newest code
docker compose down -v          # stop and ERASE all data (database, files, emails)
```

## If something goes wrong

- `docker compose ps` shows what is running. `docker compose logs api` (or `worker`, `web`)
  shows why something stopped.
- If **port 3000, 3100 or 8025 is already in use**, stop the other program, or change the
  left-hand number under `ports:` in `compose.yaml`. If you change 3000, also change every
  `localhost:3000` in that file; if you change 3100, also change `STOREFRONT_BASE_DOMAIN`.
- If a shop address says **"This site can't be reached"**, use Chrome, Edge or Firefox. Safari
  may not send `.localhost` addresses to your computer.
- If a shop shows **"opening soon"**, it has not been approved yet in the super-admin panel.
- If the API keeps restarting with "Invalid environment configuration", the message names
  the setting. Usually `local-secrets.env` is empty or not plain text. Make it again with
  step 1.
