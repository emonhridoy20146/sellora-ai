import { Injectable, Logger } from '@nestjs/common';
import { RequestContext, type Actor } from '../../common/context/request-context.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ChannelsService, type ChannelDoc } from '../inbox/channels.service.js';
import type { ContactDoc, ConversationDoc } from '../inbox/inbox.mappers.js';
import { MessagingService } from '../inbox/messaging.service.js';
import { ContactRepository } from '../inbox/repositories.js';
import { parseMetaWebhook, type MetaEvent } from './meta-events.js';
import { MetaGraph } from './meta-graph.js';
import { CHANNEL_NAME } from './meta.types.js';

const ACTOR: Actor = { type: 'system', id: 'meta-webhook' };
const PROFILE_TIMEOUT_MS = 4_000;

export type InboundOutcome =
  | 'stored'
  | 'duplicate'
  | 'unknown_account'
  | 'channel_off'
  | 'own_echo'
  | 'echo_stored'
  | 'echo_ignored'
  | 'status';

/**
 * Turns verified webhook deliveries into inbox messages, staff replies sent from Meta's own
 * apps, and delivery reports. Each event is matched to the channel connected to its page,
 * Instagram account or WhatsApp number and handled inside that business's tenant scope;
 * events for accounts nobody connected are dropped.
 */
@Injectable()
export class MetaInbound {
  private readonly logger = new Logger(MetaInbound.name);

  constructor(
    private readonly graph: MetaGraph,
    private readonly channels: ChannelsService,
    private readonly messaging: MessagingService,
    private readonly contacts: ContactRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  async handleWebhook(body: unknown): Promise<InboundOutcome[]> {
    const outcomes: InboundOutcome[] = [];
    for (const event of parseMetaWebhook(body)) outcomes.push(await this.handle(event));
    return outcomes;
  }

  async handle(event: MetaEvent): Promise<InboundOutcome> {
    const channel = await this.channels.findMetaAccount(event.channelType, event.accountId);
    if (!channel) {
      this.logger.debug({ type: event.channelType }, 'Webhook for an account nobody connected');
      return 'unknown_account';
    }
    return RequestContext.withTenant(
      channel.orgId.toHexString(),
      () => {
        switch (event.kind) {
          case 'message':
            return this.message(channel, event);
          case 'echo':
            return this.echo(channel, event);
          case 'status':
            return this.status(channel, event);
        }
      },
      ACTOR,
    );
  }

  private async message(
    channel: ChannelDoc,
    e: Extract<MetaEvent, { kind: 'message' }>,
  ): Promise<InboundOutcome> {
    // A channel the merchant turned off takes no new conversations.
    if (channel.status === 'disabled') return 'channel_off';
    const now = new Date();
    const at = e.at.getTime() <= now.getTime() ? e.at : now;
    const result = await this.messaging.receiveInbound(
      channel,
      {
        externalId: e.senderId,
        ...(e.profileName ? { name: e.profileName } : {}),
        ...(e.channelType === 'whatsapp' ? { phone: `+${e.senderId}` } : {}),
      },
      { externalId: e.messageId, type: e.type, text: e.text, attachments: e.attachments },
      at,
    );
    if (result.duplicate) return 'duplicate';
    if (!result.contact.name && e.channelType !== 'whatsapp')
      await this.fillProfile(channel, result.contact, result.conversation);
    return 'stored';
  }

  /** Messenger and Instagram do not send names with messages; ask once for the profile. */
  private async fillProfile(
    channel: ChannelDoc,
    contact: ContactDoc,
    conversation: ConversationDoc,
  ): Promise<void> {
    try {
      const token = this.channels.metaToken(channel);
      const fields =
        channel.type === 'instagram'
          ? 'name,username,profile_pic'
          : 'first_name,last_name,profile_pic';
      const p = await this.graph.get<{
        first_name?: string;
        last_name?: string;
        name?: string;
        username?: string;
        profile_pic?: string;
      }>(contact.externalId, token, { fields }, { timeoutMs: PROFILE_TIMEOUT_MS });
      const full = p.name?.trim() || [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
      const name = full || (p.username ? `@${p.username}` : '');
      if (!name && !p.profile_pic) return;
      const set: Record<string, string> = {};
      if (name) set.name = name.slice(0, 120);
      if (p.profile_pic?.startsWith('https://')) set.avatarUrl = p.profile_pic;
      const updated = await this.contacts.findOneAndUpdate(
        { _id: contact._id, name: '' },
        { $set: set },
      );
      if (updated) await this.messaging.publishConversation(conversation, { contact: updated });
    } catch (err) {
      // Names are a nicety; the message is already stored.
      this.logger.debug({ err, channelId: channel._id }, 'Could not load a customer profile');
    }
  }

  /**
   * A message the page sent from somewhere else (the Facebook page inbox, the Instagram
   * app). It is shown in the thread, and the AI steps back as it would for a reply here.
   */
  private async echo(
    channel: ChannelDoc,
    e: Extract<MetaEvent, { kind: 'echo' }>,
  ): Promise<InboundOutcome> {
    const ourApp = this.graph.appIdOrNull();
    if (ourApp && e.appId === ourApp) return 'own_echo';
    const where = CHANNEL_NAME[e.channelType];
    const stored = await this.messaging.recordSentElsewhere(channel, e.recipientId, {
      externalId: e.messageId,
      text: e.text || 'Sent an attachment',
      senderName: `Sent from ${where}`,
    });
    if (!stored) return 'echo_ignored';
    const aiOn =
      channel.aiEnabled &&
      (await this.entitlements.hasModule(channel.orgId.toHexString(), 'ai_agent'));
    if (aiOn && stored.conversation.ai.mode === 'auto')
      await this.messaging.pauseAi(
        stored.conversation,
        stored.contact,
        { type: 'system', id: 'meta', name: where },
        'replied_elsewhere',
        `Someone replied from ${where} outside Sellora, so the AI paused.`,
      );
    return 'echo_stored';
  }

  private async status(
    channel: ChannelDoc,
    e: Extract<MetaEvent, { kind: 'status' }>,
  ): Promise<InboundOutcome> {
    if (e.messageId) {
      await this.messaging.updateDelivery(
        { channelId: channel._id, externalId: e.messageId },
        e.status,
        e.error ? { error: e.error } : {},
      );
    } else if (e.watermark && e.contactId && (e.status === 'delivered' || e.status === 'read')) {
      await this.messaging.updateDeliveryUpTo(channel._id, e.contactId, e.status, e.watermark);
    }
    return 'status';
  }
}
