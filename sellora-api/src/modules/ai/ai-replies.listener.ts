import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  INBOX_AI_RESUMED,
  INBOX_MESSAGE_RECEIVED,
  type InboxAiResumedEvent,
  type InboxMessageReceivedEvent,
} from '../inbox/messaging.service.js';
import { AiRepliesService } from './agent/ai-replies.service.js';

/** Schedules AI replies from inbox events. The replies themselves run in the worker. */
@Injectable()
export class AiRepliesListener {
  private readonly logger = new Logger(AiRepliesListener.name);

  constructor(private readonly replies: AiRepliesService) {}

  @OnEvent(INBOX_MESSAGE_RECEIVED, { async: true, promisify: true })
  async onMessage(e: InboxMessageReceivedEvent): Promise<void> {
    if (!e.actionable) return;
    try {
      await this.replies.onCustomerMessage(e);
    } catch (err) {
      this.logger.error(
        { err, conversationId: e.conversationId },
        'Could not schedule an AI reply',
      );
    }
  }

  @OnEvent(INBOX_AI_RESUMED, { async: true, promisify: true })
  async onResumed(e: InboxAiResumedEvent): Promise<void> {
    try {
      await this.replies.onResumed(e);
    } catch (err) {
      this.logger.error(
        { err, conversationId: e.conversationId },
        'Could not schedule an AI reply',
      );
    }
  }
}
