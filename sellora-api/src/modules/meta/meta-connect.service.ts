import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import {
  ChannelsService,
  type ChannelDoc,
  type InboxChannelRemovedEvent,
} from '../inbox/channels.service.js';
import { MetaGraph, MetaGraphError } from './meta-graph.js';
import type { MetaChannelType } from './meta.types.js';

/** What the page connection asks for: list pages, message as them, and their Instagram. */
const LOGIN_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'business_management',
];
/** Page webhook fields: messages, button taps, replies sent elsewhere, delivery and read. */
const PAGE_FIELDS = 'messages,messaging_postbacks,message_echoes,message_deliveries,message_reads';
const STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_S = 15 * 60;

interface OAuthState {
  o: string;
  u: string;
  n: string;
  e: number;
}

interface PageGrant {
  id: string;
  name: string;
  token: string;
  tasks: string[] | null;
  instagram: { id: string; username: string | null; name: string | null } | null;
}

interface ConnectSession {
  o: string;
  u: string;
  pages: PageGrant[];
}

type Connected = 'here' | 'elsewhere' | null;

export interface PageChoice {
  id: string;
  name: string;
  /** The person may message as this page (the page task MESSAGING or MANAGE). */
  canMessage: boolean;
  instagram: { id: string; username: string | null } | null;
  connected: { messenger: Connected; instagram: Connected };
}

/**
 * Connecting Facebook pages (Messenger and the linked Instagram account) with Facebook
 * Login, and WhatsApp numbers with Embedded Signup or a system user token. Tokens are only
 * ever stored encrypted; the page list between login and choice lives in Redis for 15
 * minutes, encrypted too.
 */
@Injectable()
export class MetaConnectService {
  private readonly logger = new Logger(MetaConnectService.name);

  constructor(
    private readonly graph: MetaGraph,
    private readonly channels: ChannelsService,
    private readonly encryption: EncryptionService,
    private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private userId(): string {
    return RequestContext.actor().id;
  }

  private redirectUri(): string {
    return `${this.config.get('WEB_APP_URL').replace(/\/+$/, '')}/app/connect/meta`;
  }

  private assertConfigured(): void {
    if (!this.graph.configured())
      throw new AppError(
        'meta_not_configured',
        503,
        'Messenger, Instagram and WhatsApp are not set up on this platform yet.',
      );
  }

  /** What the web app needs to show the connect buttons. */
  settings() {
    const configured = this.graph.configured();
    return {
      configured,
      appId: configured ? this.graph.appId() : null,
      graphVersion: this.graph.version(),
      whatsappEmbeddedSignup: configured
        ? (this.config.get('META_WHATSAPP_CONFIG_ID') ?? null)
        : null,
      redirectUri: this.redirectUri(),
    };
  }

  // ------------------------------------------------------------------ Facebook pages

  /** The Facebook Login dialog URL. `state` binds the answer to this business and person. */
  startPageLogin(): { url: string } {
    this.assertConfigured();
    const state: OAuthState = {
      o: this.orgId(),
      u: this.userId(),
      n: randomBytes(16).toString('base64url'),
      e: Date.now() + STATE_TTL_MS,
    };
    const params = new URLSearchParams({
      client_id: this.graph.appId(),
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      // The web page reads the business from the part before the first dot.
      state: `${state.o}.${this.encryption.encrypt(JSON.stringify(state), 'meta-oauth')}`,
    });
    const configId = this.config.get('META_LOGIN_CONFIG_ID');
    if (configId) params.set('config_id', configId);
    else params.set('scope', LOGIN_SCOPES.join(','));
    return { url: `${this.graph.dialogUrl('dialog/oauth')}?${params.toString()}` };
  }

  /** Exchanges the login code and lists the pages the person can connect. */
  async finishPageLogin(
    code: string,
    rawState: string,
  ): Promise<{ sessionId: string; pages: PageChoice[] }> {
    this.assertConfigured();
    await this.checkState(rawState);
    const userToken = await this.graphCall(() =>
      this.graph.userTokenFromCode(code, this.redirectUri()),
    );
    const res = await this.graphCall(() =>
      this.graph.get<{
        data?: {
          id?: string;
          name?: string;
          access_token?: string;
          tasks?: string[];
          instagram_business_account?: { id?: string; username?: string; name?: string };
        }[];
      }>('me/accounts', userToken, {
        fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name}',
        limit: '100',
      }),
    );
    const pages: PageGrant[] = [];
    for (const p of res.data ?? []) {
      if (!p.id || !p.access_token) continue;
      const ig = p.instagram_business_account;
      pages.push({
        id: p.id,
        name: p.name ?? p.id,
        token: p.access_token,
        tasks: Array.isArray(p.tasks) ? p.tasks : null,
        instagram: ig?.id
          ? { id: ig.id, username: ig.username ?? null, name: ig.name ?? null }
          : null,
      });
    }
    const sessionId = randomBytes(18).toString('base64url');
    const session: ConnectSession = { o: this.orgId(), u: this.userId(), pages };
    await this.redis.set(
      sessionKey(sessionId),
      this.encryption.encrypt(JSON.stringify(session), sessionKey(sessionId)),
      'EX',
      SESSION_TTL_S,
    );
    return { sessionId, pages: await Promise.all(pages.map((p) => this.choice(p))) };
  }

