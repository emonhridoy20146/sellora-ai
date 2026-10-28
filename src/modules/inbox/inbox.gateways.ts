import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { Types } from 'mongoose';
import type { Namespace, Socket } from 'socket.io';
import { RequestContext } from '../../common/context/request-context.js';
import { AppConfig } from '../../config/app-config.js';
import { RealtimeRelay } from '../../infra/realtime/realtime.relay.js';
import { COOKIE_NAMES } from '../auth/core/cookies.js';
import { SessionService } from '../auth/core/session.service.js';
import { TokenService } from '../auth/core/token.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { TenantAccessService, type ResolvedAccess } from '../orgs/tenant-access.service.js';
import { InboxRealtime, rooms } from './inbox-realtime.service.js';
import { ContactRepository, ConversationRepository } from './repositories.js';
import { WebchatService } from './webchat.service.js';

/** How often live staff connections are re-checked against sessions and roles. */
const REVALIDATE_MS = 60_000;
/** Typing events from one socket are relayed at most this often. */
const TYPING_EVERY_MS = 2_000;

type Ack = { ok: true; scope?: 'all' | 'assigned' } | { ok: false; code: string };

interface AgentData {
  user?: { id: string; sid: string };
  org?: { orgId: string; scope: 'all' | 'assigned' };
  lastTyping?: number;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // ignore malformed values
    }
  }
  return out;
}

function connectError(code: string): Error & { data: { code: string } } {
  return Object.assign(new Error(code), { data: { code } });
}

function inboxScope(access: ResolvedAccess): 'all' | 'assigned' | null {
  const has = (p: string) => access.permissions.includes('*') || access.permissions.includes(p);
  if (has('inbox.view')) return 'all';
  if (has('inbox.view_assigned')) return 'assigned';
  return null;
}

/**
 * Live inbox for staff apps. Connect with the session cookie (browsers) or `auth.token`
 * (mobile), then `join` a business. The socket only receives events the user may see:
 * all conversations with inbox.view, or the ones assigned to them.
 */
