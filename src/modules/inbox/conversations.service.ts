import { Injectable } from '@nestjs/common';
import { Types, type QueryFilter } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/validation/schemas.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { escapeRegex } from '../commerce/text.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { TenantAccessService } from '../orgs/tenant-access.service.js';
import { UsersService } from '../users/users.service.js';
import { ChannelsService } from './channels.service.js';
import {
  toConversationDto,
  toMessageDto,
  type ContactDoc,
  type ConversationDoc,
  type ConversationDto,
} from './inbox.mappers.js';
import { MessagingService } from './messaging.service.js';
import { ContactRepository, ConversationRepository, MessageRepository } from './repositories.js';
import type { Conversation, ConversationAi } from './schemas.js';

export interface ConversationListQuery {
  limit: number;
  cursor?: string;
  status: 'open' | 'closed' | 'all';
  assignee?: string;
  channelId?: string;
  ai?: 'auto' | 'paused';
  q?: string;
}

export interface SendInput {
  text: string;
  note: boolean;
  clientId?: string;
}

/** The text that pauses or resumes the AI when a staff member sends it on its own. */
export const DOT_COMMAND = '.';

/**
 * The team inbox as staff use it. Staff with inbox.view see every conversation; staff with
 * only inbox.view_assigned see the ones assigned to them, everywhere (lists, threads, live
 * events), and anything else is "not found".
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly contacts: ContactRepository,
    private readonly messages: MessageRepository,
    private readonly channels: ChannelsService,
    private readonly messaging: MessagingService,
    private readonly orgs: OrgsService,
    private readonly access: TenantAccessService,
    private readonly users: UsersService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private can(permission: string): boolean {
    const p = RequestContext.tenant()!.permissions;
    return p.has('*') || p.has(permission);
  }

  private me(): Types.ObjectId {
    return new Types.ObjectId(RequestContext.actor().id);
  }

  /** Extra filter that limits staff without inbox.view to their own conversations. */
  private visibility(): QueryFilter<Conversation> {
    if (this.can('inbox.view')) return {};
    if (this.can('inbox.view_assigned')) return { assigneeId: this.me() };
    throw AppError.forbidden('missing_permission', 'Your role does not allow this action.');
  }

  private async visible(id: string): Promise<ConversationDoc> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('conversation');
    const conv = await this.conversations.findOne({
      _id: new Types.ObjectId(id),
      ...this.visibility(),
    });
    if (!conv) throw AppError.notFound('conversation');
    return conv;
  }

  private async contactOf(conv: ConversationDoc): Promise<ContactDoc> {
    const contact = await this.contacts.findById(conv.contactId);
    if (!contact) throw new Error(`conversation ${conv._id.toHexString()} has no contact`);
    return contact;
  }

  private aiAvailable(): Promise<boolean> {
    return this.entitlements.hasModule(RequestContext.tenant()!.orgId, 'ai_agent');
  }

  private async staffName(): Promise<string> {
    const user = await this.users.findById(RequestContext.actor().id);
    return user?.name ?? 'A team member';
  }

  // ------------------------------------------------------------------- reads

  async list(
    q: ConversationListQuery,
  ): Promise<{ items: ConversationDto[]; nextCursor: string | null }> {
    const filter: QueryFilter<Conversation> = { ...this.visibility() };
    if (q.status !== 'all') filter.status = q.status;
    if (q.channelId) filter.channelId = new Types.ObjectId(q.channelId);
    if (q.ai) filter['ai.mode'] = q.ai;
    if (q.assignee === 'me') filter.assigneeId = this.me();
    else if (q.assignee === 'unassigned') {
      // Staff who only see their own threads have nothing unassigned to see.
      if (!this.can('inbox.view')) return { items: [], nextCursor: null };
      filter.assigneeId = { $exists: false };
    } else if (q.assignee) {
      const wanted = new Types.ObjectId(q.assignee);
      if (filter.assigneeId && !wanted.equals(filter.assigneeId as Types.ObjectId))
        return { items: [], nextCursor: null };
      filter.assigneeId = wanted;
    }
    if (q.q) {
      const pattern = new RegExp(escapeRegex(q.q), 'i');
      const digits = q.q.replace(/\D/g, '');
      const matches = await this.contacts.find(
        {
          $or: [
            { name: pattern },
            { email: pattern },
            ...(digits.length >= 4 ? [{ phone: new RegExp(escapeRegex(digits)) }] : []),
          ],
        },
        { projection: { _id: 1 }, limit: 500 },
      );
      filter.contactId = { $in: matches.map((c) => c._id) };
    }

    const page = await this.conversations.paginate(filter, q, 'lastMessageAt');
    const contacts = await this.contacts.find({
      _id: { $in: page.items.map((c) => c.contactId) },
    });
    const byId = new Map(contacts.map((c) => [c._id.toHexString(), c]));
    const month = await this.messaging.currentMonth();
    return {
      items: page.items.map((c) =>
        toConversationDto(c, byId.get(c.contactId.toHexString()) ?? null, month),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string): Promise<ConversationDto> {
    return this.messaging.conversationDto(await this.visible(id));
  }

  /** Newest first. Opening a thread locked by the monthly limit answers 402. */
  async listMessages(id: string, q: { limit: number; cursor?: string }) {
    const conv = await this.messaging.ensureUnlocked(await this.visible(id));
    const page = await this.messages.paginate({ conversationId: conv._id }, q);
    return { items: page.items.map(toMessageDto), nextCursor: page.nextCursor };
  }

  async markRead(id: string): Promise<ConversationDto> {
    const conv = await this.messaging.ensureUnlocked(await this.visible(id));
    if (conv.unread === 0) return this.messaging.conversationDto(conv);
    const updated = await this.conversations.findOneAndUpdate(
      { _id: conv._id },
      { $set: { unread: 0 } },
    );
    return this.messaging.publishConversation(updated ?? conv);
  }

  // ------------------------------------------------------------------ writes

  /**
   * A staff reply or internal note. A reply on its own of "." toggles the AI for this
   * conversation instead of being sent. Replying also hands the conversation to the
   * person replying: the AI pauses and, when nobody has it, it is assigned to them.
   */
  async send(
    id: string,
    input: SendInput,
  ): Promise<{ message: ReturnType<typeof toMessageDto> | null; conversation: ConversationDto }> {
    let conv = await this.messaging.ensureUnlocked(await this.visible(id));
    if (!input.note && input.text.trim() === DOT_COMMAND) {
      const next = conv.ai.mode === 'auto' ? 'paused' : 'auto';
      return { message: null, conversation: await this.setAiMode(id, next, 'dot_command') };
    }

    const contact = await this.contactOf(conv);
    const channel = input.note ? null : await this.channels.find(conv.channelId.toHexString());
    const name = await this.staffName();
    const me = this.me();
    const result = await this.messaging.postOutgoing(conv, contact, channel, {
      type: input.note ? 'note' : 'text',
      text: input.text,
      sender: { type: 'user', id: me.toHexString(), name },
      ...(input.clientId ? { clientId: input.clientId } : {}),
    });
    conv = result.conversation;

    if (!input.note && !result.duplicate) {
      const set: Record<string, unknown> = {};
      if (!conv.assigneeId) set.assigneeId = me;
      if (conv.ai.mode === 'auto' && channel?.aiEnabled && (await this.aiAvailable()))
        set.ai = {
          mode: 'paused',
          changedAt: new Date(),
          changedBy: { type: 'user', id: me.toHexString(), name },
          reason: 'human_reply',
        } satisfies ConversationAi;
      if (Object.keys(set).length) {
        conv =
          (await this.conversations.findOneAndUpdate({ _id: conv._id }, { $set: set })) ?? conv;
        if (set.ai)
          await this.messaging.systemLine(conv, contact, `${name} replied, so the AI paused.`);
        await this.messaging.publishConversation(conv, { contact });
      }
    }
    return {
      message: toMessageDto(result.message),
      conversation: await this.messaging.conversationDto(conv, contact),
    };
  }

  async setAiMode(
    id: string,
    mode: ConversationAi['mode'],
    reason: string = 'manual',
  ): Promise<ConversationDto> {
    if (!this.can('inbox.ai_control'))
      throw new AppError('missing_permission', 403, 'Your role does not allow this action.', {
        required: ['inbox.ai_control'],
      });
    const conv = await this.visible(id);
    if (conv.ai.mode === mode) return this.messaging.conversationDto(conv);
    const name = await this.staffName();
    const updated = await this.conversations.findOneAndUpdate(
      { _id: conv._id },
      {
        $set: {
          ai: {
            mode,
            changedAt: new Date(),
            changedBy: { type: 'user', id: this.me().toHexString(), name },
            reason,
          },
        },
      },
    );
    if (!updated) throw AppError.notFound('conversation');
    const contact = await this.contactOf(updated);
    await this.messaging.systemLine(
      updated,
      contact,
      mode === 'paused' ? `${name} paused the AI.` : `${name} turned the AI back on.`,
    );
    return this.messaging.publishConversation(updated, { contact });
  }

  async assign(id: string, assigneeId: string | null): Promise<ConversationDto> {
    const conv = await this.visible(id);
    const orgId = RequestContext.tenant()!.orgId;
    let assigneeName: string | null = null;
    if (assigneeId) {
      const access = await this.access.resolve(orgId, assigneeId);
      const canReply =
        access?.permissions.includes('*') || access?.permissions.includes('inbox.reply');
      if (!access || !canReply)
        throw AppError.validation([
          { path: 'assigneeId', message: 'Choose a team member who can reply to customers' },
        ]);
      assigneeName = (await this.users.findById(assigneeId))?.name ?? 'a team member';
    }
    if ((conv.assigneeId?.toHexString() ?? null) === assigneeId)
      return this.messaging.conversationDto(conv);

    const updated = await this.conversations.findOneAndUpdate(
      { _id: conv._id },
      assigneeId
        ? { $set: { assigneeId: new Types.ObjectId(assigneeId) } }
        : { $unset: { assigneeId: 1 } },
    );
    if (!updated) throw AppError.notFound('conversation');
    const contact = await this.contactOf(updated);
    const by = await this.staffName();
    await this.messaging.systemLine(
      updated,
      contact,
      assigneeName ? `${by} assigned this to ${assigneeName}.` : `${by} unassigned this.`,
    );
    return this.messaging.publishConversation(updated, {
      contact,
      previousAssignee: conv.assigneeId ?? null,
    });
  }

  async setStatus(id: string, status: 'open' | 'closed'): Promise<ConversationDto> {
    const conv = await this.visible(id);
    if (conv.status === status) return this.messaging.conversationDto(conv);
    const updated = await this.conversations.findOneAndUpdate(
      { _id: conv._id },
      { $set: { status, ...(status === 'closed' ? { unread: 0 } : {}) } },
    );
    if (!updated) throw AppError.notFound('conversation');
    const contact = await this.contactOf(updated);
    const by = await this.staffName();
    await this.messaging.systemLine(
      updated,
      contact,
      status === 'closed' ? `${by} closed this.` : `${by} reopened this.`,
    );
    return this.messaging.publishConversation(updated, { contact });
  }

  /** Staff edit a contact's name, phone or email. */
  async updateContact(
    conversationId: string,
    patch: { name?: string; phone?: string | null; email?: string | null },
  ): Promise<ConversationDto> {
    const conv = await this.messaging.ensureUnlocked(await this.visible(conversationId));
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.email !== undefined) {
      if (patch.email) set.email = patch.email;
      else unset.email = 1;
    }
    if (patch.phone !== undefined) {
      if (patch.phone) {
        const org = await this.orgs.get(RequestContext.tenant()!.orgId);
        const phone = normalizePhone(patch.phone, org.country);
        if (!phone)
          throw AppError.validation([{ path: 'phone', message: 'Enter a valid phone number' }]);
        set.phone = phone;
      } else unset.phone = 1;
    }
    const contact = await this.contacts.findOneAndUpdate(
      { _id: conv.contactId },
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
    );
    if (!contact) throw AppError.notFound('contact');
    return this.messaging.publishConversation(conv, { contact });
  }
}
