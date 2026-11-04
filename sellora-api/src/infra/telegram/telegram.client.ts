import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

/** Injection token for the fetch the Telegram client uses, so tests can play Telegram's part. */
export const TELEGRAM_FETCH = Symbol('TELEGRAM_FETCH');

/**
 * How a Bot API call failed. `retry`: Telegram asked to wait (`retryAfter` seconds) or could
 * not be reached. `chat_gone`: the bot was blocked, removed or the chat does not exist.
 * `token`: the bot token is wrong. `other`: anything else.
 */
export class TelegramError extends Error {
  constructor(
    readonly kind: 'retry' | 'chat_gone' | 'token' | 'other',
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** The parts of a Telegram update the bot reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: TelegramChat;
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    text?: string;
  };
}

/** Telegram's limit for one message. */
export const TELEGRAM_MAX_TEXT = 4096;

/** The Telegram Bot API, as far as owner reports need it (ADR 0022). */
@Injectable()
export class TelegramClient {
  constructor(
    private readonly config: AppConfig,
    @Inject(TELEGRAM_FETCH) private readonly fetch: typeof globalThis.fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.get('TELEGRAM_BOT_TOKEN'));
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN');
    if (!token) throw new TelegramError('token', 'Telegram is not set up (TELEGRAM_BOT_TOKEN)');
    const base = this.config.get('TELEGRAM_API_URL').replace(/\/+$/, '');
    let res: Response;
    try {
      res = await this.fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new TelegramError('retry', 'Telegram could not be reached', 30);
    }
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (res.ok && json.ok) return json.result as T;
    const what = typeof json.description === 'string' ? json.description : `HTTP ${res.status}`;
    const code = json.error_code ?? res.status;
    if (code === 429)
      throw new TelegramError(
        'retry',
        `Telegram asked to wait: ${what}`,
        json.parameters?.retry_after ?? 30,
      );
    if (code === 401 || code === 404)
      throw new TelegramError('token', `Telegram refused the bot token: ${what}`);
    if (
      code === 403 ||
      (code === 400 && /chat not found|bot was kicked|not a member|blocked/i.test(what))
    )
      throw new TelegramError('chat_gone', what);
    if (code >= 500) throw new TelegramError('retry', `Telegram answered ${code}: ${what}`, 30);
    throw new TelegramError('other', what);
  }

  getMe(): Promise<{ id: number; username: string; first_name: string }> {
    return this.call('getMe', {});
  }

  /** Sends HTML text (see `escapeHtml`). Returns Telegram's message id. */
  async sendMessage(
    chatId: string,
    html: string,
  ): Promise<{ messageId: number; chat: TelegramChat }> {
    const r = await this.call<{ message_id: number; chat: TelegramChat }>('sendMessage', {
      chat_id: chatId,
      text: html.length > TELEGRAM_MAX_TEXT ? `${html.slice(0, TELEGRAM_MAX_TEXT - 1)}…` : html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    return { messageId: r.message_id, chat: r.chat };
  }

  async getChat(chatId: string): Promise<TelegramChat> {
    return this.call('getChat', { chat_id: chatId });
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: true });
  }

  getWebhookInfo(): Promise<{
    url: string;
    pending_update_count: number;
    last_error_message?: string;
  }> {
    return this.call('getWebhookInfo', {});
  }
}

/** Text made safe for Telegram's HTML mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
