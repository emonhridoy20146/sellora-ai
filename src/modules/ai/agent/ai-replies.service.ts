import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import { RequestContext, type Actor } from '../../../common/context/request-context.js';
import { AppError } from '../../../common/errors/app-error.js';
import { EntitlementsService } from '../../billing/entitlements.service.js';
import { OrdersService } from '../../commerce/orders.service.js';
import { ProductsService, type ProductDoc } from '../../commerce/products.service.js';
import { ShopSettingsService } from '../../commerce/shop-settings.service.js';
import { ChannelsService, type ChannelDoc } from '../../inbox/channels.service.js';
import { InboxRealtime } from '../../inbox/inbox-realtime.service.js';
import type { ContactDoc, ConversationDoc, MessageDoc } from '../../inbox/inbox.mappers.js';
import { MessagingService } from '../../inbox/messaging.service.js';
import {
  ContactRepository,
  ConversationRepository,
  MessageRepository,
} from '../../inbox/repositories.js';
import type { ChannelType, ConversationAi, MessageType } from '../../inbox/schemas.js';
import { OrgsService } from '../../orgs/orgs.service.js';
import { AiAgentSettingsService, type AiAgentSettingsDoc } from '../agent-settings.service.js';
import type { AiAgentSettings } from '../agent-settings.schema.js';
import { AiProviderError, type AiMessage } from '../provider/ai-provider.js';
import { AiProviders } from '../provider/ai-providers.service.js';
import {
  buildAgentPrompt,
  type CatalogLine,
  type PromptCatalog,
  type PromptCustomer,
} from './agent-prompt.js';
import { AgentRunner, type AgentRunResult } from './agent-runner.js';
import { toAgentHistory } from './agent-history.js';
import { AgentTools, type ToolRunContext } from './agent-tools.js';
import { handoverNotice, matchKeyword, toChatText } from './chat-text.js';
import { AiReplyQueue, type AiReplyJob } from './reply-queue.js';

/** Emitted when the AI hands a conversation to people. */
export const AI_HANDOVER = 'ai.handover';

export const AI_ACTOR: Actor = { type: 'system', id: 'ai-agent' };

const CATALOG_IN_PROMPT = 30;
const HISTORY_MESSAGES = 40;
const TYPING_PULSE_MS = 3_000;
/** Messages the customer sees (notes and system lines stay with the team). */
const VISIBLE_TYPES: MessageType[] = ['text', 'image', 'file'];

const CHANNEL_LABEL: Record<ChannelType, string> = {
  web_chat: 'the website chat',
  messenger: 'Facebook Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
};

/** Why the AI stopped answering a conversation, as stored on it. */
export type PauseReason =
  | 'ai_handover'
  | 'keyword'
  | 'reply_limit'
  | 'no_credits'
  | 'ai_unavailable'
  | 'ai_error'
  | 'ai_refused'
  | 'ai_incomplete';

const PAUSE_LINE: Record<PauseReason, string> = {
  ai_handover: 'The AI handed this chat to the team',
  keyword: 'The customer used a handover keyword, so the AI handed this chat to the team',
  reply_limit: 'The AI reached its daily reply limit for this chat and handed it to the team',
  no_credits:
    'The AI paused: the AI credit balance is used up. Top up in Billing, then turn the AI back on here',
  ai_unavailable: 'The AI could not reply because the AI service is unavailable right now',
  ai_error: 'The AI could not reply after several tries and handed this chat to the team',
  ai_refused: 'The AI could not answer this message and handed the chat to the team',
  ai_incomplete: 'The AI could not finish an answer and handed the chat to the team',
};

export type ReplyOutcome =
  | { status: 'replied'; messageId: string; credits: number; handover: boolean }
  | { status: 'handed_over'; reason: PauseReason }
  | { status: 'skipped'; reason: string };

