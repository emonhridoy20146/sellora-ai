/* eslint-disable no-console -- a command-line report */
/**
 * Checks customers' photos in a real browser, against a running web app, API and worker
 * whose Meta and Claude settings point at the stand-ins (sellora-api/scripts/graph-stand-in.mjs
 * and claude-stand-in.mjs). It is NOT a test against Meta or Claude: the photos come from the
 * Graph stand-in's demo images, and the stand-in AI cannot see; it only reports what it got.
 *
 * What it checks: a Messenger photo and a WhatsApp photo are copied into Sellora and appear
 * in the open thread; the full-size view; the AI agent's request carries the photo; a photo
 * Meta no longer has shows the reason; saved photos load only with a staff session. Needs the
 * demo page and WhatsApp number connected (scripts/meta-flow.mjs leaves them connected).
 * Fails on console errors, unexpected API errors or a missing result.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… META_APP_SECRET=… node scripts/photos-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), META_WEBHOOK_URL
 * (http://127.0.0.1:4000/v1/webhooks/meta), GRAPH_STAND_IN_URL (http://127.0.0.1:4020),
 * CLAUDE_STAND_IN_URL (http://127.0.0.1:4010).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const WEBHOOK = env.META_WEBHOOK_URL ?? 'http://127.0.0.1:4000/v1/webhooks/meta';
const GRAPH = (env.GRAPH_STAND_IN_URL ?? 'http://127.0.0.1:4020').replace(/\/+$/, '');
const CLAUDE = (env.CLAUDE_STAND_IN_URL ?? 'http://127.0.0.1:4010').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/photos';
mkdirSync(OUT, { recursive: true });

// The stand-in's demo accounts.
const PAGE = { id: '100000000000001' };
const WA = { phoneNumberId: '200000000000001', wabaId: '300000000000001' };

// Customers are named after the last 4 digits of their id: distinct per customer and per run,
// so an older chat with the same name is not opened by mistake.
const run = String(Date.now()).slice(-6);
const tails = new Set();
const uniqueTail = () => {
  for (;;) {
    const t = String(1000 + Math.floor(Math.random() * 9000));
    if (!tails.has(t)) return tails.add(t) && t;
  }
};
const PSID = `7301${run}${uniqueTail()}`;
const PSID_OLD = `7302${run}${uniqueTail()}`;
const WA_FROM = `8801${run}${uniqueTail()}`;
const tail = (id) => id.slice(-4);
const PHOTO_ALT = 'Photo from the customer';

const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}
const SECRET = need('META_APP_SECRET');

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label} console: ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 500 || (s >= 400 && s !== 401 && r.url().includes('/v1/')))
      problems.push(`${label} ${s} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    steps.push({ name, ok: true, ms: Date.now() - started });
  } catch (err) {
    steps.push({ name, ok: false, error: String(err).split('\n')[0].slice(0, 300) });
    throw err;
  }
}

async function shot(page, name, fullPage = false) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
}

async function deliver(body) {
  const raw = JSON.stringify(body);
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
}

const messengerPhoto = (from, photos, text) => ({
  object: 'page',
  entry: [
    {
      id: PAGE.id,
      time: Date.now(),
      messaging: [
        {
          sender: { id: from },
          recipient: { id: PAGE.id },
          timestamp: Date.now(),
          message: {
            mid: `m_photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ...(text ? { text } : {}),
            attachments: photos.map((name) => ({
              type: 'image',
              payload: { url: `${GRAPH}/__photo/${name}.jpg` },
            })),
          },
        },
      ],
    },
  ],
});

const whatsappPhoto = (from, mediaName, caption) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WA.wabaId,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '8801711000000', phone_number_id: WA.phoneNumberId },
            contacts: [{ profile: { name: `Rina Akter ${tail(from)}` }, wa_id: from }],
            messages: [
              {
                from,
                id: `wamid.PHOTO${Date.now()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'image',
                image: { id: `wa-media-${mediaName}`, mime_type: 'image/jpeg', caption },
              },
            ],
          },
        },
      ],
    },
  ],
});

async function waitFor(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await fn();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const graphSent = async () => (await (await fetch(`${GRAPH}/__sent`)).json()).sent;
const aiRequests = async () => (await (await fetch(`${CLAUDE}/__requests`)).json()).requests;

const browser = await chromium.launch();
let failed = false;
let staff;

try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  staff = await ctx.newPage();
  watch(staff, 'staff');
  let org;

  await step('sign in', async () => {
    await staff.goto(`${BASE}/login`);
    await staff.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await staff.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await staff.click('button[type=submit]');
    await staff.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(staff.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
  });

  await step('turn the AI sales agent on', async () => {
    await staff.goto(`${BASE}${org}/ai-agent`);
    const toggle = staff.getByRole('switch', { name: 'AI sales agent on' });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click();
      await staff.getByText('The AI sales agent is on.').waitFor();
    }
  });

  const list = staff.getByRole('list', { name: 'Conversations' });
  const thread = staff.getByRole('list', { name: 'Messages' });
  const open = async (name) => {
    await list.getByText(name).first().waitFor({ timeout: 15_000 });
    await list
      .getByRole('button', { name: new RegExp(name) })
      .first()
      .click();
    await staff.getByRole('heading', { name }).first().waitFor();
  };
  /** Waits for a photo in the open thread to be shown, and returns its link. */
  const loadedPhoto = async (nth = -1) => {
    const img = thread.getByRole('img', { name: PHOTO_ALT }).nth(nth);
    await img.waitFor({ timeout: 20_000 });
    await waitFor(
      () => img.evaluate((el) => el.complete && el.naturalWidth > 0),
      'the photo to load',
      10_000,
    );
    return img.getAttribute('src');
  };

  let photoUrl;
  await step('a Messenger photo is saved and shows in the open thread', async () => {
    await staff.goto(`${BASE}${org}/inbox`);
    await staff.getByRole('status').filter({ hasText: 'Live' }).waitFor({ timeout: 10_000 });
    await deliver(messengerPhoto(PSID, ['red-saree'], 'ei saree ta ache?'));
    await open(`Demo Customer ${tail(PSID)}`);
    await thread.getByText('ei saree ta ache?').waitFor();
    photoUrl = await loadedPhoto();
    if (
      !/^\/v1\/orgs\/[a-f0-9]{24}\/conversations\/[a-f0-9]{24}\/messages\/[a-f0-9]{24}\/attachments\/0$/.test(
        photoUrl ?? '',
      )
    )
      throw new Error(`unexpected photo link ${photoUrl}`);
  });

  await step('the AI agent’s request carries the photo (stand-in AI)', async () => {
    const req = await waitFor(
      async () =>
        (await aiRequests()).find(
          (r) => r.customer.includes('ei saree ta ache?') && r.images.length,
        ),
      'an AI request with the photo',
    );
    if (req.images[0].mediaType !== 'image/jpeg') throw new Error('the photo was not a JPEG');
    const sent = await waitFor(
      async () => (await graphSent()).find((m) => m.to === PSID),
      'the AI reply on Messenger',
    );
    if (!sent.text.includes('received 1 photo')) throw new Error(`unexpected reply: ${sent.text}`);
    await thread
      .getByText(/Photo peyechi/)
      .first()
      .waitFor({ timeout: 15_000 });
    await shot(staff, '01-messenger-photo-and-ai-reply');
  });

  await step('the photo opens full size', async () => {
    await thread.getByRole('button', { name: 'Open photo' }).last().click();
    const dialog = staff.getByRole('dialog', { name: PHOTO_ALT });
    await dialog.getByRole('img', { name: PHOTO_ALT }).waitFor();
    await dialog.getByRole('link', { name: 'Open full size' }).waitFor();
    await shot(staff, '02-photo-full-size');
    await staff.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  });

  await step('saved photos load only with a staff session', async () => {
    const inside = await staff.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, type: r.headers.get('content-type') };
    }, photoUrl);
    if (inside.status !== 200 || inside.type !== 'image/jpeg')
      throw new Error(`signed in: ${inside.status} ${inside.type}`);
    const outside = await fetch(`${BASE}${photoUrl}`);
    if (outside.status !== 401) throw new Error(`signed out: ${outside.status}, expected 401`);
  });

  await step('a WhatsApp photo is fetched with the channel’s token and shows', async () => {
    await deliver(whatsappPhoto(WA_FROM, 'blue-panjabi', 'ei panjabi XL e ache?'));
    await open(`Rina Akter ${tail(WA_FROM)}`);
    await thread.getByText('ei panjabi XL e ache?').waitFor();
    await loadedPhoto();
    await waitFor(
      async () => (await graphSent()).find((m) => m.to === WA_FROM),
      'the AI reply on WhatsApp',
    );
    await thread
      .getByText(/Photo peyechi/)
      .first()
      .waitFor({ timeout: 15_000 });
    await shot(staff, '03-whatsapp-photo');
  });

  await step('a photo Meta no longer has shows why it is missing', async () => {
    await deliver(messengerPhoto(PSID_OLD, ['expired'], 'ager photo ta'));
    await open(`Demo Customer ${tail(PSID_OLD)}`);
    await thread
      .getByText('Not saved: Meta no longer has this photo.')
      .waitFor({ timeout: 20_000 });
    await shot(staff, '04-photo-not-saved');
  });

  await step('a photo in the thread on a phone, and in dark mode', async () => {
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      storageState: await ctx.storageState(),
    });
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/inbox`);
    await phone
      .getByRole('list', { name: 'Conversations' })
      .getByRole('button', { name: new RegExp(`Demo Customer ${tail(PSID)}`) })
      .first()
      .click();
    await phone.getByRole('img', { name: PHOTO_ALT }).first().waitFor({ timeout: 15_000 });
    await shot(phone, '05-photo-phone');
    await phone.close();
    await staff.emulateMedia({ colorScheme: 'dark' });
    await open(`Demo Customer ${tail(PSID)}`);
    await loadedPhoto();
    await shot(staff, '06-photo-dark');
    await staff.emulateMedia({ colorScheme: 'light' });
  });

  await step('turn the AI sales agent off again', async () => {
    await staff.goto(`${BASE}${org}/ai-agent`);
    await staff.getByRole('switch', { name: 'AI sales agent on' }).click();
    await staff.getByText('The AI sales agent is off.').waitFor();
  });
} catch {
  failed = true;
  await staff?.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

for (const s of steps)
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? ` (${s.ms} ms)` : `: ${s.error}`}`);
if (problems.length) {
  console.log('\nProblems seen:');
  for (const p of problems) console.log(`  - ${p}`);
}
const passed = steps.filter((s) => s.ok).length;
console.log(
  `\n${passed}/${steps.length} steps passed${problems.length ? `, ${problems.length} problems` : ''}`,
);
process.exit(failed || problems.length ? 1 : 0);
