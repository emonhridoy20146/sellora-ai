import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { randomToken } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/validation/schemas.js';
import { AppConfig } from '../../config/app-config.js';
import { UrlSigner } from '../../infra/storage/signing.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { ChannelsService, type ChannelDoc } from './channels.service.js';
import { InboxRealtime } from './inbox-realtime.service.js';
import {
  CUSTOMER_VISIBLE_TYPES,
  toVisitorMessageDto,
  type ContactDoc,
  type VisitorMessageDto,
} from './inbox.mappers.js';
import { MessagingService } from './messaging.service.js';
import { ContactRepository, ConversationRepository, MessageRepository } from './repositories.js';

/** Visitor tokens last 180 days; the widget renews them on every visit. */
const TOKEN_TTL_SECONDS = 180 * 24 * 3600;

interface VisitorClaims {
  k: 'wv';
  /** Channel id. */
  c: string;
  /** Visitor id: the contact's externalId on the web chat channel. */
  v: string;
  exp: number;
}

export interface Visitor {
  channel: ChannelDoc;
  orgId: string;
  visitorId: string;
  businessName: string;
}

/**
 * The website chat as a visitor sees it. A visitor is identified by a signed token the
 * widget keeps in its own storage; there is no account and no cookie.
 */
@Injectable()
export class WebchatService {
  private readonly logger = new Logger(WebchatService.name);
  private readonly signer: UrlSigner;

  constructor(
    config: AppConfig,
    private readonly channels: ChannelsService,
    private readonly orgs: OrgsService,
    private readonly entitlements: EntitlementsService,
    private readonly messaging: MessagingService,
    private readonly contacts: ContactRepository,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly realtime: InboxRealtime,
    private readonly limits: RateLimitService,
  ) {
    const secret = config.get('WEBCHAT_TOKEN_SECRET');
    if (!secret)
      this.logger.warn(
        'WEBCHAT_TOKEN_SECRET is not set; visitor sessions end when the API restarts',
      );
    this.signer = new UrlSigner(secret ?? randomToken(32));
  }

  /** The channel behind a widget key, when it may take chats right now. */
  async open(publicKey: string): Promise<{ channel: ChannelDoc; businessName: string }> {
    const channel = await this.channels.findWebChatByKey(publicKey);
    const unavailable = () => AppError.notFound('chat', 'This chat is not available right now.');
    if (!channel || channel.status !== 'active' || !channel.webChat) throw unavailable();
    const orgId = channel.orgId.toHexString();
    const org = await this.orgs.get(orgId).catch(() => null);
    if (!org || org.status === 'suspended') throw unavailable();
    if (!(await this.entitlements.hasModule(orgId, 'inbox'))) throw unavailable();
    return { channel, businessName: org.name };
  }

  async config(publicKey: string) {
    const { channel, businessName } = await this.open(publicKey);
    const wc = channel.webChat!;
    return {
      businessName,
      greeting: wc.greeting,
      color: wc.color,
      askContact: wc.askContact,
      allowedOrigins: wc.allowedOrigins,
    };
  }

  private issue(channelId: string, visitorId: string): string {
    return this.signer.sign({
      k: 'wv',
      c: channelId,
      v: visitorId,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    });
  }

  private readClaims(token: string | undefined): VisitorClaims | null {
    if (!token) return null;
    const claims = this.signer.verify<VisitorClaims>(token);
    if (
      !claims ||
      claims.k !== 'wv' ||
      typeof claims.v !== 'string' ||
      typeof claims.c !== 'string'
    )
      return null;
    return claims;
  }

  /** Resolves a visitor token for the widget key. Throws 401 when it does not fit. */
  async visitor(publicKey: string, token: string | undefined): Promise<Visitor> {
    const { channel, businessName } = await this.open(publicKey);
    const claims = this.readClaims(token);
    if (!claims || claims.c !== channel._id.toHexString())
      throw AppError.unauthorized('visitor_token_invalid', 'Start the chat again.');
    return { channel, orgId: channel.orgId.toHexString(), visitorId: claims.v, businessName };
  }

  /** For the live connection: the visitor's room, or null. */
  verifySocketToken(token: string | undefined): { channelId: string; visitorId: string } | null {
    const claims = this.readClaims(token);
    if (!claims || !Types.ObjectId.isValid(claims.c)) return null;
    return { channelId: claims.c, visitorId: claims.v };
  }

  private inTenant<T>(v: Pick<Visitor, 'orgId' | 'visitorId'>, fn: () => Promise<T>): Promise<T> {
    return RequestContext.withTenant(v.orgId, fn, { type: 'visitor', id: v.visitorId });
  }