interface Thread {
  orgId: string;
  settings: AiAgentSettingsDoc;
  conversation: ConversationDoc;
  contact: ContactDoc;
  channel: ChannelDoc;
  /** Customer-visible messages, oldest first. */
  history: MessageDoc[];
  /** Customer messages since the business last answered. */
  pending: MessageDoc[];
}

export interface PreviewInput {
  messages: { from: 'customer' | 'assistant'; text: string }[];
  /** Unsaved changes from the settings form, so they can be tried before saving. */
  draft?: Partial<
    Pick<
      AiAgentSettings,
      | 'assistantName'
      | 'tone'
      | 'language'
      | 'tier'
      | 'businessInfo'
      | 'instructions'
      | 'faqs'
      | 'takeOrders'
    >
  >;
}

/**
 * The AI sales agent's replies in the inbox: decides whether to answer, builds what the
 * agent knows, runs it, posts the reply on the channel and hands the chat to people when
 * it should. Runs in the worker (BullMQ) and, for the settings page's test chat, in the API.
 */
@Injectable()
export class AiRepliesService {
  private readonly logger = new Logger(AiRepliesService.name);

  constructor(
    private readonly settings: AiAgentSettingsService,
    private readonly runner: AgentRunner,
    private readonly tools: AgentTools,
    private readonly providers: AiProviders,
    private readonly queue: AiReplyQueue,
    private readonly messaging: MessagingService,
    private readonly realtime: InboxRealtime,
    private readonly channels: ChannelsService,
    private readonly conversations: ConversationRepository,
    private readonly contacts: ContactRepository,
    private readonly messages: MessageRepository,
    private readonly products: ProductsService,
    private readonly orders: OrdersService,
    private readonly shopSettings: ShopSettingsService,
    private readonly orgs: OrgsService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventEmitter2,
  ) {}

  // ------------------------------------------------------------------ scheduling

  /** Schedules a reply to a new customer message, after the business's reply delay. */
  async onCustomerMessage(e: {
    orgId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const settings = await RequestContext.withTenant(e.orgId, () => this.settings.find(), AI_ACTOR);
    if (!settings?.enabled) return;
    // Only the ids go into the job; the event carries more than the worker needs.
    const job = { orgId: e.orgId, conversationId: e.conversationId, messageId: e.messageId };
    await this.queue.schedule(job, settings.replyDelaySeconds * 1000);
  }

  /** The AI was turned back on: answer the customer if they are waiting for a reply. */
  async onResumed(e: { orgId: string; conversationId: string }): Promise<void> {
    await RequestContext.withTenant(
      e.orgId,
      async () => {
        const settings = await this.settings.find();
        if (!settings?.enabled) return;
        const [last] = await this.messages.find(
          {
            conversationId: new Types.ObjectId(e.conversationId),
            type: { $in: VISIBLE_TYPES },
          },
          { sort: { _id: -1 }, limit: 1 },
        );
        if (last?.direction === 'in')
          await this.queue.schedule(
            { orgId: e.orgId, conversationId: e.conversationId, messageId: last._id.toHexString() },
            1_000,
          );
      },
      AI_ACTOR,
    );
  }

  /**
   * Runs one scheduled reply. Retryable failures are thrown back to the queue until the
   * last attempt; after that the conversation goes to people so the customer is not left
   * waiting.
   */
  async handleJob(job: AiReplyJob, opts: { finalAttempt: boolean }): Promise<ReplyOutcome> {
    if (!(await this.queue.isLatest(job.conversationId, job.messageId)))
      return { status: 'skipped', reason: 'superseded' };
    const token = randomUUID();
    if (!(await this.queue.lock(job.conversationId, token))) {
      const queued = await this.queue.requeueBusy(job);
      return { status: 'skipped', reason: queued ? 'busy' : 'busy_gave_up' };
    }
    try {
      return await RequestContext.withTenant(
        job.orgId,
        () => this.reply(job.conversationId, opts.finalAttempt),
        AI_ACTOR,
      );
    } finally {
      await this.queue.unlock(job.conversationId, token);
    }
  }

  // ------------------------------------------------------------------ replying

  private async loadThread(conversationId: string): Promise<Thread | string> {
    const orgId = RequestContext.tenant()!.orgId;
    const org = await this.orgs.get(orgId);
    if (org.status !== 'active') return 'org_inactive';
    if (!(await this.entitlements.hasModule(orgId, 'ai_agent'))) return 'module_not_in_plan';
    const settings = await this.settings.find();
    if (!settings?.enabled) return 'agent_off';
    if (!Types.ObjectId.isValid(conversationId)) return 'conversation_missing';
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) return 'conversation_missing';
    if (conversation.ai.mode !== 'auto') return 'ai_paused';
    if (conversation.limitedMonth === (await this.messaging.currentMonth())) return 'locked';
    const channel = await this.channels.find(conversation.channelId.toHexString());
    if (!channel || channel.status === 'disabled' || !channel.aiEnabled) return 'channel_off';
    // Sending on Messenger, Instagram and WhatsApp arrives with their connections.
    if (channel.type !== 'web_chat') return 'channel_send_unavailable';
    const contact = await this.contacts.findById(conversation.contactId);
    if (!contact) return 'contact_missing';

    const recent = await this.messages.find(
      { conversationId: conversation._id, type: { $in: VISIBLE_TYPES } },
      { sort: { _id: -1 }, limit: HISTORY_MESSAGES },
    );
    const history = recent.reverse();
    const lastOut = history.findLastIndex((m) => m.direction === 'out');
    const pending = history.slice(lastOut + 1);
    if (!pending.length) return 'nothing_to_answer';
    return { orgId, settings, conversation, contact, channel, history, pending };
  }