  /** The pages from a login, again (the chooser was reloaded). */
  async sessionPages(sessionId: string): Promise<{ sessionId: string; pages: PageChoice[] }> {
    const session = await this.session(sessionId);
    return { sessionId, pages: await Promise.all(session.pages.map((p) => this.choice(p))) };
  }

  /** Connects a page's Messenger, its Instagram account, or both. */
  async connectPage(input: {
    sessionId: string;
    pageId: string;
    messenger: boolean;
    instagram: boolean;
  }): Promise<ChannelDoc[]> {
    this.assertConfigured();
    const session = await this.session(input.sessionId);
    const page = session.pages.find((p) => p.id === input.pageId);
    if (!page) throw AppError.notFound('page', 'That page is not in this Facebook login.');
    if (!input.messenger && !input.instagram)
      throw AppError.validation([
        { path: 'messenger', message: 'Choose Messenger, Instagram or both' },
      ]);
    if (input.instagram && !page.instagram)
      throw AppError.badRequest(
        'no_instagram_account',
        'This page has no Instagram professional account linked. Link one in the page settings first.',
      );
    if (page.tasks && !page.tasks.some((t) => t === 'MESSAGING' || t === 'MANAGE'))
      throw AppError.badRequest(
        'page_messaging_not_allowed',
        'Your role on this page does not allow messaging. Ask a page admin to connect it.',
      );

    const wanted: { type: MetaChannelType; externalId: string }[] = [];
    if (input.messenger) wanted.push({ type: 'messenger', externalId: page.id });
    if (input.instagram) wanted.push({ type: 'instagram', externalId: page.instagram!.id });
    let fresh = 0;
    for (const w of wanted) {
      const owner = await this.channels.findMetaAccount(w.type, w.externalId);
      if (owner && owner.orgId.toHexString() !== this.orgId())
        throw AppError.conflict(
          'account_connected_elsewhere',
          'This account is already connected to another business on this platform. Remove it there first.',
        );
      if (!owner) fresh += 1;
    }
    await this.channels.assertRoomFor(fresh);

    // Without the subscription Meta sends no messages, so a failure stops here.
    await this.graphCall(() =>
      this.graph.post(
        `${page.id}/subscribed_apps`,
        page.token,
        {},
        { subscribed_fields: PAGE_FIELDS },
      ),
    );
    const result: ChannelDoc[] = [];
    for (const w of wanted) {
      const ig = w.type === 'instagram' ? page.instagram! : null;
      const { channel } = await this.channels.connectMeta({
        type: w.type,
        externalId: w.externalId,
        displayName: ig ? (ig.username ? `@${ig.username}` : (ig.name ?? page.name)) : page.name,
        accessToken: page.token,
        pageId: page.id,
        ...(ig?.username ? { username: ig.username } : {}),
      });
      result.push(channel);
    }
    return result;
  }

