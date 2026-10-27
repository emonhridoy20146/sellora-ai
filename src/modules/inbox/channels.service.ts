import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { randomToken } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ChannelRepository } from './repositories.js';
import type { Channel, ChannelStatus } from './schemas.js';

export type ChannelDoc = WithId<Channel>;

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
    account: c.meta ? { externalId: c.meta.externalId, displayName: c.meta.displayName } : null,
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
    const enabled = await this.channels.count({ status: { $ne: 'disabled' } });
    await this.entitlements.assertWithinLimit(this.orgId(), 'channels', enabled);
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
    if (patch.status !== undefined) {
      set.status = patch.status;
      if (patch.status === 'active') set.statusReason = undefined;
    }
    for (const [key, value] of Object.entries(patch.webChat ?? {}))
      if (value !== undefined) set[`webChat.${key}`] = value;
    if (Object.keys(set).length === 0) return channel;

    const updated = await this.channels.findOneAndUpdate({ _id: channel._id }, { $set: set });
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
