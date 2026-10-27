/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through the inbox in real browsers against a running web app and API: adds the
 * website chat in Settings › Channels, embeds it on a separate "merchant" site (another
 * origin, like a real shop), chats as a visitor, and answers from the inbox, checking that
 * both sides update live without reloading. Also checks the dot command, closing, the
 * allowed-sites setting (the browser must refuse to show the chat on other sites), and the
 * phone layout. Fails on console errors, unexpected API errors or a missing result.
 * Creates real data in the signed-in business (names carry a timestamp).
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/inbox-flow.mjs
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/inbox';
mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36).slice(-5);
const visitorName = `Nusrat ${stamp}`;
const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

function watch(page, label, allow = []) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (allow.some((re) => re.test(text))) return;
    problems.push(`${label} console: ${text.slice(0, 200)}`);
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

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
  await page.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
  await page.click('button[type=submit]');
  await page.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
  return new URL(page.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
}

/** A stand-in for the merchant's own website, on a different origin than Sellora. */
function merchantSite(snippet) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Dhaka Fashion</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui;margin:0;padding:40px;background:#fafaf7">
<h1>Dhaka Fashion</h1><p>Kurtis, sarees and panjabis. Chat with us below.</p>
${snippet}</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const browser = await chromium.launch();
let failed = false;
let site;
try {
  const staffCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const staff = await staffCtx.newPage();
  watch(staff, 'staff');
  const org = await login(staff);
  let snippet = '';
  let channelName = `Website ${stamp}`;

  await step('add the website chat in Settings › Channels', async () => {
    await staff.goto(`${BASE}${org}/settings/channels`);
    await staff.getByRole('button', { name: 'Add website chat' }).first().click();
    await staff.fill('#wc-name', channelName);
    await staff.fill('#wc-greeting', 'Assalamu alaikum! How can we help?');
    await staff.fill('#wc-color', '#0f766e');
    await staff.getByRole('button', { name: 'Add website chat' }).last().click();
    await staff.getByText('Website chat added').waitFor();
    const card = staff
      .locator('div', { hasText: channelName })
      .filter({ has: staff.locator('pre') })
      .last();
    snippet = (await card.locator('pre').innerText()).trim();
    if (
      !/^<script src="http:\/\/localhost:3000\/widget\.js" data-key="wc_[A-Za-z0-9_-]{24}" async><\/script>$/.test(
        snippet,
      )
    )
      throw new Error(`unexpected embed code: ${snippet}`);
    await shot(staff, '01-channels', true);
  });

  site = await merchantSite(snippet);
  const siteUrl = `http://127.0.0.1:${site.address().port}/`;

  await step('open the inbox before the customer writes', async () => {
    await staff.goto(`${BASE}${org}/inbox`);
    await staff.getByRole('status').filter({ hasText: 'Live' }).waitFor({ timeout: 10_000 });
  });

  const visitorCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const visitor = await visitorCtx.newPage();
  watch(visitor, 'visitor');
  let chat;

  await step('the chat bubble appears on the merchant’s own site', async () => {
    await visitor.goto(siteUrl);
    const frameEl = visitor.locator('iframe[title="Chat"]');
    await frameEl.waitFor({ state: 'visible', timeout: 10_000 });
    chat = visitor.frameLocator('iframe[title="Chat"]');
    await chat.getByRole('button', { name: /Chat with/ }).click();
    await chat.getByText('Assalamu alaikum! How can we help?').waitFor();
    const box = await frameEl.boundingBox();
    if (!box || box.width < 300 || box.height < 400)
      throw new Error('chat did not open to full size');
  });

  await step('the visitor gives name and phone, then writes', async () => {
    await chat.locator('#wv-name').fill(visitorName);
    await chat.locator('#wv-phone').fill('01712345678');
    await chat.getByRole('button', { name: 'Start chat' }).click();
    await chat.locator('#wv-text').fill('Do you have the red kurti in size M?');
    await chat.locator('#wv-text').press('Enter');
    await chat.getByText('Do you have the red kurti in size M?').waitFor();
    await shot(visitor, '02-widget-on-merchant-site');
  });

  await step('the conversation appears in the inbox live, with one unread', async () => {
    const row = staff.getByRole('button', { name: new RegExp(visitorName) });
    await row.waitFor({ timeout: 10_000 });
    const text = await row.innerText();
    if (!text.includes('Do you have the red kurti')) throw new Error(`row shows: ${text}`);
    if (!/Unread:\s*1/.test(text)) throw new Error(`no unread badge: ${text}`);
    await row.click();
    await staff
      .getByRole('list', { name: 'Messages' })
      .getByText('Do you have the red kurti in size M?')
      .waitFor();
    await staff.getByText('+8801712345678').first().waitFor();
  });

  await step('the visitor typing shows in the inbox', async () => {
    // Typing signals are sent at most every 2 s; the last one went with the first message.
    await visitor.waitForTimeout(2_200);
    await chat.locator('#wv-text').pressSequentially('Also', { delay: 30 });
    await staff.getByText('typing…').first().waitFor({ timeout: 5_000 });
    await chat.locator('#wv-text').fill('');
  });

  await step('a reply reaches the visitor live, and pauses the AI', async () => {
    await staff.fill('#composer', 'Yes! Red kurti in M is 1,200 taka.');
    await staff.press('#composer', 'Enter');
    await chat.getByText('Yes! Red kurti in M is 1,200 taka.').waitFor({ timeout: 10_000 });
    await staff.getByText('replied, so the AI paused.').waitFor({ timeout: 10_000 });
    const ai = staff.getByRole('switch', { name: 'AI replies in this conversation' });
    if ((await ai.getAttribute('aria-checked')) !== 'false') throw new Error('AI switch still on');
    await shot(staff, '03-inbox-thread');
  });

  await step('an internal note stays inside the team', async () => {
    await staff.getByRole('radio', { name: 'Note' }).click();
    await staff.fill('#composer', 'Regular customer, offer free delivery');
    await staff.press('#composer', 'Enter');
    await staff.getByText('Regular customer, offer free delivery').waitFor();
    await staff.getByRole('radio', { name: 'Reply' }).click();
    await visitor.waitForTimeout(800);
    if ((await chat.getByText('Regular customer').count()) > 0)
      throw new Error('note leaked to visitor');
  });

  await step('sending “.” turns the AI back on without messaging the customer', async () => {
    await staff.fill('#composer', '.');
    await staff.press('#composer', 'Enter');
    await staff.getByText('AI is answering this conversation again').waitFor();
    const ai = staff.getByRole('switch', { name: 'AI replies in this conversation' });
    await staff.waitForFunction(
      (el) => el?.getAttribute('aria-checked') === 'true',
      await ai.elementHandle(),
    );
    if ((await chat.getByText(/^\.$/).count()) > 0) throw new Error('"." reached the visitor');
  });

  await step('the visitor’s chat survives a page reload', async () => {
    await visitor.reload();
    await visitor.locator('iframe[title="Chat"]').waitFor({ state: 'visible' });
    chat = visitor.frameLocator('iframe[title="Chat"]');
    await chat.getByRole('button', { name: /Chat with/ }).click();
    await chat.getByText('Yes! Red kurti in M is 1,200 taka.').waitFor();
  });

  await step('a reply while the chat is closed shows as unread on the bubble', async () => {
    await chat.getByRole('button', { name: 'Close chat' }).click();
    await staff.fill('#composer', 'We can deliver tomorrow.');
    await staff.press('#composer', 'Enter');
    await chat.getByRole('button', { name: /\(1 new\)/ }).waitFor({ timeout: 10_000 });
    await shot(visitor, '04-widget-unread-bubble');
  });

  await step('closing moves the conversation out of Open', async () => {
    await staff
      .getByRole('region', { name: 'Conversation', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await staff.getByText('Conversation closed').waitFor();
    const list = staff.getByRole('list', { name: 'Conversations' });
    await list.getByText(visitorName).waitFor({ state: 'detached', timeout: 5_000 });
    await staff.getByRole('button', { name: 'Closed', exact: true }).click();
    await staff.getByRole('list', { name: 'Conversations' }).getByText(visitorName).waitFor();
    await staff.getByRole('button', { name: 'Open', exact: true }).click();
  });

  await step('a customer message reopens it, live', async () => {
    await chat.getByRole('button', { name: /Chat with/ }).click();
    await chat.locator('#wv-text').fill('Great, please book it');
    await chat.locator('#wv-text').press('Enter');
    await staff
      .getByRole('list', { name: 'Conversations' })
      .getByText(visitorName)
      .waitFor({ timeout: 10_000 });
  });

  await step('dark mode inbox', async () => {
    await staff.emulateMedia({ colorScheme: 'dark' });
    await staff.reload();
    await staff.getByRole('list', { name: 'Messages' }).waitFor();
    await shot(staff, '05-inbox-dark');
    await staff.emulateMedia({ colorScheme: 'light' });
  });

  await step('phone layout: list, then thread with a back button', async () => {
    const phoneCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      storageState: await staffCtx.storageState(),
      isMobile: true,
      hasTouch: true,
    });
    const phone = await phoneCtx.newPage();
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/inbox`);
    await phone.getByRole('button', { name: new RegExp(visitorName) }).click();
    await phone.getByRole('button', { name: 'Back to conversations' }).waitFor();
    await shot(phone, '06-inbox-phone-thread');
    await phone.getByRole('button', { name: 'Back to conversations' }).click();
    await phone.getByRole('list', { name: 'Conversations' }).waitFor();
    await phoneCtx.close();
  });

  await step('allowed sites: the browser refuses to show the chat elsewhere', async () => {
    await staff.goto(`${BASE}${org}/settings/channels`);
    const card = staff
      .locator('div', { hasText: channelName })
      .filter({ has: staff.locator('pre') })
      .last();
    await card.getByRole('button', { name: 'Settings' }).click();
    await staff.fill('#wc-sites', 'https://dhakafashion.example');
    await staff.getByRole('button', { name: 'Save' }).click();
    await staff.getByText('Website chat saved').waitFor();
    // The site wrapper caches allowed sites for a minute.
    const blocked = await browser.newContext();
    const page = await blocked.newPage();
    let refused = false;
    page.on('console', (m) => {
      if (/frame-ancestors|Refused to frame/i.test(m.text())) refused = true;
    });
    const deadline = Date.now() + 75_000;
    while (!refused && Date.now() < deadline) {
      await page.goto(siteUrl);
      await page.waitForTimeout(2_500);
      if (!refused) await page.waitForTimeout(5_000);
    }
    if (!refused) throw new Error('chat still framed on a site that is not allowed');
    const visible = await page.locator('iframe[title="Chat"]').isVisible();
    if (visible) throw new Error('chat bubble visible on a site that is not allowed');
    await blocked.close();
    // Allow any site again.
    await card.getByRole('button', { name: 'Settings' }).click();
    await staff.fill('#wc-sites', '');
    await staff.getByRole('button', { name: 'Save' }).click();
    await staff.getByText('Website chat saved').waitFor();
  });
} catch {
  failed = true;
} finally {
  site?.close();
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