  // ------------------------------------------------------------------ WhatsApp

  /** Connects a WhatsApp Cloud API number with a permanent (system user) token. */
  async connectWhatsApp(input: {
    phoneNumberId: string;
    wabaId: string;
    accessToken: string;
  }): Promise<ChannelDoc> {
    this.assertConfigured();
    const owner = await this.channels.findMetaAccount('whatsapp', input.phoneNumberId);
    if (owner && owner.orgId.toHexString() !== this.orgId())
      throw AppError.conflict(
        'account_connected_elsewhere',
        'This WhatsApp number is already connected to another business on this platform.',
      );
    if (!owner) await this.channels.assertRoomFor(1);

    const phone = await this.graphCall(
      () =>
        this.graph.get<{ display_phone_number?: string; verified_name?: string }>(
          input.phoneNumberId,
          input.accessToken,
          { fields: 'display_phone_number,verified_name' },
        ),
      {
        bad_request: [
          'whatsapp_number_not_found',
          'Meta does not know this phone number id, or the token cannot see it.',
        ],
      },
    );
    const numbers = await this.graphCall(() =>
      this.graph.get<{ data?: { id?: string }[] }>(
        `${input.wabaId}/phone_numbers`,
        input.accessToken,
        {
          fields: 'id',
          limit: '100',
        },
      ),
    );
    if (!(numbers.data ?? []).some((n) => n.id === input.phoneNumberId))
      throw AppError.badRequest(
        'whatsapp_number_not_in_account',
        'This phone number does not belong to that WhatsApp Business Account.',
      );
    await this.graphCall(() =>
      this.graph.post(`${input.wabaId}/subscribed_apps`, input.accessToken, {}),
    );

    const label = [phone.verified_name, phone.display_phone_number].filter(Boolean).join(' · ');
    const { channel } = await this.channels.connectMeta({
      type: 'whatsapp',
      externalId: input.phoneNumberId,
      displayName: label || `WhatsApp ${input.phoneNumberId}`,
      accessToken: input.accessToken,
      wabaId: input.wabaId,
    });
    return channel;
  }

  /** Embedded Signup: the popup returned a code and the chosen number. */
  async connectWhatsAppEmbedded(input: {
    code: string;
    phoneNumberId: string;
    wabaId: string;
  }): Promise<ChannelDoc> {
    this.assertConfigured();
    const accessToken = await this.graphCall(() => this.graph.businessTokenFromCode(input.code));
    return this.connectWhatsApp({
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      accessToken,
    });
  }

  // ------------------------------------------------------------------ removal

  /**
   * After a channel is removed, stops Meta's webhooks for its page or WhatsApp account
   * unless another channel of the business still uses it. Best effort: the channel is gone
   * either way, and webhooks for unknown accounts are ignored.
   */
  async onChannelRemoved(e: InboxChannelRemovedEvent): Promise<void> {
    const { channel } = e;
    if (!channel.meta || channel.type === 'web_chat' || !this.graph.configured()) return;
    const siblings = await this.channels.siblingsOf(channel);
    let path: string | null = null;
    if (channel.type === 'whatsapp' && channel.meta.wabaId) {
      if (!siblings.some((s) => s.meta?.wabaId === channel.meta!.wabaId))
        path = `${channel.meta.wabaId}/subscribed_apps`;
    } else if (
      channel.meta.pageId &&
      !siblings.some((s) => s.meta?.pageId === channel.meta!.pageId)
    ) {
      path = `${channel.meta.pageId}/subscribed_apps`;
    }
    if (!path) return;
    try {
      await this.graph.delete(path, this.channels.metaToken(channel));
    } catch (err) {
      this.logger.warn({ err, channelId: channel._id }, 'Could not unsubscribe a removed channel');
    }
  }

