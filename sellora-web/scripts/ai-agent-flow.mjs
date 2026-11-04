/* eslint-disable no-console -- a command-line report */
/**
 * Clicks through the AI sales agent in real browsers against a running web app, API and
 * worker: fills in the agent's settings, chats with it in the "Try it" panel, turns it on,
 * then has a visitor chat on a merchant's site and checks that the agent answers live,
 * shows in the inbox as the AI, hands a complaint over to the team (pausing itself with a
 * reason), and that the team can correct what the AI remembers. Also checks that AI credits
 * were spent, and the phone and dark layouts. Fails on console errors, unexpected API
 * errors or a missing result. Creates real data in the signed-in business.
 *
 * The API must have an AI provider. Without a real key, run the scripted stand-in
 * (sellora-api/scripts/claude-stand-in.mjs) and start the API and worker with
 * AI_ANTHROPIC_BASE_URL pointing at it; the expected replies below are the stand-in's.
 *
 *   SMOKE_MERCHANT_EMAIL=… SMOKE_MERCHANT_PASSWORD=… node scripts/ai-agent-flow.mjs
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const env = process.env;
const BASE = (env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = env.SMOKE_OUT ?? 'smoke-output/ai-agent';
mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36).slice(-5);
const visitorName = `Karima ${stamp}`;
const problems = [];
const steps = [];

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const browser = await chromium.launch();
let failed = false;
let site;
try {
  const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const staff = await staffCtx.newPage();
  watch(staff, 'staff');

  await staff.goto(`${BASE}/login`);
  await staff.fill('#email', need('SMOKE_MERCHANT_EMAIL'));
  await staff.fill('#password', need('SMOKE_MERCHANT_PASSWORD'));
  await staff.click('button[type=submit]');
  await staff.waitForURL(/\/app\/[a-f0-9]{24}/, { timeout: 15_000 });
  const org = new URL(staff.url()).pathname.match(/^\/app\/[a-f0-9]{24}/)[0];
  const orgId = org.slice(5);
  const apiGet = async (path) => {
    const res = await staff.request.get(`${BASE}/v1/orgs/${orgId}${path}`);
    if (!res.ok()) throw new Error(`GET ${path}: ${res.status()}`);
    return res.json();
  };
  const walletBefore = (await apiGet('/billing/wallet')).availableMinor;

  await step('the AI sales agent page shows status, cost per reply and the wallet', async () => {
    await staff.getByRole('link', { name: 'AI sales agent' }).click();
    await staff.getByRole('heading', { name: 'AI sales agent' }).waitFor();
    await staff.getByText('A typical reply').waitFor();
    await staff
      .getByText(/credits? \(৳[\d.,]+\) per typical reply/)
      .first()
      .waitFor();
    await shot(staff, '01-agent-page', true);
  });

  await step('fill in what the agent knows and how it hands over, then save', async () => {
    await staff.fill('#assistantName', 'Mitu');
    await staff.fill(
      '#businessInfo',
      `Dhaka Fashion sells kurtis, scarves and sarees. Cash on delivery all over Bangladesh. Inside Dhaka 1-2 days, outside 2-4 days. Exchange within 3 days. (${stamp})`,
    );
    // Start the questions afresh so the flow can run again on the same business.
    const remove = staff.getByRole('button', { name: /^Remove question \d+$/ });
    while ((await remove.count()) > 0) await remove.first().click();
    await staff.getByRole('button', { name: 'Add question' }).click();
    await staff.fill('#faq-0-q', `Do you exchange sizes? (${stamp})`);
    await staff.fill('#faq-0-a', 'Yes, within 3 days if the tag is on.');
    await staff.fill('#keywords', 'talk to a human, মানুষের সাথে কথা');
    await staff.press('#keywords', 'Enter');
    await staff.getByRole('button', { name: 'Remove talk to a human' }).waitFor();
    await staff.getByText('You have unsaved changes.').waitFor();
    await staff.getByRole('button', { name: 'Save', exact: true }).click();
    await staff.getByText(/^Saved\. The agent uses the new settings/).waitFor();
    await staff.getByText('You have unsaved changes.').waitFor({ state: 'detached' });
    const saved = (await apiGet('/ai-agent')).settings;
    if (saved.assistantName !== 'Mitu' || saved.faqs.length !== 1)
      throw new Error(`not saved: ${JSON.stringify(saved).slice(0, 200)}`);
    if (!saved.handoverKeywords.includes('মানুষের সাথে কথা'))
      throw new Error(`keywords: ${saved.handoverKeywords.join(', ')}`);
  });

  await step('the test chat answers as the agent, from the real catalog', async () => {
    await staff.fill('#test-chat-input', 'kurti ache?');
    await staff.press('#test-chat-input', 'Enter');
    const chat = staff.getByRole('list', { name: 'Test chat' });
    await chat.getByText(/Ji, amader kache ache:/).waitFor({ timeout: 20_000 });
    await chat.getByText(/Kurti/).first().waitFor();
    await chat.getByText(/searched products · [\d.]+ credits?/).waitFor();
    await shot(staff, '02-test-chat');
  });

  await step('turn the agent on', async () => {
    const toggle = staff.getByRole('switch', { name: 'AI sales agent on' });
    // A run that stopped early may have left it on.
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click();
      await staff.getByText('The AI sales agent is on.').waitFor();
    }
    await staff.getByText('Agent on', { exact: true }).waitFor();
  });

  const channels = await apiGet('/channels');
  const channel = (channels.items ?? channels).find(
    (c) =>
      c.type === 'web_chat' &&
      c.status === 'active' &&
      c.aiEnabled &&
      c.webChat.allowedOrigins.length === 0,
  );
  if (!channel) throw new Error('No active website chat with AI on; run scripts/inbox-flow.mjs');
  site = await merchantSite(
    `<script src="${BASE}/widget.js" data-key="${channel.webChat.publicKey}" async></script>`,
  );
  const siteUrl = `http://127.0.0.1:${site.address().port}/`;

  const visitorCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const visitor = await visitorCtx.newPage();
  watch(visitor, 'visitor');
  let chat;

  await step('open the inbox, then a visitor asks about a product', async () => {
    await staff.goto(`${BASE}${org}/inbox`);
    await staff.getByRole('status').filter({ hasText: 'Live' }).waitFor({ timeout: 10_000 });
    await visitor.goto(siteUrl);
    await visitor.locator('iframe[title="Chat"]').waitFor({ state: 'visible', timeout: 10_000 });
    chat = visitor.frameLocator('iframe[title="Chat"]');
    await chat.getByRole('button', { name: /Chat with/ }).click();
    if (await chat.locator('#wv-name').isVisible()) {
      await chat.locator('#wv-name').fill(visitorName);
      await chat.locator('#wv-phone').fill('01811111111');
      await chat.getByRole('button', { name: 'Start chat' }).click();
    }
    await chat.locator('#wv-text').fill('Assalamu alaikum, kurti ache?');
    await chat.locator('#wv-text').press('Enter');
  });

  await step('the agent replies to the visitor live, after the short wait', async () => {
    // With the fast stand-in, "typing…" may show for only a moment before the reply lands.
    await chat.getByText(/Ji, amader kache ache:/).waitFor({ timeout: 20_000 });
    await shot(visitor, '03-visitor-ai-reply');
  });

  await step('the inbox shows the reply as the AI, with its credit cost', async () => {
    const row = staff.getByRole('button', { name: new RegExp(visitorName) });
    await row.waitFor({ timeout: 10_000 });
    await row.click();
    const thread = staff.getByRole('list', { name: 'Messages' });
    await thread.getByText(/Ji, amader kache ache:/).waitFor({ timeout: 10_000 });
    await thread
      .getByText(/^AI · [\d.]+ credits? · /)
      .first()
      .waitFor();
    await shot(staff, '04-inbox-ai-reply');
  });

  await step('a complaint goes to the team: the AI tells the customer and pauses', async () => {
    await chat.locator('#wv-text').fill('Parcel ta chhera eseche, refund chai!');
    await chat.locator('#wv-text').press('Enter');
    await chat
      .getByText('Dukkhito! Amader team ekhuni apnar sathe kotha bolbe.')
      .waitFor({ timeout: 20_000 });
    await staff
      .getByText('The AI handed this chat to the team')
      .first()
      .waitFor({ timeout: 10_000 });
    const ai = staff.getByRole('switch', { name: 'AI replies in this conversation' });
    await staff.waitForFunction(
      (el) => el?.getAttribute('aria-checked') === 'false',
      await ai.elementHandle(),
    );
    await shot(staff, '05-inbox-handover');
  });

  await step('the team corrects what the AI remembers about the customer', async () => {
    const panel = staff.getByRole('complementary');
    const memory = (await panel.count()) ? panel : staff;
    await memory.getByRole('heading', { name: 'What the AI remembers' }).waitFor();
    await memory.getByRole('button', { name: 'Edit', exact: true }).click();
    await staff.fill('#mem-facts', 'wears size M\nprefers cotton');
    await staff.fill('#mem-address', 'Mirpur 10, Dhaka');
    await staff.getByRole('button', { name: 'Save', exact: true }).click();
    await staff.getByText('prefers cotton').waitFor();
    await staff.getByText('Mirpur 10, Dhaka').waitFor();
    await shot(staff, '06-inbox-ai-memory');
  });

  await step('a person turns the AI back on from the thread', async () => {
    await staff.getByRole('button', { name: 'Turn AI back on' }).click();
    await staff.getByRole('button', { name: 'Turn AI back on' }).waitFor({ state: 'detached' });
  });

  await step('the replies were paid for from the AI credit wallet', async () => {
    const after = (await apiGet('/billing/wallet')).availableMinor;
    if (!(after < walletBefore)) throw new Error(`wallet ${walletBefore} → ${after}`);
    const usage = await apiGet('/billing/ai-usage/requests?feature=ai_agent_reply');
    if (!(usage.items ?? []).length) throw new Error('no AI reply usage recorded');
    console.log(`  wallet: ${walletBefore} → ${after} (minor units)`);
  });

  await step('phone and dark layouts of the agent page', async () => {
    const phoneCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      storageState: await staffCtx.storageState(),
      isMobile: true,
      hasTouch: true,
    });
    const phone = await phoneCtx.newPage();
    watch(phone, 'phone');
    await phone.goto(`${BASE}${org}/ai-agent`);
    await phone.getByRole('heading', { name: 'AI sales agent' }).waitFor();
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (overflow) throw new Error('the page scrolls sideways on a phone');
    await shot(phone, '07-agent-phone', true);
    await phoneCtx.close();
    await staff.emulateMedia({ colorScheme: 'dark' });
    await staff.goto(`${BASE}${org}/ai-agent`);
    await staff.getByRole('heading', { name: 'AI sales agent' }).waitFor();
    await shot(staff, '08-agent-dark');
    await staff.emulateMedia({ colorScheme: 'light' });
  });

  await step('turn the agent off again', async () => {
    await staff.getByRole('switch', { name: 'AI sales agent on' }).click();
    await staff.getByText('The AI sales agent is off.').waitFor();
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
