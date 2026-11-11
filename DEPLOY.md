# Deploying Sellora for a first real test

This guide puts Sellora online for a small test: your own business and one friend's. It uses
cheap services that can grow later.

| Piece                                           | Where                                                                   | Why                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| API, worker, web app, online stores, Redis      | **Railway** (Hobby plan), Singapore region                              | One bill. Private network between the services. No sleeping, so Meta's webhooks always arrive. Live chat updates (WebSockets) work. |
| Shop addresses (`<shop>.shops.yourdomain.com`)  | A domain you own, at any registrar                                      | Only for the online stores and landing pages. Everything else works on Railway's own address.                                       |
| Database                                        | **MongoDB Atlas** free cluster (M0), Singapore                          | Free up to 0.5 GB.                                                                                                                  |
| Files (photos, voice notes, backups)            | **Cloudflare R2**, private bucket                                       | S3-compatible.                                                                                                                      |
| Email (sign-up codes, password resets, invites) | Any SMTP provider                                                       | Production refuses to start without one.                                                                                            |
| AI                                              | Anthropic API key (Claude); optional OpenAI key for voice notes to text |                                                                                                                                     |

`render.yaml` describes the same setup for Render if you prefer it (see the end). The online
stores (step 4e) are optional: skip that step if you only want to test the inbox and the AI
sales agent first.

**Cost (estimate, not measured).** Railway Hobby is $5 a month and includes $5 of usage. Its
published rates are $10 per GB of memory per month and $20 per vCPU per month. Four small
services that sit mostly idle use well under 1 GB together, so expect roughly $5 to $15 a month,
a little more with the online stores.
Atlas M0 is free. R2 has a free monthly allowance that a two-business test should stay inside.
Check each provider's pricing page before you start, because prices change.

**What has been tried.** Both Docker images were built and run in production mode on the build
machine, against local MongoDB, Redis and MinIO (an S3 stand-in). These all passed:

- The 69-page smoke check, through the web image.
- Signed Meta webhooks, sent through the web app.
- A WebSocket connection through the web app.
- The first super-admin link.

The online store image ran in the local Docker setup (`TRY-LOCALLY.md`), where the store and
landing page browser checks passed: build, review, approval, shopping, checkout and the order in
the dashboard. None of this has run on Railway, Render, Atlas or R2 themselves yet. Expect small
fixes on the first real deploy.

---

## 0. On your computer: make the secrets

