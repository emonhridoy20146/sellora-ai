import type { TelegramChat } from '../../src/infra/telegram/telegram.client.js';

/** A bot token of the right shape (not a real bot). */
export const TELEGRAM_TEST_TOKEN = '123456789:TEST-token_for-the-fake-telegram-api';
export const TELEGRAM_TEST_URL = 'https://telegram.test';

export const telegramEnv = {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TEST_TOKEN,
  TELEGRAM_API_URL: TELEGRAM_TEST_URL,
};

interface Sent {
  chatId: string;
  text: string;
  parseMode: string;
  messageId: number;
}

/**
 * Plays the Telegram Bot API for tests: chats it knows, messages it took, chats that blocked
 * the bot, a 429 on demand, and the webhook that was set.
 */
export class FakeTelegram {
  readonly chats = new Map<string, TelegramChat>();
  readonly sent: Sent[] = [];
  readonly blocked = new Set<string>();
  /** The next N sendMessage calls answer 429 with this retry_after. */
  rateLimit: { times: number; retryAfter: number } | null = null;
  /** The next N sendMessage calls fail to connect. */
  unreachable = 0;
  webhook: { url: string; secret: string } | null = null;
  calls: string[] = [];
  private nextId = 100;

  constructor() {
    this.addChat({ id: 5001, type: 'private', first_name: 'Owner', username: 'owner_tg' });
    this.addChat({ id: -1001234567890, type: 'supergroup', title: 'Sellora owners' });
  }

  addChat(chat: TelegramChat): void {
    this.chats.set(String(chat.id), chat);
  }

  textsTo(chatId: string | number): string[] {
    return this.sent.filter((m) => m.chatId === String(chatId)).map((m) => m.text);
  }

  readonly fetch: typeof fetch = (input, init) => {
    try {
      return Promise.resolve(this.answer(input, init));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  private answer(input: Parameters<typeof fetch>[0], init?: RequestInit): Response {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const [, bot, method] = url.pathname.split('/');
    if (bot !== `bot${TELEGRAM_TEST_TOKEN}`)
      return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const body = (init?.body ? JSON.parse(String(init.body as string)) : {}) as Record<
      string,
      unknown
    >;
    this.calls.push(method ?? '');
    switch (method ?? '') {
      case 'getMe':
        return json(200, {
          ok: true,
          result: { id: 42, is_bot: true, first_name: 'Sellora', username: 'sellora_test_bot' },
        });
      case 'getChat': {
        const chat = this.chats.get(String(body.chat_id));
        return chat
          ? json(200, { ok: true, result: chat })
          : json(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
      }
      case 'sendMessage': {
        if (this.unreachable > 0) {
          this.unreachable -= 1;
          throw new TypeError('fetch failed');
        }
        if (this.rateLimit && this.rateLimit.times > 0) {
          this.rateLimit.times -= 1;
          return json(429, {
            ok: false,
            error_code: 429,
            description: `Too Many Requests: retry after ${this.rateLimit.retryAfter}`,
            parameters: { retry_after: this.rateLimit.retryAfter },
          });
        }
        const chatId = String(body.chat_id);
        if (this.blocked.has(chatId))
          return json(403, {
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked by the user',
          });
        const chat = this.chats.get(chatId);
        if (!chat)
          return json(400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: chat not found',
          });
        const messageId = this.nextId++;
        this.sent.push({
          chatId,
          text: String(body.text),
          parseMode: String(body.parse_mode),
          messageId,
        });
        return json(200, { ok: true, result: { message_id: messageId, date: 0, chat } });
      }
      case 'setWebhook':
        this.webhook = {
          url: String(body.url),
          secret: String(body.secret_token),
        };
        return json(200, { ok: true, result: true });
      case 'deleteWebhook':
        this.webhook = null;
        return json(200, { ok: true, result: true });
      case 'getWebhookInfo':
        return json(200, {
          ok: true,
          result: {
            url: this.webhook?.url ?? '',
            pending_update_count: 0,
            has_custom_certificate: false,
          },
        });
      default:
        return json(404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
