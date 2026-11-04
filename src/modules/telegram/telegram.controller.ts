import { Body, Controller, Delete, Get, Headers, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { OwnTokenAuth, PlatformApi, RequirePlatformPermissions } from '../auth/decorators.js';
import { PlatformAuthService } from '../platform/platform-auth.service.js';
import { AlertsService } from './alerts.service.js';
import type { ReportKind } from './reports.service.js';
import { TOPICS, TOPIC_KEYS, type Topic } from './schemas.js';
import { TelegramWatchService } from './telegram-watch.service.js';
import * as dto from './telegram.dto.js';
import { TelegramService, type AdminRef } from './telegram.service.js';

/** Admin › Telegram (ADR 0022): the bot, the allowed chats, reports and alert settings. */
@PlatformApi('telegram')
@RequirePlatformPermissions('platform.telegram.manage')
@Controller({ path: 'platform/telegram', version: '1' })
export class PlatformTelegramController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly watch: TelegramWatchService,
    private readonly alerts: AlertsService,
    private readonly auth: PlatformAuthService,
  ) {}

  private async me(): Promise<
    AdminRef & { role: Parameters<TelegramService['allowedTopics']>[0] }
  > {
    const id = RequestContext.actor().id;
    const user = await this.auth.me(id);
    return { id, label: user.email, role: user.role };
  }

  @Get()
  @ApiOperation({ summary: 'The bot, the webhook, settings, chats and the topics you may give' })
  async overview() {
    const me = await this.me();
    const [status, settings, chats] = await Promise.all([
      this.telegram.status(),
      this.telegram.settings(),
      this.telegram.chats(),
    ]);
    const allowed = this.telegram.allowedTopics(me.role);
    return {
      ...status,
      reports: settings.reports,
      alerts: settings.alerts,
      lastSent: {
        daily: settings.sent?.daily?.toISOString() ?? null,
        weekly: settings.sent?.weekly?.toISOString() ?? null,
        monthly: settings.sent?.monthly?.toISOString() ?? null,
      },
      chats,
      topics: TOPIC_KEYS.map((t) => ({
        topic: t,
        label: TOPICS[t].label,
        permission: TOPICS[t].permission,
        allowed: allowed.includes(t),
      })),
    };
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Turn reports or alerts on or off, change the hour or thresholds' })
  async updateSettings(@ZodBody(dto.settingsBody) body: z.infer<typeof dto.settingsBody>) {
    const s = await this.telegram.updateSettings(body, await this.me());
    this.alerts.forgetSettings();
    return { reports: s.reports, alerts: s.alerts };
  }

  @Post('link-code')
  @ApiOperation({ summary: 'A single-use code (15 minutes) to add a chat from Telegram' })
  async linkCode() {
    const { id, label } = await this.me();
    return this.telegram.linkCode({ id, ...(label ? { label } : {}) });
  }

  @Post('chats')
  @ApiOperation({ summary: 'Add a chat by its id (the bot must be able to write to it)' })
  async addChat(@ZodBody(dto.addChatBody) body: z.infer<typeof dto.addChatBody>) {
    const { id, label } = await this.me();
    return {
      chats: await this.telegram.addChatById(body.chatId, { id, ...(label ? { label } : {}) }),
    };
  }

  @Patch('chats/:chatId')
  @ApiOperation({ summary: "Choose what a chat gets (within your role's permissions)" })
  async setTopics(
    @ZodParam('chatId', dto.chatIdSchema) chatId: string,
    @ZodBody(dto.chatTopicsBody) body: z.infer<typeof dto.chatTopicsBody>,
  ) {
    const { id, label } = await this.me();
    return {
      chats: await this.telegram.setChatTopics(chatId, body.topics as Topic[], {
        id,
        ...(label ? { label } : {}),
      }),
    };
  }

  @Delete('chats/:chatId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a chat: it gets nothing more' })
  async removeChat(@ZodParam('chatId', dto.chatIdSchema) chatId: string) {
    const { id, label } = await this.me();
    await this.telegram.removeChat(chatId, { id, ...(label ? { label } : {}) });
  }

  @Post('chats/:chatId/test')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a test message (marks an unreachable chat active again)' })
  async test(@ZodParam('chatId', dto.chatIdSchema) chatId: string) {
    const { id, label } = await this.me();
    await this.telegram.sendTest(chatId, { id, ...(label ? { label } : {}) });
    return { queued: true };
  }

  @Post('webhook')
  @ApiOperation({ summary: 'Point Telegram at this server (needs a public HTTPS address)' })
  async connect() {
    const { id, label } = await this.me();
    return this.telegram.connectWebhook({ id, ...(label ? { label } : {}) });
  }

  @Delete('webhook')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop taking commands and link codes from Telegram' })
  async disconnect() {
    const { id, label } = await this.me();
    await this.telegram.disconnectWebhook({ id, ...(label ? { label } : {}) });
  }

  @Post('reports')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a report for the period that ends now to the report chats' })
  async sendReport(@ZodBody(dto.reportBody) body: z.infer<typeof dto.reportBody>) {
    const { id, label } = await this.me();
    if (!this.telegram.configured)
      throw AppError.conflict(
        'telegram_not_configured',
        'Telegram is not set up on this server (TELEGRAM_BOT_TOKEN).',
      );
    return this.watch.sendNow(body.kind as ReportKind, { id, ...(label ? { label } : {}) });
  }

  @Get('messages')
  @ApiOperation({ summary: 'The latest messages the bot sent or tried to send' })
  messages(@ZodQuery(dto.messagesQuery) q: z.infer<typeof dto.messagesQuery>) {
    return this.telegram.recent(q.limit);
  }
}

/** Telegram's webhook. Authorised by the secret token set with `setWebhook`, not a session. */
@ApiTags('webhooks')
@Controller({ path: 'telegram', version: '1' })
export class TelegramWebhookController {
  constructor(private readonly telegram: TelegramService) {}

  @OwnTokenAuth()
  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ) {
    if (!(await this.telegram.checkWebhookSecret(secret))) throw AppError.unauthorized();
    // An update the bot does not read is taken (200), or Telegram would send it again.
    const update = dto.updateBody.safeParse(body);
    if (update.success) await this.telegram.acceptUpdate(update.data);
    return { ok: true };
  }
}