@WebSocketGateway({ namespace: 'agents' })
export class AgentsGateway implements OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentsGateway.name);
  private ns?: Namespace;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly relay: RealtimeRelay,
    private readonly config: AppConfig,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly access: TenantAccessService,
    private readonly entitlements: EntitlementsService,
    private readonly conversations: ConversationRepository,
    private readonly contacts: ContactRepository,
    private readonly realtime: InboxRealtime,
  ) {}

  afterInit(ns: Namespace): void {
    this.ns = ns;
    this.relay.register('agents', ns);
    ns.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (err: unknown) => next(err instanceof Error ? err : connectError('unauthorized')),
      );
    });
    this.timer = setInterval(() => void this.revalidate(), REVALIDATE_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async authenticate(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const bearer = typeof auth?.token === 'string' ? auth.token : undefined;
    const cookie = parseCookies(socket.handshake.headers.cookie)[COOKIE_NAMES.merchant.access];
    const token = bearer ?? cookie;
    if (!token) throw connectError('unauthorized');
    // Cookies ride along on cross-site requests, so a cookie login must come from our app.
    const origin = socket.handshake.headers.origin;
    if (!bearer && origin && !this.config.get('CORS_ORIGINS').includes(origin))
      throw connectError('origin_not_allowed');
    let claims: { sub: string; sid: string };
    try {
      claims = await this.tokens.verifyAccess(token, 'merchant');
    } catch {
      throw connectError('unauthorized');
    }
    if (!(await this.sessions.isActive(claims.sid))) throw connectError('session_revoked');
    (socket.data as AgentData).user = { id: claims.sub, sid: claims.sid };
  }

  private async scopeFor(orgId: string, userId: string): Promise<Ack> {
    const access = await this.access.resolve(orgId, userId);
    if (!access) return { ok: false, code: 'not_found' };
    if (access.orgStatus === 'suspended') return { ok: false, code: 'org_suspended' };
    const scope = inboxScope(access);
    if (!scope) return { ok: false, code: 'missing_permission' };
    if (!(await this.entitlements.hasModule(orgId, 'inbox')))
      return { ok: false, code: 'module_not_in_plan' };
    return { ok: true, scope };
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const data = socket.data as AgentData;
    const orgId = (body as { orgId?: unknown } | undefined)?.orgId;
    if (!data.user || typeof orgId !== 'string' || !Types.ObjectId.isValid(orgId))
      return { ok: false, code: 'bad_request' };
    const result = await this.scopeFor(orgId.toLowerCase(), data.user.id);
    if (!result.ok) return result;
    for (const room of socket.rooms) if (room !== socket.id) await socket.leave(room);
    const scope = result.scope!;
    await socket.join([
      scope === 'all'
        ? rooms.all(orgId.toLowerCase())
        : rooms.user(orgId.toLowerCase(), data.user.id),
      rooms.staff(orgId.toLowerCase()),
    ]);
    data.org = { orgId: orgId.toLowerCase(), scope };
    return result;
  }

  /** Staff typing in a web chat thread: the visitor sees "typing…". */
  @SubscribeMessage('typing')
  async typing(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<void> {
    const data = socket.data as AgentData;
    const id = (body as { conversationId?: unknown } | undefined)?.conversationId;
    if (!data.user || !data.org || typeof id !== 'string' || !Types.ObjectId.isValid(id)) return;
    const now = Date.now();
    if (data.lastTyping && now - data.lastTyping < TYPING_EVERY_MS) return;
    data.lastTyping = now;
    const { orgId, scope } = data.org;
    const userId = data.user.id;
    await RequestContext.withTenant(
      orgId,
      async () => {
        const conv = await this.conversations.findOne({
          _id: new Types.ObjectId(id),
          ...(scope === 'assigned' ? { assigneeId: new Types.ObjectId(userId) } : {}),
        });
        if (!conv || conv.channelType !== 'web_chat') return;
        const contact = await this.contacts.findById(conv.contactId);
        if (contact) await this.realtime.visitorTyping(conv.channelId, contact.externalId, true);
      },
      { type: 'user', id: userId },
    );
  }

  /** Drops sockets whose session ended or whose role no longer allows the inbox. */
  private async revalidate(): Promise<void> {
    if (!this.ns) return;
    for (const socket of this.ns.sockets.values()) {
      const data = socket.data as AgentData;
      if (!data.user) continue;
      try {
        let ok = await this.sessions.isActive(data.user.sid);
        if (ok && data.org) {
          const result = await this.scopeFor(data.org.orgId, data.user.id);
          ok = result.ok && result.scope === data.org.scope;
        }
        if (!ok) {
          socket.emit('revoked');
          socket.disconnect(true);
        }
      } catch (err) {
        this.logger.warn({ err }, 'socket revalidation failed');
      }
    }
  }
}

interface VisitorData {
  channelId?: string;
  visitorId?: string;
  lastTyping?: number;
}

/** Live chat for website visitors, authenticated with the visitor token. */
@WebSocketGateway({ namespace: 'webchat' })
export class WebchatGateway implements OnGatewayInit {
  constructor(
    private readonly relay: RealtimeRelay,
    private readonly webchat: WebchatService,
  ) {}

  afterInit(ns: Namespace): void {
    this.relay.register('webchat', ns);
    ns.use((socket, next) => {
      const auth = socket.handshake.auth as { token?: unknown } | undefined;
      const token = typeof auth?.token === 'string' ? auth.token : undefined;
      const visitor = this.webchat.verifySocketToken(token);
      if (!visitor) return next(connectError('visitor_token_invalid'));
      Object.assign(socket.data as VisitorData, visitor);
      void Promise.resolve(socket.join(rooms.visitor(visitor.channelId, visitor.visitorId))).then(
        () => next(),
        () => next(connectError('unavailable')),
      );
    });
  }

  @SubscribeMessage('typing')
  async typing(@ConnectedSocket() socket: Socket): Promise<void> {
    const data = socket.data as VisitorData;
    if (!data.channelId || !data.visitorId) return;
    const now = Date.now();
    if (data.lastTyping && now - data.lastTyping < TYPING_EVERY_MS) return;
    data.lastTyping = now;
    await this.webchat.visitorTyping(data.channelId, data.visitorId);
  }
}