  private async findContact(v: Visitor): Promise<ContactDoc | null> {
    return this.contacts.findOne({ channelId: v.channel._id, externalId: v.visitorId });
  }

  private contactView(c: ContactDoc | null) {
    return c ? { name: c.name || null, phone: c.phone ?? null, email: c.email ?? null } : null;
  }

  /**
   * Starts or resumes a chat. A valid earlier token keeps the visitor's history; anything
   * else starts a new visitor. The token is renewed either way.
   */
  async session(publicKey: string, token?: string) {
    const { channel, businessName } = await this.open(publicKey);
    const claims = this.readClaims(token);
    const visitorId =
      claims && claims.c === channel._id.toHexString() ? claims.v : `v_${randomToken(16)}`;
    const v: Visitor = { channel, orgId: channel.orgId.toHexString(), visitorId, businessName };
    return this.inTenant(v, async () => {
      const contact = await this.findContact(v);
      return {
        token: this.issue(channel._id.toHexString(), visitorId),
        contact: this.contactView(contact),
        messages: contact ? await this.recent(v, contact) : [],
      };
    });
  }

  private async recent(
    v: Visitor,
    contact: ContactDoc,
    before?: string,
    limit = 30,
  ): Promise<VisitorMessageDto[]> {
    const conv = await this.conversations.findOne({ contactId: contact._id });
    if (!conv) return [];
    const list = await this.messages.find(
      {
        conversationId: conv._id,
        type: { $in: [...CUSTOMER_VISIBLE_TYPES] },
        ...(before ? { _id: { $lt: new Types.ObjectId(before) } } : {}),
      },
      { sort: { _id: -1 }, limit },
    );
    return list.reverse().map((m) => toVisitorMessageDto(m, v.businessName));
  }

  async history(v: Visitor, before: string | undefined, limit: number) {
    return this.inTenant(v, async () => {
      const contact = await this.findContact(v);
      return { messages: contact ? await this.recent(v, contact, before, limit) : [] };
    });
  }

  async send(v: Visitor, input: { text: string; clientId: string }, ip?: string) {
    await this.limits.consume('webchat:visitor', `${v.channel._id.toHexString()}:${v.visitorId}`);
    if (ip) await this.limits.consume('webchat:ip', ip);
    return this.inTenant(v, async () => {
      const result = await this.messaging.receiveInbound(
        v.channel,
        { externalId: v.visitorId },
        { type: 'text', text: input.text, clientId: input.clientId },
      );
      return { message: toVisitorMessageDto(result.message, v.businessName) };
    });
  }

  /** The visitor's name, phone or email, from the widget's form. */
  async setContact(v: Visitor, input: { name?: string; phone?: string; email?: string }) {
    await this.limits.consume('webchat:visitor', `${v.channel._id.toHexString()}:${v.visitorId}`);
    return this.inTenant(v, async () => {
      const set: Record<string, unknown> = { lastSeenAt: new Date() };
      if (input.name) set.name = input.name;
      if (input.email) set.email = input.email;
      if (input.phone) {
        const org = await this.orgs.get(v.orgId);
        const phone = normalizePhone(input.phone, org.country);
        if (!phone)
          throw AppError.validation([{ path: 'phone', message: 'Enter a valid phone number' }]);
        set.phone = phone;
      }
      const contact = await this.contacts.findOneAndUpdate(
        { channelId: v.channel._id, externalId: v.visitorId },
        { $set: set },
        { upsert: true },
      );
      const conv = contact ? await this.conversations.findOne({ contactId: contact._id }) : null;
      if (conv) await this.messaging.publishConversation(conv, { contact });
      return { contact: this.contactView(contact) };
    });
  }

  /** The visitor is typing: tell the staff who can see the conversation. */
  async visitorTyping(channelId: string, visitorId: string): Promise<void> {
    const channel = await this.channels.findAnyById(channelId);
    if (!channel) return;
    const orgId = channel.orgId.toHexString();
    await this.inTenant({ orgId, visitorId }, async () => {
      const contact = await this.contacts.findOne({
        channelId: channel._id,
        externalId: visitorId,
      });
      const conv = contact && (await this.conversations.findOne({ contactId: contact._id }));
      if (!conv || conv.limitedMonth === (await this.messaging.currentMonth())) return;
      await this.realtime.staffTyping(orgId, conv.assigneeId, {
        conversationId: conv._id.toHexString(),
        who: 'contact',
      });
    });
  }
}
