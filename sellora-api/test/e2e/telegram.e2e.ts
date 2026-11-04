import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_SIGNAL } from '../../src/common/alerts/platform-alert.js';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import type { TelegramUpdate } from '../../src/infra/telegram/telegram.client.js';
import { BackupsService } from '../../src/modules/backups/backups.service.js';
import { AlertsService } from '../../src/modules/telegram/alerts.service.js';
import { reportSlot } from '../../src/modules/telegram/reports.service.js';
import { TOPIC_KEYS } from '../../src/modules/telegram/schemas.js';
import { TelegramWatchService } from '../../src/modules/telegram/telegram-watch.service.js';
import { TelegramService } from '../../src/modules/telegram/telegram.service.js';
import { FakeTelegram, telegramEnv } from '../helpers/fake-telegram.js';
import { STRONG_PASSWORD, TestApp, uniqueEmail, type Session } from '../helpers/test-app.js';

const OWNER_CHAT = '5001';
const GROUP = '-1001234567890';

describe('owner reports and alerts on Telegram (ADR 0022)', () => {
  let t: TestApp;
  let tg: FakeTelegram;
  let owner: { token: string; email: string };
  let svc: TelegramService;
  let watch: TelegramWatchService;
  let alerts: AlertsService;
  let queue: Queue;
  let merchant: Session;
  let updateId = 1;

  const P = () => t.as(owner.token);
  const base = '/v1/platform/telegram';
  const messages = () => t.db.db!.collection('telegram_messages');
  const settingsDoc = () =>
    t.db.db!.collection('telegram_settings').findOne({ _id: 'global' as never });

  /** Sends every queued message, as the worker would. */
  const drain = async () => {
    for (let round = 0; round < 5; round++) {
      const queued = await messages().find({ status: 'queued' }).toArray();
      if (!queued.length) return;
      for (const m of queued) {
        const r = await svc.deliver(m._id.toHexString());
        if (r.failed) await alerts.deliveryFailed(r.failed);
      }
    }
  };

  const update = (
    chatId: number,
    text: string,
    type: 'private' | 'supergroup' = 'private',
  ): TelegramUpdate => ({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: chatId,
        type,
        ...(type === 'private' ? { first_name: 'Owner' } : { title: 'Group' }),
      },
      from: { id: 5001, is_bot: false, first_name: 'Owner' },
      text,
    },
  });

  /** Runs a command from a chat and returns what the bot answered there. */
  const command = async (chatId: number, text: string) => {
    const before = tg.textsTo(chatId).length;
    const outcome = await watch.handleUpdate(update(chatId, text));
    await drain();
    return { outcome, replies: tg.textsTo(chatId).slice(before) };
  };

  const setTopics = (chatId: string, topics: string[]) =>
    P().patch(`${base}/chats/${chatId}`).send({ topics }).expect(200);

  const waitFor = async <T>(
    fn: () => Promise<T | null | undefined | false>,
    what: string,
  ): Promise<T> => {
    for (let i = 0; i < 60; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  beforeAll(async () => {
    tg = new FakeTelegram();
    t = await TestApp.create(
      {
        ...telegramEnv,
        API_PUBLIC_URL: 'https://api.sellora.test',
        PLATFORM_REPORT_TIMEZONE: 'Asia/Dhaka',
      },
      { telegramFetch: tg.fetch },
    );
    owner = await t.platformOwner();
    svc = t.app.get(TelegramService);
    watch = t.app.get(TelegramWatchService);
    alerts = t.app.get(AlertsService);
    queue = t.app.get<Queue>(getQueueToken(QUEUES.telegram));
    merchant = await t.registerUser({ email: uniqueEmail('shop') });
  });

  afterAll(async () => {
    await t.close();
  });

  it('shows the bot and the topics, only to admins who manage Telegram', async () => {
    const res = await P().get(base).expect(200);
    expect(res.body).toMatchObject({
      configured: true,
      bot: { username: 'sellora_test_bot', name: 'Sellora' },
      webhook: null,
      webhookUrl: 'https://api.sellora.test/v1/telegram/webhook',
      chats: [],
      reports: { daily: true, weekly: true, monthly: true, hour: 21, timezone: 'Asia/Dhaka' },
      alerts: {
        enabled: true,
        queueBacklog: 500,
        loginFailures: 50,
        aiErrors: 20,
        aiSpendFactor: 3,
        emailFallback: true,
      },
    });
    expect(res.body.topics.map((x: { topic: string }) => x.topic)).toEqual(TOPIC_KEYS);
    expect(res.body.topics.every((x: { allowed: boolean }) => x.allowed)).toBe(true);
    // The token is never shown.
    expect(JSON.stringify(res.body)).not.toContain(telegramEnv.TELEGRAM_BOT_TOKEN);

    const email = uniqueEmail('finance');
    await P()
      .post('/v1/platform/admins')
      .send({ email, name: 'Finance', role: 'finance' })
      .expect(201);
    const finance = await t.completePlatformAccount(
      email,
      'a long platform passphrase',
      await t.lastTokenFromMail(email, 'platform.setup'),
    );
    await t.as(finance.token).get(base).expect(403);
    await t.as(finance.token).post(`${base}/link-code`).expect(403);
    const asMerchant = await t.as(merchant.token).get(base);
    expect([401, 403]).toContain(asMerchant.status);
  });

  it('links a private chat with a single-use code sent through the webhook', async () => {
    const code = (await P().post(`${base}/link-code`).expect(201)).body as {
      code: string;
      startUrl: string;
      expiresAt: string;
    };
    expect(code.code).toMatch(/^[a-f0-9]{12}$/);
    expect(code.startUrl).toBe(`https://t.me/sellora_test_bot?start=${code.code}`);
    expect(new Date(code.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    const hook = await P().post(`${base}/webhook`).expect(201);
    expect(hook.body.url).toBe('https://api.sellora.test/v1/telegram/webhook');
    expect(tg.webhook?.url).toBe(hook.body.url);
    const secret = tg.webhook!.secret;
    expect(secret.length).toBeGreaterThanOrEqual(24);
    // Only the secret's hash is kept.
    const saved = await settingsDoc();
    expect(saved?.webhook.secretHash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(JSON.stringify(saved)).not.toContain(secret);

    const start = update(5001, `/start ${code.code}`);
    await t.http().post('/v1/telegram/webhook').send(start).expect(401);
    await t
      .http()
      .post('/v1/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'wrong')
      .send(start)
      .expect(401);
    await t
      .http()
      .post('/v1/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', secret)
      .send(start)
      .expect(200);
    // Telegram retrying the same update queues it once.
    await t
      .http()
      .post('/v1/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', secret)
      .send(start)
      .expect(200);
    const job = await queue.getJob(`update-${start.update_id}`);
    expect(job?.data).toMatchObject({ update: { update_id: start.update_id } });
    // Something the bot does not read is taken and dropped.
    await t
      .http()
      .post('/v1/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', secret)
      .send({ update_id: 'x', edited_message: {} })
      .expect(200);

    expect(await watch.handleUpdate(start)).toBe('linked');
    await drain();
    expect(tg.textsTo(OWNER_CHAT).at(-1)).toContain('Connected to Sellora');

    const page = await P().get(base).expect(200);
    expect(page.body.chats).toEqual([
      expect.objectContaining({
        chatId: OWNER_CHAT,
        title: 'Owner',
        kind: 'private',
        topics: TOPIC_KEYS,
        status: 'active',
        blockedTopics: [],
        addedBy: expect.objectContaining({ label: owner.email }),
      }),
    ]);

    // The code works once.
    const again = await command(5001, `/start ${code.code}`);
    expect(again.outcome).toBe('linked');
    expect(again.replies.join('\n')).toContain('expired or was used');
    expect((await P().get(base).expect(200)).body.chats).toHaveLength(1);
    const audit = await t.db
      .db!.collection('audit_events')
      .findOne({ action: 'platform.telegram.chat_added' });
    expect(audit?.target).toMatchObject({ type: 'telegram_chat', id: OWNER_CHAT });
  });

  it('answers commands only in allowed chats, within their topics', async () => {
    const status = await command(5001, '/status');
    expect(status.outcome).toBe('replied');
    expect(status.replies[0]).toContain('Sellora status');
    expect(status.replies[0]).toContain('Queues:');
    const today = await command(5001, '/today@sellora_test_bot');
    expect(today.replies[0]).toContain('Sellora today so far');
    expect(today.replies[0]).toContain('Sign-ups:');
    expect(today.replies[0]).not.toContain(merchant.email);
    expect((await command(5001, '/backup')).replies[0]).toContain('Platform backups');
    expect((await command(5001, '/servers')).replies[0]).toContain("the worker's host");
    expect((await command(5001, '/help')).replies[0]).toContain('/status');
    expect((await command(5001, '/nonsense')).replies[0]).toContain("I don't know /nonsense");
    expect((await command(5001, 'hello')).outcome).toBe('ignored');

    // A chat that is not in the list gets no answer at all.
    tg.addChat({ id: 7777, type: 'private', first_name: 'Stranger' });
    expect((await command(7777, '/status')).outcome).toBe('ignored');
    expect(await messages().countDocuments({ chatId: '7777' })).toBe(0);

    // A chat that does not take backups cannot ask for them.
    await setTopics(OWNER_CHAT, ['reports']);
    const off = await command(5001, '/backup');
    expect(off.replies[0]).toContain('/backup is off here');
    expect((await command(5001, '/help')).replies[0]).toContain('(off in this chat)');
    await setTopics(OWNER_CHAT, TOPIC_KEYS);
  });

  it('adds a group by its id once the bot can write to it', async () => {
    const missing = await P().post(`${base}/chats`).send({ chatId: '-999' }).expect(422);
    expect(JSON.stringify(missing.body)).toContain('cannot write to this chat');
    await P().post(`${base}/chats`).send({ chatId: 'not a number' }).expect(422);
    const res = await P().post(`${base}/chats`).send({ chatId: GROUP }).expect(201);
    expect(res.body.chats).toContainEqual(
      expect.objectContaining({ chatId: GROUP, kind: 'supergroup', title: 'Sellora owners' }),
    );
    expect(tg.textsTo(GROUP).at(-1)).toContain('now gets Sellora owner reports');
    await P()
      .patch(`${base}/chats/${GROUP}`)
      .send({ topics: ['bogus'] })
      .expect(422);
    await P()
      .patch(`${base}/chats/-5`)
      .send({ topics: ['reports'] })
      .expect(404);
  });

  it('limits a chat to what the admin who linked it may still see', async () => {
    const email = uniqueEmail('admin');
    await P().post('/v1/platform/admins').send({ email, name: 'Admin', role: 'admin' }).expect(201);
    const admin = await t.completePlatformAccount(
      email,
      'a long platform passphrase',
      await t.lastTokenFromMail(email, 'platform.setup'),
    );
    tg.addChat({ id: 6001, type: 'private', first_name: 'Admin' });
    await t.as(admin.token).post(`${base}/chats`).send({ chatId: '6001' }).expect(201);
    expect((await svc.chatsFor('backups')).map((c) => c.chatId)).toContain('6001');
    // The admin becomes finance: backups are no longer theirs to get.
    await t.db.db!.collection('platform_users').updateOne({ email }, { $set: { role: 'finance' } });
    const chat = (
      (await P().get(base).expect(200)).body.chats as { chatId: string; blockedTopics: string[] }[]
    ).find((c) => c.chatId === '6001');
    expect(chat?.blockedTopics).toEqual(['backups']);
    expect((await svc.chatsFor('backups')).map((c) => c.chatId)).not.toContain('6001');
    expect((await svc.chatsFor('billing')).map((c) => c.chatId)).toContain('6001');
    await P().delete(`${base}/chats/6001`).expect(204);
    await P().delete(`${base}/chats/6001`).expect(404);
  });

  it('sends alerts to the chats that take the topic, escaped, and groups repeats', async () => {
    await setTopics(GROUP, ['security']);
    const sentBefore = tg.textsTo(GROUP).length;
    expect(
      await alerts.raise({
        topic: 'backups',
        key: 'e2e-backup',
        title: 'Disk <full>',
        lines: ['a & b'],
      }),
    ).toBe('telegram');
    await drain();
    const text = tg.textsTo(OWNER_CHAT).at(-1)!;
    expect(text).toContain('<b>Disk &lt;full&gt;</b>');
    expect(text).toContain('a &amp; b');
    expect(tg.textsTo(GROUP)).toHaveLength(sentBefore);
    expect(tg.sent.at(-1)?.parseMode).toBe('HTML');

    expect(await alerts.raise({ topic: 'backups', key: 'e2e-backup', title: 'Disk <full>' })).toBe(
      'held',
    );
    expect(await alerts.raise({ topic: 'backups', key: 'e2e-backup', title: 'Disk <full>' })).toBe(
      'held',
    );
    await t.redis.del('tg-alert:e2e-backup');
    expect(await alerts.raise({ topic: 'backups', key: 'e2e-backup', title: 'Disk <full>' })).toBe(
      'telegram',
    );
    await drain();
    expect(tg.textsTo(OWNER_CHAT).at(-1)).toContain('2 more like this were held back');
  });

  it('marks a chat that blocked the bot unreachable and emails the owners instead', async () => {
    tg.blocked.add(OWNER_CHAT);
    expect(
      await alerts.raise({ topic: 'backups', key: 'e2e-blocked', title: 'Backup trouble' }),
    ).toBe('telegram');
    await drain();
    const failed = await messages().findOne({ alertKey: 'e2e-blocked' });
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    const chat = (
      (await P().get(base).expect(200)).body.chats as {
        chatId: string;
        status: string;
        lastError: string;
      }[]
    ).find((c) => c.chatId === OWNER_CHAT);
    expect(chat).toMatchObject({ status: 'unreachable' });
    expect(chat?.lastError).toContain('blocked');
    const mails = (await t.outbox(owner.email)).filter((m) => m.category === 'platform.alert');
    expect(mails[0]?.subject).toBe('Sellora alert: Backup trouble');
    expect(mails[0]?.text).toContain('Telegram did not take this alert');

    // Now no chat takes backups: the next alert goes straight to email.
    expect(
      await alerts.raise({ topic: 'backups', key: 'e2e-nochat', title: 'Second trouble' }),
    ).toBe('email');
    expect(
      (await t.outbox(owner.email)).some((m) => m.subject === 'Sellora alert: Second trouble'),
    ).toBe(true);

    // Unblocked: a test message makes it active again.
    tg.blocked.delete(OWNER_CHAT);
    await P().post(`${base}/chats/${OWNER_CHAT}/test`).expect(202);
    await drain();
    expect(tg.textsTo(OWNER_CHAT).at(-1)).toContain('Test from Sellora');
    expect((await svc.chatsFor('backups')).map((c) => c.chatId)).toContain(OWNER_CHAT);
  });

  it('waits as Telegram asks on 429 and gives up after 5 tries', async () => {
    tg.rateLimit = { times: 1, retryAfter: 7 };
    const m = await svc.reply(OWNER_CHAT, 'rate limited once');
    const id = m._id.toHexString();
    const first = await svc.deliver(id);
    expect(first).toMatchObject({ status: 'queued', retryInMs: 7000 });
    const retry = await queue.getJob(`deliver-${id}-1`);
    expect(retry?.opts.delay).toBe(7000);
    expect(await svc.deliver(id)).toMatchObject({ status: 'sent' });
    expect(tg.textsTo(OWNER_CHAT).at(-1)).toBe('rate limited once');

    tg.unreachable = 5;
    const down = await svc.reply(OWNER_CHAT, 'never arrives');
    const downId = down._id.toHexString();
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) outcomes.push((await svc.deliver(downId)).status);
    expect(outcomes).toEqual(['queued', 'queued', 'queued', 'queued', 'failed']);
    expect(await messages().findOne({ _id: down._id })).toMatchObject({
      status: 'failed',
      attempts: 5,
    });
  });

  it('alerts on a spike of failed sign-ins and of AI provider errors', async () => {
    await P()
      .patch(`${base}/settings`)
      .send({ alerts: { loginFailures: 3, aiErrors: 2 } })
      .expect(200);
    for (let i = 0; i < 3; i++)
      await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: merchant.email, password: `${STRONG_PASSWORD}x` })
        .expect(401);
    await waitFor(
      () =>
        messages().findOne({ chatId: GROUP, text: { $regex: '3 failed sign-ins in 15 minutes' } }),
      'the sign-in alert',
    );
    await drain();
    const text = tg.textsTo(GROUP).at(-1)!;
    expect(text).toContain('Business sign-ins: 3');
    expect(text).not.toContain(merchant.email);

    const events = t.app.get(EventEmitter2);
    for (let i = 0; i < 2; i++)
      await events.emitAsync(PLATFORM_SIGNAL, {
        kind: 'ai_error',
        detail: 'anthropic: overloaded (529)',
      });
    await waitFor(
      () => messages().findOne({ chatId: OWNER_CHAT, text: { $regex: '2 AI provider errors' } }),
      'the AI error alert',
    );
  });

  it('alerts when a platform backup is interrupted', async () => {
    // No nightly backup in this test, only the interrupted one.
    await P().patch('/v1/platform/backups/settings').send({ enabled: false }).expect(200);
    const now = new Date();
    await t.db.db!.collection('backup_runs').insertOne({
      scope: 'platform',
      reason: 'manual',
      status: 'running',
      tiers: [],
      startedAt: new Date(now.getTime() - 3600_000),
      leaseUntil: new Date(now.getTime() - 60_000),
      lockKey: 'platform',
      createdAt: now,
      updatedAt: now,
    });
    await t.app.get(BackupsService).sweep(now);
    const m = await waitFor(
      () =>
        messages().findOne({ chatId: OWNER_CHAT, text: { $regex: 'A platform backup failed' } }),
      'the backup alert',
    );
    expect(m.text).toContain('The server stopped while the backup was being made.');
  });

  it('sends the daily report once at its hour, with counts only', async () => {
    await setTopics(GROUP, ['reports']);
    await P()
      .patch(`${base}/settings`)
      .send({ reports: { weekly: false, monthly: false, hour: 21 } })
      .expect(200);
    const org = await t.createOrg(merchant, { name: 'Secret Shop Name' });
    const now = new Date();
    const slot = reportSlot('daily', now, 21, 'Asia/Dhaka');
    const at = new Date(slot.getTime() + 10 * 60_000);
    await t.db
      .db!.collection('telegram_settings')
      .updateOne(
        { _id: 'global' as never },
        { $set: { 'sent.daily': new Date(slot.getTime() - 86_400_000) } },
      );
    const before = tg.textsTo(GROUP).length;
    expect((await watch.sweep(at)).reports).toEqual(['daily']);
    expect((await watch.sweep(at)).reports).toEqual([]);
    await drain();
    const reports = tg.textsTo(GROUP).slice(before);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('Sellora daily report');
    expect(reports[0]).toMatch(/Sign-ups: \d+ · new businesses: \d+/);
    expect(reports[0]).toContain('Last platform backup:');
    expect(reports[0]).toContain('Worker host: load');
    expect(reports[0]).not.toContain('Secret Shop Name');
    expect(reports[0]).not.toContain(merchant.email);
    expect(reports[0]).not.toContain(org.id);
    expect((await settingsDoc())?.sent.daily).toEqual(slot);
    // The owner's chat takes every topic, so it got the report too.
    expect(tg.textsTo(OWNER_CHAT).at(-1)).toContain('Sellora daily report');

    const now2 = await P().post(`${base}/reports`).send({ kind: 'weekly' }).expect(202);
    expect(now2.body.chats).toBe(2);
    await drain();
    expect(tg.textsTo(GROUP).at(-1)).toContain('Sellora weekly report');
    await P().post(`${base}/reports`).send({ kind: 'yearly' }).expect(422);
  });

  it('lists what was sent, and stops taking updates when the webhook is off', async () => {
    const list = await P().get(`${base}/messages?limit=5`).expect(200);
    expect(list.body).toHaveLength(5);
    expect(list.body[0]).toEqual(
      expect.objectContaining({
        chatId: expect.any(String),
        status: expect.any(String),
        kind: expect.any(String),
      }),
    );
    const secret = tg.webhook!.secret;
    await P().delete(`${base}/webhook`).expect(204);
    expect(tg.webhook).toBeNull();
    await t
      .http()
      .post('/v1/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', secret)
      .send(update(5001, '/status'))
      .expect(401);
    await P().delete(`${base}/chats/${OWNER_CHAT}`).expect(204);
    await P().delete(`${base}/chats/${GROUP}`).expect(204);
    expect(
      await alerts.raise({ topic: 'system', key: 'e2e-last', title: 'Nobody listening' }),
    ).toBe('email');
    await P()
      .patch(`${base}/settings`)
      .send({ alerts: { enabled: false } })
      .expect(200);
    expect(await alerts.raise({ topic: 'system', key: 'e2e-off', title: 'Off' })).toBe('off');
    await P().patch(`${base}/settings`).send({}).expect(422);
    await P()
      .patch(`${base}/settings`)
      .send({ reports: { timezone: 'Mars/Base' } })
      .expect(422);
  });
});

describe('Telegram not set up', () => {
  let t: TestApp;
  let owner: { token: string; email: string };

  beforeAll(async () => {
    t = await TestApp.create();
    owner = await t.platformOwner();
  });

  afterAll(async () => {
    await t.close();
  });

  it('says so, and emails alerts to the owners', async () => {
    const res = await t.as(owner.token).get('/v1/platform/telegram').expect(200);
    expect(res.body).toMatchObject({ configured: false, bot: null, chats: [] });
    const code = await t.as(owner.token).post('/v1/platform/telegram/link-code').expect(409);
    expect(code.body.code).toBe('telegram_not_configured');
    await t
      .as(owner.token)
      .post('/v1/platform/telegram/reports')
      .send({ kind: 'daily' })
      .expect(409);
    const alerts = t.app.get(AlertsService);
    expect(
      await alerts.raise({
        topic: 'billing',
        key: 'e2e-email',
        title: 'A payment failed',
        lines: ['x'],
      }),
    ).toBe('email');
    const mail = (await t.outbox(owner.email)).find((m) => m.category === 'platform.alert');
    expect(mail?.subject).toBe('Sellora alert: A payment failed');
    expect(mail?.text).toContain('Telegram is not set up on this server');
  });
});
