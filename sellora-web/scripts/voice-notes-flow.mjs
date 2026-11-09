/* eslint-disable no-console -- a command-line report */
/**
 * Checks customers' voice notes in a real browser, against a running web app, API and worker
 * whose Meta, Claude and speech-to-text settings point at the stand-ins in sellora-api/scripts
 * (graph-stand-in.mjs, claude-stand-in.mjs, speech-stand-in.mjs). It is NOT a test against
 * Meta, Claude or a real speech-to-text service: the recordings are the stand-in's demo clips
 * (tones, no speech), the speech stand-in answers a scripted sentence without listening, and
 * the stand-in AI only reports what it got.
 *
 * What it checks: the AI agent settings show the voice notes switch and price; a WhatsApp
 * voice note is saved, plays in the thread with its length and shows what speech-to-text
 * heard, and the AI agent answers those words; recordings load only with a staff session; a
 * Messenger voice clip shows as "Voice note" in the chat list; a recording the service cannot
 * read shows why, and "Try again" turns it into text; with the switch off a voice note stays
 * audio only; phone and dark views. Needs the demo page and WhatsApp number connected
 * (scripts/meta-flow.mjs leaves them connected). Fails on console errors, unexpected API
 * errors or a missing result.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… META_APP_SECRET=… node scripts/voice-notes-flow.mjs
 *
 * Optional: SMOKE_BASE_URL (http://localhost:3000), META_WEBHOOK_URL
 * (http://127.0.0.1:4000/v1/webhooks/meta), GRAPH_STAND_IN_URL (http://127.0.0.1:4020),
 * CLAUDE_STAND_IN_URL (http://127.0.0.1:4010), SPEECH_STAND_IN_URL (http://127.0.0.1:4100).
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
const SPEECH = (env.SPEECH_STAND_IN_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/voice-notes';
mkdirSync(OUT, { recursive: true });

// The stand-in's demo accounts.
const PAGE = { id: '100000000000001' };
const WA = { phoneNumberId: '200000000000001', wabaId: '300000000000001' };

// Customers are named after the last 4 digits of their id: distinct per customer and per run.
const run = String(Date.now()).slice(-6);
const tails = new Set();
const uniqueTail = () => {
  for (;;) {
    const t = String(1000 + Math.floor(Math.random() * 9000));
    if (!tails.has(t)) return tails.add(t) && t;
  }
};
const WA_FROM = `8802${run}${uniqueTail()}`;
const WA_UNREADABLE = `8803${run}${uniqueTail()}`;
const WA_OFF = `8804${run}${uniqueTail()}`;
const PSID = `7303${run}${uniqueTail()}`;
const tail = (id) => id.slice(-4);
const HEARD = 'Ami ei lal jamdani saree ta nite chai. Dhaka te delivery charge koto?';
const SWITCH = /^Turn voice notes into text/;

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

const whatsappVoice = (from, name) => ({
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
            contacts: [{ profile: { name: `${name} ${tail(from)}` }, wa_id: from }],
            messages: [
              {
                from,
                id: `wamid.VOICE${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'audio',
                audio: {
                  id: `wa-voice-${from}`,
                  mime_type: 'audio/ogg; codecs=opus',
                  voice: true,
                },
              },
            ],
          },
        },
      ],
    },
  ],
});

const messengerVoice = (from) => ({
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
            mid: `m_voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            attachments: [{ type: 'audio', payload: { url: `${GRAPH}/__audio/voice-clip.mp4` } }],
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

const json = async (url, init) => (await fetch(url, init)).json();
const graphSent = async () => (await json(`${GRAPH}/__sent`)).sent;
const aiRequests = async () => (await json(`${CLAUDE}/__requests`)).requests;
const speechRequests = async () => (await json(`${SPEECH}/__requests`)).requests;
const speech = (path, body) =>
  json(`${SPEECH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const browser = await chromium.launch();
let failed = false;
let staff;

try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  staff = await ctx.newPage();
  watch(staff, 'staff');
  let org;

  /** Sets the voice notes switch on the AI agent page and saves when it changed. */
  const setVoiceSwitch = async (on) => {
    await staff.goto(`${BASE}${org}/ai-agent`);
    const toggle = staff.getByRole('switch', { name: SWITCH });
    await toggle.waitFor();
    if ((await toggle.getAttribute('aria-checked')) === String(on)) return;
    await toggle.click();
    await staff.getByRole('button', { name: 'Save', exact: true }).click();
    await staff.getByText(/^Saved\. The agent uses the new settings/).waitFor();
  };

  await step('sign in', async () => {
    await speech('/__reset');
    await staff.goto(`${BASE}/login`);
    await staff.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
    await staff.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
    await staff.click('button[type=submit]');
    await staff.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
    org = new URL(staff.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
  });

  await step('the AI agent settings show the voice notes switch and its price', async () => {
    await setVoiceSwitch(true);
    const card = staff
      .locator('div')
      .filter({ has: staff.getByText('Voice notes', { exact: true }) });
    await staff.getByText(/^Costs 15 credits per minute of recording/).waitFor();
    const toggle = staff.getByRole('switch', { name: SWITCH });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') throw new Error('switch is off');
    await toggle.scrollIntoViewIfNeeded();
    await card.last().waitFor();
    await shot(staff, '01-voice-notes-setting');
    const ai = staff.getByRole('switch', { name: 'AI sales agent on' });
    if ((await ai.getAttribute('aria-checked')) !== 'true') {
      await ai.click();
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
  /** Waits for the newest voice note in the open thread to be playable; returns it. */
  const playable = async () => {
    const audio = thread.locator('audio').last();
    await audio.waitFor({ timeout: 20_000 });
    return waitFor(
      () =>
        audio.evaluate((el) =>
          el.readyState >= 1 && Number.isFinite(el.duration)
            ? { src: el.getAttribute('src'), duration: el.duration }
            : null,
        ),
      'the voice note to load in the player',
      15_000,
    );
  };

  let voiceUrl;
  await step('a WhatsApp voice note is saved, plays and shows what was heard', async () => {
    await staff.goto(`${BASE}${org}/inbox`);
    await staff.getByRole('status').filter({ hasText: 'Live' }).waitFor({ timeout: 10_000 });
    await deliver(whatsappVoice(WA_FROM, 'Shila Rahman'));
    await open(`Shila Rahman ${tail(WA_FROM)}`);
    const audio = await playable();
    voiceUrl = audio.src;
    if (
      !/^\/v1\/orgs\/[a-f0-9]{24}\/conversations\/[a-f0-9]{24}\/messages\/[a-f0-9]{24}\/attachments\/0$/.test(
        voiceUrl ?? '',
      )
    )
      throw new Error(`unexpected recording link ${voiceUrl}`);
    if (Math.abs(audio.duration - 4.2) > 0.3)
      throw new Error(`the player reads ${audio.duration}s, expected about 4.2s`);
    await thread.getByText('Voice note · 0:04').waitFor();
    await thread.getByText(`“${HEARD}”`).waitFor({ timeout: 20_000 });
    await thread.getByText(/^Voice-to-text · 1\.05 credits/).waitFor();
    const [req] = await speechRequests();
    if (!req || req.fileType !== 'audio/ogg' || !req.bytes)
      throw new Error('speech-to-text got no Ogg recording');
  });

  await step('the AI agent answers the spoken words (stand-in AI)', async () => {
    const req = await waitFor(
      async () => (await aiRequests()).find((r) => r.customer.includes(HEARD)),
      'an AI request with the words',
    );
    if (!req.customer.includes('voice note (0:04)'))
      throw new Error('the AI was not told it was a voice note');
    const sent = await waitFor(
      async () => (await graphSent()).find((m) => m.to === WA_FROM),
      'the AI reply on WhatsApp',
    );
    if (!sent.text.startsWith('Voice note shunechi!'))
      throw new Error(`unexpected reply: ${sent.text}`);
    await thread
      .getByText(/^Voice note shunechi!/)
      .first()
      .waitFor({ timeout: 15_000 });
    await shot(staff, '02-whatsapp-voice-note-and-ai-reply');
  });

  await step('recordings load only with a staff session', async () => {
    const inside = await staff.evaluate(async (u) => {
      const r = await fetch(u);
      await r.arrayBuffer();
      return { status: r.status, type: r.headers.get('content-type') };
    }, voiceUrl);
    if (inside.status !== 200 || inside.type !== 'audio/ogg')
      throw new Error(`signed in: ${inside.status} ${inside.type}`);
    const outside = await fetch(`${BASE}${voiceUrl}`);
    await outside.text();
    if (outside.status !== 401) throw new Error(`signed out: ${outside.status}, expected 401`);
  });

  await step('a Messenger voice clip shows as "Voice note" in the chat list', async () => {
    await speech('/__say', { text: 'Ei panjabi ta XL size e ache?' });
    await deliver(messengerVoice(PSID));
    const row = list.getByRole('button', { name: new RegExp(`Demo Customer ${tail(PSID)}`) });
    await row.first().waitFor({ timeout: 15_000 });
    await row.first().getByText('Voice note').first().waitFor({ timeout: 15_000 });
    await open(`Demo Customer ${tail(PSID)}`);
    await playable();
    await thread.getByText('“Ei panjabi ta XL size e ache?”').waitFor({ timeout: 20_000 });
    await shot(staff, '03-messenger-voice-clip');
  });

  await step('a recording the service cannot read shows why, and Try again fixes it', async () => {
    await speech('/__fail', { status: 400 });
    await deliver(whatsappVoice(WA_UNREADABLE, 'Mitu Das'));
    await open(`Mitu Das ${tail(WA_UNREADABLE)}`);
    await playable();
    await thread
      .getByText('The voice-to-text service could not read this recording.')
      .waitFor({ timeout: 20_000 });
    // The agent answers without the words and asks the customer to type.
    await thread
      .getByText(/voice note ta shunte parini/)
      .first()
      .waitFor({ timeout: 40_000 });
    await shot(staff, '04-voice-note-not-read');
    await speech('/__say', { text: 'Amar order ta kobe pabo?' });
    await thread.getByRole('button', { name: 'Try again' }).click();
    await thread.getByText('“Amar order ta kobe pabo?”').waitFor({ timeout: 20_000 });
    await shot(staff, '05-voice-note-try-again');
  });

  await step('with the switch off, a voice note stays audio only', async () => {
    await setVoiceSwitch(false);
    const before = (await speechRequests()).length;
    await staff.goto(`${BASE}${org}/inbox`);
    await staff.getByRole('status').filter({ hasText: 'Live' }).waitFor({ timeout: 10_000 });
    await deliver(whatsappVoice(WA_OFF, 'Nadia Islam'));
    await open(`Nadia Islam ${tail(WA_OFF)}`);
    await playable();
    await thread
      .getByText('Turning voice notes into text is off in the AI agent settings.')
      .waitFor({ timeout: 20_000 });
    if ((await speechRequests()).length !== before)
      throw new Error('speech-to-text was called with the switch off');
    await shot(staff, '06-voice-notes-switched-off');
  });

  await step('the switch goes back on, and the AI agent off', async () => {
    await setVoiceSwitch(true);
    await staff.getByRole('switch', { name: 'AI sales agent on' }).click();
    await staff.getByText('The AI sales agent is off.').waitFor();
  });

  await step('a voice note in the thread on a phone, and in dark mode', async () => {
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      storageState: await ctx.storageState(),
    });
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/inbox`);
    await phone
      .getByRole('list', { name: 'Conversations' })
      .getByRole('button', { name: new RegExp(`Shila Rahman ${tail(WA_FROM)}`) })
      .first()
      .click();
    await phone.getByText(`“${HEARD}”`).waitFor({ timeout: 15_000 });
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (overflow) throw new Error('the phone view scrolls sideways');
    await shot(phone, '07-voice-note-phone');
    await phone.close();
    await staff.emulateMedia({ colorScheme: 'dark' });
    await staff.goto(`${BASE}${org}/inbox`);
    await open(`Shila Rahman ${tail(WA_FROM)}`);
    await playable();
    await thread.getByText(`“${HEARD}”`).waitFor();
    await shot(staff, '08-voice-note-dark');
    await staff.emulateMedia({ colorScheme: 'light' });
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