  private async reply(conversationId: string, finalAttempt: boolean): Promise<ReplyOutcome> {
    const thread = await this.loadThread(conversationId);
    if (typeof thread === 'string') return { status: 'skipped', reason: thread };
    const { settings, conversation, contact, channel, pending } = thread;
    const customerText = pending.map((m) => m.text).join('\n');

    const keyword = matchKeyword(customerText, settings.handoverKeywords);
    if (keyword) {
      await this.handover(thread, 'keyword', `The customer wrote "${keyword}".`, true);
      return { status: 'handed_over', reason: 'keyword' };
    }
    const repliesToday = await this.messages.count({
      conversationId: conversation._id,
      'sender.type': 'ai',
      createdAt: { $gte: new Date(Date.now() - 24 * 3600_000) },
    });
    if (repliesToday >= settings.maxRepliesPerDay) {
      await this.handover(thread, 'reply_limit', `${repliesToday} AI replies in 24 hours.`, true);
      return { status: 'handed_over', reason: 'reply_limit' };
    }

    const runId = `ai_${randomUUID()}`;
    const stopTyping = this.typingPulse(thread);
    let result: AgentRunResult;
    try {
      const toolContext: ToolRunContext = {
        mode: 'live',
        orgId: thread.orgId,
        currency: (await this.orgs.get(thread.orgId)).currency,
        takeOrders: settings.takeOrders,
        confirmOrders: settings.confirmOrders,
        conversation,
        contact,
        channelType: channel.type,
      };
      result = await this.runner.run({
        feature: 'ai_agent_reply',
        tier: settings.tier,
        system: await this.prompt(settings, channel.type, contact),
        messages: toAgentHistory(thread.history),
        tools: this.tools.specs(settings),
        toolContext,
        runId,
        reference: { type: 'conversation', id: conversation._id.toHexString() },
        endUserId: createHash('sha256')
          .update(`${thread.orgId}:${contact._id.toHexString()}`)
          .digest('hex')
          .slice(0, 32),
      });
      // Tools may have saved details to the contact.
      thread.contact = toolContext.contact ?? contact;
    } catch (err) {
      return await this.failed(thread, err, finalAttempt);
    } finally {
      stopTyping();
    }

    // A person may have taken over while the agent was thinking: their word stands.
    const current = await this.conversations.findById(conversation._id);
    if (!current || current.ai.mode !== 'auto') {
      this.logger.log({ conversationId, runId }, 'Dropped an AI reply: the AI was paused meanwhile');
      return { status: 'skipped', reason: 'paused_during_reply' };
    }
    const answeredMeanwhile = await this.messages.exists({
      conversationId: conversation._id,
      direction: 'out',
      type: { $in: VISIBLE_TYPES },
      _id: { $gt: thread.pending.at(-1)!._id },
    });
    if (answeredMeanwhile) return { status: 'skipped', reason: 'answered_meanwhile' };
    thread.conversation = current;

    if (result.kind !== 'reply') {
      const reason: PauseReason = result.kind === 'refusal' ? 'ai_refused' : 'ai_incomplete';
      await this.handover(thread, reason, result.handover?.summary ?? '', true, result.credits);
      return { status: 'handed_over', reason };
    }

    const text = toChatText(result.text) || handoverNotice(settings.handoverMessage, customerText);
    const { message, conversation: afterPost } = await this.messaging.postOutgoing(
      current,
      thread.contact,
      channel,
      {
        type: 'text',
        text,
        sender: { type: 'ai', name: this.assistantName(settings) },
        clientId: runId,
        ai: { requestId: runId, credits: result.credits },
      },
    );
    thread.conversation = afterPost;
    if (result.handover)
      await this.handover(thread, 'ai_handover', result.handover.summary, false);
    return {
      status: 'replied',
      messageId: message._id.toHexString(),
      credits: result.credits,
      handover: Boolean(result.handover),
    };
  }

