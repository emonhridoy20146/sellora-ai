import { Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';
import { RealtimePublisher } from '../../infra/realtime/realtime.publisher.js';
import type { ConversationDto, MessageDto, VisitorMessageDto } from './inbox.mappers.js';
import type { ChannelStatus } from './schemas.js';

/** Socket rooms. Staff with inbox.view join `all`; staff who only see their own threads join `user`. */
export const rooms = {
  all: (orgId: string) => `org:${orgId}:all`,
  user: (orgId: string, userId: string) => `org:${orgId}:user:${userId}`,
  /** Every staff socket of a business, whatever part of the inbox it may see. */
  staff: (orgId: string) => `org:${orgId}:staff`,
  visitor: (channelId: string, visitorId: string) => `wv:${channelId}:${visitorId}`,
};

type Id = string | Types.ObjectId | null | undefined;

const hex = (id: Id) => (id ? (typeof id === 'string' ? id : id.toHexString()) : null);

/** Live inbox events for staff apps and website visitors. */
@Injectable()
export class InboxRealtime {
  constructor(private readonly publisher: RealtimePublisher) {}

  /** Everyone who may see a conversation: full inbox viewers and its (old and new) assignee. */
  private staffRooms(orgId: string, assignees: Id[]): string[] {
    const list = [rooms.all(orgId)];
    for (const a of new Set(assignees.map(hex).filter((x): x is string => x !== null)))
      list.push(rooms.user(orgId, a));
    return list;
  }

  conversationUpdated(orgId: string, conversation: ConversationDto, previousAssignee?: Id) {
    return this.publisher.publish({
      ns: 'agents',
      rooms: this.staffRooms(orgId, [conversation.assigneeId, previousAssignee]),
      event: 'conversation.updated',
      data: conversation,
    });
  }

  messageCreated(orgId: string, assigneeId: Id, message: MessageDto) {
    return this.publisher.publish({
      ns: 'agents',
      rooms: this.staffRooms(orgId, [assigneeId]),
      event: 'message.created',
      data: message,
    });
  }

  messageUpdated(orgId: string, assigneeId: Id, message: MessageDto) {
    return this.publisher.publish({
      ns: 'agents',
      rooms: this.staffRooms(orgId, [assigneeId]),
      event: 'message.updated',
      data: message,
    });
  }

  /**
   * A channel was switched on or off, removed, or Meta stopped accepting it. Carries no
   * settings: apps reload the channel list, which checks the viewer's permissions.
   */
  channelUpdated(orgId: string, channel: { id: string; status: ChannelStatus | 'removed' }) {
    return this.publisher.publish({
      ns: 'agents',
      rooms: [rooms.staff(orgId)],
      event: 'channel.updated',
      data: channel,
    });
  }

  /** Someone is typing. Not stored. */
  staffTyping(orgId: string, assigneeId: Id, data: { conversationId: string; who: string }) {
    return this.publisher.publish({
      ns: 'agents',
      rooms: this.staffRooms(orgId, [assigneeId]),
      event: 'typing',
      data,
    });
  }

  toVisitor(channelId: Id, visitorId: string, message: VisitorMessageDto) {
    return this.publisher.publish({
      ns: 'webchat',
      rooms: [rooms.visitor(hex(channelId)!, visitorId)],
      event: 'message',
      data: message,
    });
  }

  visitorTyping(channelId: Id, visitorId: string, typing: boolean) {
    return this.publisher.publish({
      ns: 'webchat',
      rooms: [rooms.visitor(hex(channelId)!, visitorId)],
      event: 'typing',
      data: { typing },
    });
  }
}