  // ------------------------------------------------------------------ helpers

  private async checkState(raw: string): Promise<void> {
    const dot = raw.indexOf('.');
    let state: OAuthState;
    try {
      state = JSON.parse(this.encryption.decrypt(raw.slice(dot + 1), 'meta-oauth')) as OAuthState;
    } catch {
      throw AppError.badRequest(
        'invalid_state',
        'This Facebook login link is not valid. Start again.',
      );
    }
    if (
      dot < 0 ||
      raw.slice(0, dot) !== state.o ||
      state.o !== this.orgId() ||
      state.u !== this.userId()
    )
      throw AppError.badRequest(
        'invalid_state',
        'This Facebook login was started by someone else. Start again.',
      );
    if (state.e < Date.now())
      throw AppError.badRequest('state_expired', 'The Facebook login took too long. Start again.');
    const first = await this.redis.set(`meta:oauth:${state.n}`, '1', 'PX', STATE_TTL_MS, 'NX');
    if (first !== 'OK')
      throw AppError.badRequest('state_used', 'This Facebook login was already used. Start again.');
  }

  private async session(sessionId: string): Promise<ConnectSession> {
    const stored = await this.redis.get(sessionKey(sessionId));
    if (!stored)
      throw AppError.badRequest('connect_session_expired', 'The page list expired. Connect again.');
    const session = JSON.parse(
      this.encryption.decrypt(stored, sessionKey(sessionId)),
    ) as ConnectSession;
    if (session.o !== this.orgId() || session.u !== this.userId())
      throw AppError.badRequest('connect_session_expired', 'The page list expired. Connect again.');
    return session;
  }

  private async choice(p: PageGrant): Promise<PageChoice> {
    const where = async (type: MetaChannelType, id: string | undefined): Promise<Connected> => {
      if (!id) return null;
      const owner = await this.channels.findMetaAccount(type, id);
      if (!owner) return null;
      return owner.orgId.toHexString() === this.orgId() ? 'here' : 'elsewhere';
    };
    return {
      id: p.id,
      name: p.name,
      canMessage: !p.tasks || p.tasks.some((t) => t === 'MESSAGING' || t === 'MANAGE'),
      instagram: p.instagram ? { id: p.instagram.id, username: p.instagram.username } : null,
      connected: {
        messenger: await where('messenger', p.id),
        instagram: await where('instagram', p.instagram?.id),
      },
    };
  }

  /** Runs a Graph call and turns Meta's errors into answers a merchant can act on. */
  private async graphCall<T>(
    fn: () => Promise<T>,
    overrides: Partial<Record<MetaGraphError['kind'], [string, string]>> = {},
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof MetaGraphError)) throw err;
      const custom = overrides[err.kind];
      if (custom) throw AppError.badRequest(custom[0], custom[1], { meta: err.message });
      switch (err.kind) {
        case 'auth':
          throw AppError.badRequest(
            'meta_access_denied',
            'Meta did not accept this access. Log in again and allow every permission asked for.',
            { meta: err.message },
          );
        case 'not_configured':
          throw new AppError(
            'meta_not_configured',
            503,
            'Messenger, Instagram and WhatsApp are not set up on this platform yet.',
          );
        case 'rate_limited':
        case 'transient':
        case 'network':
          throw new AppError(
            'meta_unavailable',
            503,
            'Meta is not answering right now. Try again in a minute.',
          );
        case 'outside_window':
        case 'bad_request':
          throw AppError.badRequest('meta_rejected', `Meta refused the request: ${err.message}`, {
            meta: err.message,
          });
      }
    }
  }
}

const sessionKey = (id: string) => `meta:connect:${id}`;