  private async failed(thread: Thread, err: unknown, finalAttempt: boolean): Promise<ReplyOutcome> {
    if (err instanceof AppError && err.status === HttpStatus.PAYMENT_REQUIRED) {
      await this.handover(thread, 'no_credits', '', true);
      return { status: 'handed_over', reason: 'no_credits' };
    }
    const unavailable =
      (err instanceof AiProviderError && (err.kind === 'not_configured' || err.kind === 'auth')) ||
      (err instanceof AppError &&
        (err.code === 'ai_model_unavailable' || err.code === 'credit_rate_missing'));
    if (unavailable) {
      this.logger.error({ err, orgId: thread.orgId }, 'AI agent cannot run: AI service not set up');
      await this.handover(thread, 'ai_unavailable', '', true);
      return { status: 'handed_over', reason: 'ai_unavailable' };
    }
    // Provider hiccups and unexpected errors (a database blip) are worth another try.
    const retryable =
      (err instanceof AiProviderError && err.retryable) ||
      !(err instanceof AppError || err instanceof AiProviderError);
    if (retryable && !finalAttempt) throw err;
    this.logger.error({ err, orgId: thread.orgId }, 'AI reply failed');
    await this.handover(thread, 'ai_error', '', true);
    return { status: 'handed_over', reason: 'ai_error' };
  }

  /**
   * Hands the conversation to people: optionally tells the customer, pauses the AI, leaves
   * a line for the team and tells live clients.
   */
  private async handover(
    thread: Thread,
    reason: PauseReason,
    summary: string,
    notifyCustomer: boolean,
    credits = 0,
  ): Promise<void> {
    const { settings, channel } = thread;
    if (notifyCustomer) {
      // The customer hears that a person will answer; no AI is needed to say so.
      const customerText = thread.pending.map((m) => m.text).join('\n');
      try {
        const posted = await this.messaging.postOutgoing(
          thread.conversation,
          thread.contact,
          channel,
          {
            type: 'text',
            text: handoverNotice(settings.handoverMessage, customerText),
            sender: { type: 'ai', name: this.assistantName(settings) },
            ...(credits > 0 ? { ai: { requestId: `handover_${randomUUID()}`, credits } } : {}),
          },
        );
        thread.conversation = posted.conversation;
      } catch (err) {
        this.logger.warn({ err, reason }, 'Could not tell the customer about the handover');
      }
    }
    const ai: ConversationAi = {
      mode: 'paused',
      changedAt: new Date(),
      changedBy: { type: 'ai', id: AI_ACTOR.id, name: this.assistantName(settings) },
      reason,
    };
    const updated = await this.conversations.findOneAndUpdate(
      { _id: thread.conversation._id, 'ai.mode': 'auto' },
      { $set: { ai } },
    );
    if (!updated) return; // a person paused it first
    thread.conversation = updated;
    await this.messaging.systemLine(
      updated,
      thread.contact,
      summary ? `${PAUSE_LINE[reason]}: ${summary}` : `${PAUSE_LINE[reason]}.`,
    );
    await this.messaging.publishConversation(updated, { contact: thread.contact });
    this.events.emit(AI_HANDOVER, {
      orgId: thread.orgId,
      conversationId: updated._id.toHexString(),
      reason,
      summary,
    });
  }