You need Node.js 22 or newer ([nodejs.org](https://nodejs.org), LTS). No `npm install` is
needed:

```bash
git clone https://github.com/emonhridoy20146/sellora-ai.git
cd sellora-ai
node sellora-api/scripts/generate-keys.mjs > sellora-secrets.txt
```

`sellora-secrets.txt` now holds the JWT keys, the encryption keys and the other random secrets,
one `NAME=value` per line. Keep a copy somewhere safe, such as a password manager, and **never
commit it**:

- Losing `DATA_ENCRYPTION_KEYS` makes stored courier, SMS and Meta tokens unreadable.
- Losing `BACKUP_ENCRYPTION_KEYS` makes backups unreadable.

## 1. MongoDB Atlas (database)

1. At [cloud.mongodb.com](https://cloud.mongodb.com), create a project, then **Create** a
   cluster. Choose **Free (M0)**, provider AWS, region **Singapore (ap-southeast-1)**.
2. **Database Access**: add a database user with a long random password, using letters and
   digits only so it needs no escaping in the URL. Give it "Read and write to any database".
3. **Network Access**: add `0.0.0.0/0` ("allow access from anywhere"). Railway's outgoing
   addresses are not fixed on the Hobby plan, so the password is what protects the database.
4. **Connect › Drivers**: copy the connection string. It looks like
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.
   This is your `MONGODB_URI`.

Atlas free clusters are replica sets, so Sellora's transactions work. Their limits are 0.5 GB,
500 connections and 100 operations a second. That is plenty for two businesses. Move to a paid
tier before real launch.

## 2. Cloudflare R2 (files)

1. In the Cloudflare dashboard, open **R2** and create a bucket, for example `sellora-files`.
   **Do not turn on public access** (r2.dev or a custom domain): customers' photos and voice
   notes are stored there, and Sellora serves every file through its own signed-in routes.
2. **Manage API tokens**: create a token with **Object Read & Write** on that bucket only.
   Note these three values:
   - the Access Key ID (`S3_ACCESS_KEY_ID`);
   - the Secret Access Key (`S3_SECRET_ACCESS_KEY`);
   - the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (`S3_ENDPOINT`).
3. The CORS rule comes in step 5, once the web address is known.

## 3. Email (SMTP)

Use any provider that gives SMTP details, such as your domain's mail host or a transactional
email service. Build one URL from those details:

```
SMTP_URL=smtps://USERNAME:PASSWORD@smtp.example.com:465
```

- Use `smtp://…:587` for STARTTLS instead of SSL.
- Percent-encode special characters in the password. For example, `@` becomes `%40`.
- Set `MAIL_FROM` to an address on a domain the provider lets you send from, for example
  `Sellora AI <no-reply@yourdomain.com>`.

## 4. Railway (API, worker, web app, online stores, Redis)

Sign up at [railway.com](https://railway.com) and choose the Hobby plan. Connect your GitHub
account when it asks, so Railway can read `emonhridoy20146/sellora-ai`.

### 4a. Project and Redis

1. **New Project › Deploy from GitHub repo** and pick `sellora-ai`. Railway creates one
   service, which becomes the API. Its first build fails because its settings are not done yet.
   That is fine.
2. In the project, choose **+ New › Database › Redis**. Its service is called `Redis`.

### 4b. The `api` service

Open the service Railway created and go to **Settings**:

- **Name**: `api` (the variables below refer to services by name).
- **Source › Root Directory**: `/sellora-api`. Railway then finds `sellora-api/Dockerfile`.
- **Deploy › Region**: Southeast Asia (Singapore).
- **Deploy › Healthcheck Path**: `/v1/health/ready`.
- **Build › Watch Paths** (optional): `/sellora-api/**`, so changes to the web app do not
  rebuild the API.
- No public domain is needed. The browser, Meta and Google reach the API through the web app's
  address.

Then go to **Variables › Raw Editor** and paste this block:

```
NODE_ENV=production
PORT=4000
TRUST_PROXY_HOPS=1
WEB_APP_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
API_PUBLIC_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
CORS_ORIGINS=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
COOKIE_SECURE=true
STOREFRONT_URL_SCHEME=https
STOREFRONT_BASE_DOMAIN=shops.yourdomain.com
MONGODB_URI=<from step 1>
MONGODB_DB_NAME=sellora
REDIS_URL=${{Redis.REDIS_URL}}
MAIL_TRANSPORT=smtp
SMTP_URL=<from step 3>
MAIL_FROM=Sellora AI <no-reply@yourdomain.com>
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=sellora-files
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=<from step 2>
S3_SECRET_ACCESS_KEY=<from step 2>
AI_ANTHROPIC_API_KEY=<your Anthropic key>
AI_OPENAI_API_KEY=
PLATFORM_BOOTSTRAP_EMAIL=<your email>
PLATFORM_BOOTSTRAP_NAME=Emon Hridoy
```

Then paste **every line of `sellora-secrets.txt`** below it, and save.

Notes on this block:

- `AI_OPENAI_API_KEY` is optional. It turns customers' voice notes into text. Leave it empty
  and voice notes stay playable but are not read by the AI.
- `${{web.RAILWAY_PUBLIC_DOMAIN}}` fills in once the web service has a domain (step 4d).
  `${{Redis.REDIS_URL}}` is the Redis service's private address.
- `STOREFRONT_BASE_DOMAIN` is where shops live: a shop with the address `nakshi-ghor` opens at
  `https://nakshi-ghor.shops.yourdomain.com`. Use your own domain (step 4e). If you skip the
  online stores for now, leave the line as it is.

### 4c. The `worker` service

The worker runs the background jobs: sending messages to Meta, AI replies, voice notes,
couriers, SMS, backups and reports. It uses the same image as the API with another command.

1. **+ New › GitHub Repo › sellora-ai**.
2. In **Settings**, set these:
   - **Name**: `worker`.
   - **Root Directory**: `/sellora-api`.
   - **Region**: Singapore.
   - **Deploy › Custom Start Command**: `node dist/worker.js`.
   - **Healthcheck**: none.
   - **Domain**: none.
3. **Variables › Raw Editor**: paste the same block as the API's, with the secrets, but
   **without** the two `PLATFORM_BOOTSTRAP_…` lines.

Keep the API's and the worker's variables the same whenever you change one.

### 4d. The `web` service

1. **+ New › GitHub Repo › sellora-ai**.
2. In **Settings**, set these:
   - **Name**: `web`.
   - **Root Directory**: `/sellora-web`.
   - **Region**: Singapore.
   - **Healthcheck Path**: `/`.
   - **Watch Paths** (optional): `/sellora-web/**`.
3. **Settings › Networking › Generate Domain**, with port `3000`. This creates the address
   people will use, `https://web-production-xxxx.up.railway.app`. A custom domain such as
   `app.yourdomain.com` can be added later in the same place. After changing the domain,
   redeploy the api, worker and web services.
4. **Variables › Raw Editor**:

```
PORT=3000
API_INTERNAL_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}
NEXT_PUBLIC_SITE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

The web app's Dockerfile reads `API_INTERNAL_URL` while it builds, because Next.js fixes the
`/v1` and `/socket.io` forwarding at build time. If you change it, redeploy the web service so
it is rebuilt.

### 4e. The `storefront` service (online stores and landing pages)

Skip this step if you are not testing online stores yet.

You need a domain you own, such as `yourdomain.com`. Every shop gets an address under
`shops.yourdomain.com`, so Railway needs one wildcard domain, `*.shops.yourdomain.com`.

1. **+ New › GitHub Repo › sellora-ai**.
2. In **Settings**, set these:
   - **Name**: `storefront`.
   - **Root Directory**: `/sellora-storefront`.
   - **Region**: Singapore.
   - **Healthcheck Path**: `/api/health`.
   - **Watch Paths** (optional): `/sellora-storefront/**`.
3. **Variables › Raw Editor**:

```
PORT=3100
API_INTERNAL_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}
STOREFRONT_API_KEY=${{api.STOREFRONT_API_KEY}}
TRUST_PROXY_HOPS=1
```

4. **Settings › Networking › + Custom Domain**: enter `*.shops.yourdomain.com` with port
   `3100`. Railway then shows two `CNAME` records and one `TXT` record. Add all three at your
   domain's DNS provider exactly as shown. If your DNS is on Cloudflare, set the
   `_acme-challenge` record to **DNS only** (grey cloud), or Railway cannot issue the
   certificate. Wait until Railway shows the domain as verified (minutes, sometimes hours).
5. Check that `STOREFRONT_BASE_DOMAIN=shops.yourdomain.com` is set on **api and worker**, and
   redeploy them.

Then try it: in the dashboard, open **Online store**, create a store, choose a theme and
**Send for review**. In the super-admin panel, approve it under **Online stores**. Open
`https://<store address>.shops.yourdomain.com`, place a cash-on-delivery order and find it in
**Orders**.

**Businesses' own domains** (such as `www.theirshop.com`) are off in this setup: leave
`STOREFRONT_DOMAIN_TARGET` unset. On Railway each such domain would also have to be added to
the storefront service by hand, and the Hobby plan allows 2 custom domains per service, one of
which is the wildcard. Shops use their `shops.yourdomain.com` address until this is automated.

### 4f. Deploy and check

Deploy all the services (**Deploy** on each, or push to GitHub). Then check:

1. **api › Deployments › logs** shows `Sellora API listening on 0.0.0.0:4000`, then a line
   `Platform owner … created. Open this link within 24 hours …`. Open that link and set your
   super-admin password and two-factor code. Then **delete `PLATFORM_BOOTSTRAP_EMAIL` and
   `PLATFORM_BOOTSTRAP_NAME`** from the api's variables. The link is in the logs, so treat the
   logs as private.
2. **worker** logs show `Sellora worker started`.
3. Open `https://<web domain>/v1/health/ready`. It should answer `{"status":"ok",…}` with
   MongoDB and Redis up.
4. Open `https://<web domain>`, sign up a business and confirm the verification email
   arrives and its link works. This proves SMTP works.
5. Signed in, open **Account**. **Where you are signed in** should show your own public IP
   address.
   If it shows an internal address (`10.…`, `fd…`) instead, set `TRUST_PROXY_HOPS=2` on api
   and worker. Per-address sign-in limits depend on this.

## 5. Finish R2: CORS for uploads

Browsers upload product photos straight to R2, so the bucket must accept them from the web
address. In R2, open the bucket, then **Settings › CORS Policy › Add › JSON** and paste this,
using your web address:

```json
[
  {
    "AllowedOrigins": ["https://web-production-xxxx.up.railway.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Check it by adding a product photo in **Products**.

## 6. Super-admin: plans, AI prices and the two businesses

Sign in at `https://<web domain>/admin`. On first start, the API adds starter plans, AI models
and the credit price list. Then:

- **AI credits & models**: check each model's provider price against Anthropic's current
  price list, and OpenAI's for the speech model. Those prices only affect your profit
  reports.
- **Businesses**: after you and your friend sign up, give each business the plan you want them
  to test, for example All-in-one, and add AI credits.

## 6b. Payments at checkout (each business's own gateway)

Nothing to set on the servers: each business enters its own merchant keys in **Settings ›
Payments**, and the keys are stored encrypted with the `DATA_ENCRYPTION_KEYS`. Gateways send
shoppers back to `https://<web domain>/v1/shop-payments/...` (`API_PUBLIC_URL`), which the web
service passes to the API. Keep the worker running: it asks the gateways about payments whose
shoppers never came back. Never set the `PAYMENT_*_URL` lines here; their defaults are the
gateways' real addresses, and the payment stand-in is for your computer only.

Before a business takes real money, connect its gateway with **Test mode** on and the
gateway's sandbox keys, make one payment and one cancel from its store, and check that the
order shows them. Sellora's gateway code was written from the gateways' published API
documents and tested only against a stand-in, so this first sandbox payment is the real test.
Then save the live keys with **Test mode** off.

## 6c. Ad tracking (each business's own pixels and tags)

Nothing to set on the servers either: each business adds its own Meta Pixel, TikTok Pixel,
Google Analytics 4 and Google Ads ids, and the optional server keys, in **Settings › Ad
tracking**; the keys are stored encrypted with the `DATA_ENCRYPTION_KEYS`. Server events go
out from the worker, so keep it running. Never set the `TRACKING_*_BASE_URL` lines here: their
defaults are the platforms' real addresses, and the tracking stand-in is for your computer
only.

Before a business relies on it, press **Send test event** on each id and check that it shows
in Meta's or TikTok's **Events Manager › Test events** or Google Analytics' **DebugView**, then
place one test order and look for the purchase. Sellora's tracking was written from the
platforms' public documents and tested only against a stand-in, so this first test is the real
one. If a business sells to shoppers in Europe or the UK, choose **Ask first**.

## 7. Meta: Messenger, Instagram and WhatsApp

This needs a Meta app at [developers.facebook.com](https://developers.facebook.com). Meta's
screens and review rules change often, so follow their current docs for each click.

1. Create an app of the **Business** type. Add **Messenger**, **Instagram** and **WhatsApp**,
   and **Facebook Login for Business**.
2. **Webhooks**: set the callback URL to `https://<web domain>/v1/webhooks/meta`. The verify
   token is the `META_WEBHOOK_VERIFY_TOKEN` line from `sellora-secrets.txt`.
3. **Facebook Login › Valid OAuth Redirect URIs**: add `https://<web domain>/app/connect/meta`.
4. On **api and worker**, add `META_APP_ID` and `META_APP_SECRET` from the app's **Settings ›
   Basic**. Optionally add `META_LOGIN_CONFIG_ID`, from a Facebook Login for Business
   configuration. Redeploy.
5. In Sellora, go to **Settings › Channels** and connect the Facebook page and Instagram
   account. For WhatsApp, choose **"I have a system user token instead"** and enter the number's
   ID, the WhatsApp Business Account ID and a permanent system user token. One-click WhatsApp
   signup needs Meta's Tech Provider approval, which is a later step.

Expect this: while the app is in **development mode**, Meta delivers messages only from people
who have a role on the app (admins, developers, testers). So test first by messaging your own
page from such accounts. Real customers' messages need the app switched to **Live**, with
advanced access to the messaging permissions. That means Meta's App Review and business
verification, which can take days. Start it early.

## 8. Updating

Push to `main` on GitHub and Railway rebuilds the services whose folder changed (with watch
paths set). On start, the API adds missing database indexes and starter billing rows by itself.
There is no separate migration step.

---

## Troubleshooting

- **The API fails at start with a list of variables**: the message names each missing or
  wrong one. Production refuses `MAIL_TRANSPORT=log` and needs `COOKIE_SECURE=true`,
  `STOREFRONT_URL_SCHEME=https`, `WEBCHAT_TOKEN_SECRET` and `BACKUP_ENCRYPTION_KEYS`.
- **The web app shows "Internal Server Error" for `/v1/…`**: the web app cannot reach the API.
  Check `API_INTERNAL_URL`, then redeploy **web** so it is rebuilt with the new value.
  Railway projects made before mid-October 2025 have an IPv6-only private network. In those,
  set `HOST=::` on the api.
- **Redis errors like `ENOTFOUND redis.railway.internal`**: add `?family=0` to the end of
  `REDIS_URL` on api and worker.
- **Uploads fail in the browser with a CORS error**: check step 5. The origin must match the
  web address exactly, with `https://` and no trailing slash.
- **A shop address shows Railway's "Application not found" page**: the wildcard domain is not
  verified yet. Check the three DNS records from step 4e.
- **A shop shows "opening soon"**: it has not been approved in the super-admin panel yet. **"No
  store at this address"** means the address before `.shops.` does not match a store, or
  `STOREFRONT_BASE_DOMAIN` on the api differs from the domain you added.
- **Every shop page fails with an error**: check the storefront's logs. `STOREFRONT_API_KEY`
  must equal the api's, which the `${{api.STOREFRONT_API_KEY}}` reference does for you.
- **Live chat updates stop**: open the browser's network tab. `/socket.io` should upgrade to a
  WebSocket. If you put the web app behind another proxy or CDN, it must pass WebSockets.
  Hosting the web app on Vercel is not covered here: its rewrites to another host are not
  known to carry WebSockets, and this setup has not been tried there.

## Render instead of Railway

`render.yaml` (repository root) creates the same pieces in Singapore, with the online stores
as `sellora-storefront`. In the Render
dashboard, choose **New › Blueprint** and pick this repository. Render asks once for each secret
and the worker copies them from the API. Set `WEB_APP_URL`, `API_PUBLIC_URL` and
`CORS_ORIGINS` to the web service's `https://…onrender.com` address, and `NEXT_PUBLIC_SITE_URL`
to the same address. For the online stores, set `STOREFRONT_BASE_DOMAIN` on the API, then add
`*.shops.yourdomain.com` as a custom domain on `sellora-storefront`. Render asks for three
`CNAME` records, and the base name (`shops.yourdomain.com`) must point to Render too. The plans
are Render's paid defaults: free web services sleep when idle,
which loses Meta's webhooks. Expect it to cost more than Railway for the same test. This
Blueprint has not been applied to a Render account yet.
