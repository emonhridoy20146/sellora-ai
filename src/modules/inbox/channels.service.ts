import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { randomToken } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ChannelRepository } from './repositories.js';
import type { Channel, ChannelStatus, ChannelType } from './schemas.js';

export type ChannelDoc = WithId<Channel>;

/** Emitted after a channel is removed, with the removed document (Meta unsubscribes). */
export const INBOX_CHANNEL_REMOVED = 'inbox.channel.removed';

export interface InboxChannelRemovedEvent {
  orgId: string;
  channel: ChannelDoc;
}

/** A Messenger page, Instagram account or WhatsApp number being connected. */
export interface MetaConnectInput {
  type: Exclude<ChannelType, 'web_chat'>;
  externalId: string;
  displayName: string;
  accessToken: string;
  pageId?: string;
  username?: string;
  wabaId?: string;
}

/** Tokens are bound to the account they belong to, so a copied ciphertext is useless elsewhere. */
const tokenAad = (type: ChannelType, externalId: string) => `meta:${type}:${externalId}`;

export interface WebChatInput {
  name: string;
  allowedOrigins?: string[];
  greeting?: string;
  color?: string;
  askContact?: boolean;
  aiEnabled?: boolean;
}

export interface ChannelPatch {
  name?: string;
  status?: Exclude<ChannelStatus, 'error'>;
  aiEnabled?: boolean;
  webChat?: Partial<Omit<WebChatInput, 'name' | 'aiEnabled'>>;
}