  /** Shows "typing…" to the customer and the team while the agent works. */
  private typingPulse(thread: Thread): () => void {
    const pulse = () => {
      const { channel, contact, conversation } = thread;
      void this.realtime
        .visitorTyping(channel._id, contact.externalId, true)
        .catch(() => undefined);
      void this.realtime
        .staffTyping(thread.orgId, conversation.assigneeId, {
          conversationId: conversation._id.toHexString(),
          who: 'ai',
        })
        .catch(() => undefined);
    };
    pulse();
    const timer = setInterval(pulse, TYPING_PULSE_MS);
    return () => clearInterval(timer);
  }

  // ------------------------------------------------------------------ what the agent knows

  private assistantName(settings: Pick<AiAgentSettings, 'assistantName'>): string {
    return settings.assistantName.trim() || 'AI assistant';
  }

  private async catalog(): Promise<PromptCatalog> {
    const [{ products, totalActive }, categories] = await Promise.all([
      this.products.topActive(CATALOG_IN_PROMPT),
      this.products.listCategories(),
    ]);
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const line = (p: ProductDoc): CatalogLine => {
      const prices = p.variants.map((v) => v.priceMinor);
      const category = p.categoryId ? categoryName.get(p.categoryId.toHexString()) : undefined;
      return {
        id: p._id.toHexString(),
        name: p.name,
        minMinor: Math.min(...prices),
        maxMinor: Math.max(...prices),
        available: p.variants.some((v) => !v.trackStock || v.stock > 0),
        options: p.options.map((o) => `${o.name}: ${o.values.join(', ')}`).join('; '),
        ...(category ? { category } : {}),
      };
    };
    return {
      lines: products.map(line),
      totalActive,
      categories: categories.filter((c) => (c.productCount ?? 0) > 0).map((c) => c.name),
    };
  }

  private async customerFacts(contact: ContactDoc): Promise<PromptCustomer> {
    const customer = await this.tools.customerOf(contact);
    const orders = customer ? await this.orders.recentForCustomer(customer._id, 3) : [];
    const address =
      contact.memory?.address ??
      (customer?.addresses[0]
        ? [customer.addresses[0].line1, customer.addresses[0].area, customer.addresses[0].district]
            .filter(Boolean)
            .join(', ')
        : undefined);
    return {
      ...(contact.name || customer?.name ? { name: contact.name || customer!.name } : {}),
      ...(contact.phone || customer?.phone ? { phone: contact.phone ?? customer!.phone! } : {}),
      ...(contact.email ? { email: contact.email } : {}),
      facts: contact.memory?.facts ?? [],
      ...(address ? { address } : {}),
      orders: orders.map((o) => ({
        number: o.number,
        status: o.status,
        placedAt: o.placedAt,
        totalMinor: o.totalMinor,
        items: o.items
          .map((i) => `${i.quantity}× ${i.name}${i.variantTitle ? ` (${i.variantTitle})` : ''}`)
          .join(', '),
      })),
      ...(customer
        ? {
            stats: {
              orders: customer.stats.orders,
              delivered: customer.stats.delivered,
              cancelled: customer.stats.cancelled,
              returned: customer.stats.returned,
            },
          }
        : {}),
    };
  }