export function toChannelDto(c: ChannelDoc) {
  return {
    id: c._id.toHexString(),
    type: c.type,
    name: c.name,
    status: c.status,
    statusReason: c.statusReason ?? null,
    aiEnabled: c.aiEnabled,
    webChat: c.webChat
      ? {
          publicKey: c.webChat.publicKey,
          allowedOrigins: c.webChat.allowedOrigins,
          greeting: c.webChat.greeting,
          color: c.webChat.color,
          askContact: c.webChat.askContact,
        }
      : null,
    // Access tokens never leave the server.
    account: c.meta
      ? {
          externalId: c.meta.externalId,
          displayName: c.meta.displayName,
          username: c.meta.username ?? null,
          pageId: c.meta.pageId ?? null,
          wabaId: c.meta.wabaId ?? null,
        }
      : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Web chat keys look like "wc_" + 24 random characters. */
export const WEB_CHAT_KEY = /^wc_[A-Za-z0-9_-]{24}$/;

/**
 * Places customers write from. Enabled channels count against the plan's `channels` limit;
 * disabling one frees its slot and keeps its conversations.
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly channels: ChannelRepository,
    @InjectModel('Channel') private readonly channelModel: Model<Channel>,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly events: EventEmitter2,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  list(): Promise<ChannelDoc[]> {
    return this.channels.find({}, { sort: { createdAt: 1 } });
  }

  async get(id: string): Promise<ChannelDoc> {
    const channel = await this.channels.findById(id);
    if (!channel) throw AppError.notFound('channel');
    return channel;
  }

  /** The channel, or null when it was removed (its conversations stay readable). */
  find(id: string): Promise<ChannelDoc | null> {
    return this.channels.findById(id);
  }

  private async assertRoomForOneMore(): Promise<void> {
    await this.assertRoomFor(1);
  }

  /** Throws 402 unless the plan's channel limit leaves room for `count` more enabled channels. */
  async assertRoomFor(count: number): Promise<void> {
    if (count < 1) return;
    const enabled = await this.channels.count({ status: { $ne: 'disabled' } });
    await this.entitlements.assertWithinLimit(this.orgId(), 'channels', enabled + count - 1);
  }

  async createWebChat(input: WebChatInput): Promise<ChannelDoc> {
    await this.assertRoomForOneMore();
    const actor = RequestContext.actor();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const channel = await this.channels.create({
          type: 'web_chat',
          name: input.name,
          status: 'active',
          aiEnabled: input.aiEnabled ?? true,
          webChat: {
            publicKey: `wc_${randomToken(18)}`,
            allowedOrigins: input.allowedOrigins ?? [],
            greeting: input.greeting ?? '',
            color: input.color ?? '#2563eb',
            askContact: input.askContact ?? true,
          },
          ...(actor.type === 'user' ? { createdBy: new Types.ObjectId(actor.id) } : {}),
        });
        await this.audit.record({
          action: 'inbox.channel.created',
          orgId: this.orgId(),
          target: { type: 'channel', id: channel._id.toHexString(), label: channel.name },
          metadata: { type: 'web_chat' },
        });
        return channel;
      } catch (err) {
        // A key collision is astronomically unlikely; retry once rather than fail.
        if (!isDuplicateKey(err) || attempt > 0) throw err;
      }
    }
  }

  async update(id: string, patch: ChannelPatch): Promise<ChannelDoc> {
    const channel = await this.get(id);
    if (patch.webChat && channel.type !== 'web_chat')
      throw AppError.validation([
        { path: 'webChat', message: 'Only web chat channels have widget settings' },
      ]);
    if (patch.status === 'active' && channel.status === 'disabled')
      await this.assertRoomForOneMore();

    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.aiEnabled !== undefined) set.aiEnabled = patch.aiEnabled;
    if (patch.status !== undefined) set.status = patch.status;
    for (const [key, value] of Object.entries(patch.webChat ?? {}))
      if (value !== undefined) set[`webChat.${key}`] = value;
    if (Object.keys(set).length === 0) return channel;

    // Mongoose drops `undefined` from $set, so a stale reason must be unset explicitly.
    const updated = await this.channels.findOneAndUpdate(
      { _id: channel._id },
      patch.status === 'active' ? { $set: set, $unset: { statusReason: 1 } } : { $set: set },
    );
    if (!updated) throw AppError.notFound('channel');
    await this.audit.record({
      action: 'inbox.channel.updated',
      orgId: this.orgId(),
      target: { type: 'channel', id, label: updated.name },
      metadata: { fields: Object.keys(set) },
    });
    return updated;
  }

  /** Removes the channel. Its conversations stay in the inbox as history. */
  async remove(id: string): Promise<void> {
    const channel = await this.get(id);
    await this.channels.deleteOne({ _id: channel._id });
    await this.audit.record({
      action: 'inbox.channel.deleted',
      orgId: this.orgId(),
      target: { type: 'channel', id, label: channel.name },
    });
    const event: InboxChannelRemovedEvent = { orgId: this.orgId(), channel };
    this.events.emit(INBOX_CHANNEL_REMOVED, event);
  }

  // ------------------------------------------------------------------ Meta accounts

  /**
   * Connects a Messenger page, Instagram account or WhatsApp number, or refreshes the token
   * of one this business already connected. An account belongs to one business only.
   */
  async connectMeta(input: MetaConnectInput): Promise<{ channel: ChannelDoc; created: boolean }> {
    const owner = await this.findMetaAccount(input.type, input.externalId);
    if (owner && owner.orgId.toHexString() !== this.orgId())
      throw AppError.conflict(
        'account_connected_elsewhere',
        'This account is already connected to another business on this platform. Remove it there first.',
      );
    const meta = {
      externalId: input.externalId,
      displayName: input.displayName,
      accessTokenEnc: this.encryption.encrypt(
        input.accessToken,
        tokenAad(input.type, input.externalId),
      ),
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.wabaId ? { wabaId: input.wabaId } : {}),
    };

    if (owner) {
      // A reconnect fixes a rejected token; a channel the merchant turned off stays off.
      const fixes = owner.status === 'error';
      const updated = await this.channels.findOneAndUpdate(
        { _id: owner._id },
        fixes
          ? { $set: { meta, status: 'active' }, $unset: { statusReason: 1 } }
          : { $set: { meta } },
      );
      if (!updated) throw AppError.notFound('channel');
      await this.audit.record({
        action: 'inbox.channel.reconnected',
        orgId: this.orgId(),
        target: { type: 'channel', id: updated._id.toHexString(), label: updated.name },
        metadata: { type: input.type },
      });
      return { channel: updated, created: false };
    }

    await this.assertRoomForOneMore();
    const actor = RequestContext.actor();
    let channel: ChannelDoc;
    try {
      channel = await this.channels.create({
        type: input.type,
        name: input.displayName,
        status: 'active',
        aiEnabled: true,
        meta,
        ...(actor.type === 'user' ? { createdBy: new Types.ObjectId(actor.id) } : {}),
      });
    } catch (err) {
      // Connected by someone else in the same moment.
      if (isDuplicateKey(err))
        throw AppError.conflict(
          'account_connected_elsewhere',
          'This account was just connected by someone else. Refresh and try again.',
        );
      throw err;
    }
    await this.audit.record({
      action: 'inbox.channel.created',
      orgId: this.orgId(),
      target: { type: 'channel', id: channel._id.toHexString(), label: channel.name },
      metadata: { type: input.type },
    });
    return { channel, created: true };
  }

  /** The decrypted access token of a Meta channel. */
  metaToken(channel: Pick<ChannelDoc, 'type' | 'meta'>): string {
    if (!channel.meta) throw new Error('not a Meta channel');
    return this.encryption.decrypt(
      channel.meta.accessTokenEnc,
      tokenAad(channel.type, channel.meta.externalId),
    );
  }

  /** Meta rejected the channel's token: replies stop until someone reconnects it. */
  async markNeedsReconnect(channelId: Types.ObjectId, reason: string): Promise<ChannelDoc | null> {
    const updated = await this.channels.findOneAndUpdate(
      { _id: channelId, status: 'active' },
      { $set: { status: 'error', statusReason: reason } },
    );
    if (updated)
      await this.audit.record({
        action: 'inbox.channel.needs_reconnect',
        orgId: this.orgId(),
        target: { type: 'channel', id: channelId.toHexString(), label: updated.name },
        metadata: { reason },
      });
    return updated;
  }

  /** The channel connected to a page, Instagram account or WhatsApp number, from any business. */
  async findMetaAccount(type: ChannelType, externalId: string): Promise<ChannelDoc | null> {
    if (!externalId) return null;
    return this.channelModel
      .findOne({ type, 'meta.externalId': externalId }, null, { [CROSS_TENANT]: true })
      .lean<ChannelDoc>()
      .exec();
  }

  /** Other channels of this business that use the same page or WhatsApp account. */
  async siblingsOf(channel: ChannelDoc): Promise<ChannelDoc[]> {
    const or: Record<string, unknown>[] = [];
    if (channel.meta?.pageId) or.push({ 'meta.pageId': channel.meta.pageId });
    if (channel.meta?.wabaId) or.push({ 'meta.wabaId': channel.meta.wabaId });
    if (!or.length) return [];
    return this.channels.find({ _id: { $ne: channel._id }, $or: or });
  }

  /** The web chat channel behind a widget key, from any business. */
  async findWebChatByKey(publicKey: string): Promise<ChannelDoc | null> {
    if (!WEB_CHAT_KEY.test(publicKey)) return null;
    return this.channelModel
      .findOne({ 'webChat.publicKey': publicKey, type: 'web_chat' }, null, {
        [CROSS_TENANT]: true,
      })
      .lean<ChannelDoc>()
      .exec();
  }

  /** A channel by id from any business (live connections, webhooks). */
  async findAnyById(id: string): Promise<ChannelDoc | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.channelModel
      .findOne({ _id: new Types.ObjectId(id) }, null, { [CROSS_TENANT]: true })
      .lean<ChannelDoc>()
      .exec();
  }
}