  private async prompt(
    settings: Pick<
      AiAgentSettings,
      'assistantName' | 'tone' | 'language' | 'businessInfo' | 'instructions' | 'faqs' | 'takeOrders'
    >,
    channelType: ChannelType,
    contact: ContactDoc | null,
  ): Promise<string> {
    const orgId = RequestContext.tenant()!.orgId;
    const [org, shop, catalog, customer] = await Promise.all([
      this.orgs.get(orgId),
      this.shopSettings.get(),
      this.catalog(),
      contact ? this.customerFacts(contact) : Promise.resolve(null),
    ]);
    return buildAgentPrompt({
      business: { name: org.name, currency: org.currency, timezone: org.timezone },
      settings: {
        assistantName: settings.assistantName,
        tone: settings.tone,
        language: settings.language,
        businessInfo: settings.businessInfo,
        instructions: settings.instructions,
        faqs: settings.faqs,
        takeOrders: settings.takeOrders,
      },
      channel: CHANNEL_LABEL[channelType],
      catalog,
      zones: shop.deliveryZones.map((z) => ({ id: z.id, name: z.name, chargeMinor: z.chargeMinor })),
      customer,
      now: new Date(),
    });
  }

  // ------------------------------------------------------------------ test chat

  /** Whether replies can run at all on this deployment for the business's tier. */
  async serviceReady(settings: Pick<AiAgentSettings, 'tier'>): Promise<boolean> {
    try {
      const model = await this.runner.modelFor(settings.tier);
      return this.providers.configured(model.provider);
    } catch {
      return false;
    }
  }

  /**
   * The settings page's test chat: the real agent with the saved (or draft) settings and
   * the real catalog, but nothing is saved, no order is placed and nobody is messaged. It
   * spends credits like a real reply.
   */
  async preview(input: PreviewInput, userId: string) {
    const saved = await this.settings.get();
    const settings = { ...saved, ...input.draft };
    const org = await this.orgs.get(RequestContext.tenant()!.orgId);
    const messages: AiMessage[] = input.messages.map((m) =>
      m.from === 'customer' ? { role: 'user', text: m.text } : { role: 'assistant', text: m.text },
    );
    const toolContext: ToolRunContext = {
      mode: 'preview',
      orgId: org._id.toHexString(),
      currency: org.currency,
      takeOrders: settings.takeOrders,
      confirmOrders: false,
      conversation: null,
      contact: null,
      channelType: null,
    };
    let result: AgentRunResult;
    try {
      result = await this.runner.run({
        feature: 'ai_agent_preview',
        tier: settings.tier,
        system: await this.prompt(settings, 'web_chat', null),
        messages,
        tools: this.tools.specs(settings),
        toolContext,
        runId: `aip_${randomUUID()}`,
        reference: { type: 'ai_agent_preview', id: userId },
      });
    } catch (err) {
      if (err instanceof AiProviderError) {
        if (err.kind === 'not_configured' || err.kind === 'auth')
          throw new AppError(
            'ai_unavailable',
            503,
            'The AI service is not available right now. Please try again later.',
          );
        this.logger.warn({ err }, 'AI test chat failed');
        throw new AppError(
          'ai_busy',
          503,
          'The AI service did not answer. Please try again in a moment.',
        );
      }
      if (err instanceof AppError && err.code === 'ai_model_unavailable')
        throw new AppError('ai_unavailable', 503, 'The AI service is not available right now.');
      throw err;
    }
    const lastCustomer = input.messages.findLast((m) => m.from === 'customer')?.text ?? '';
    return {
      reply:
        result.kind === 'reply'
          ? toChatText(result.text)
          : handoverNotice(settings.handoverMessage, lastCustomer),
      outcome: result.kind,
      handover: result.handover ?? null,
      order: result.orders[0] ? { number: result.orders[0].number } : null,
      toolCalls: result.toolCalls,
      credits: result.credits,
    };
  }
}
