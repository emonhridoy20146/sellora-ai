import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RealtimeRelay } from '../../infra/realtime/realtime.relay.js';
import { BillingModule } from '../billing/billing.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersModule } from '../users/users.module.js';
import { ChannelsService } from './channels.service.js';
import { ConversationsService } from './conversations.service.js';
import { InboxRealtime } from './inbox-realtime.service.js';
import {
  ChannelsController,
  ConversationsController,
  InboxTeamController,
  WebchatController,
} from './inbox.controller.js';
import { AgentsGateway, WebchatGateway } from './inbox.gateways.js';
import { MessagingService } from './messaging.service.js';
import { OutboxQueue } from './outbox.js';
import {
  ChannelRepository,
  ContactRepository,
  ConversationRepository,
  MessageRepository,
} from './repositories.js';
import { channelSchema, contactSchema, conversationSchema, messageSchema } from './schemas.js';
import { WebchatService } from './webchat.service.js';

const models = MongooseModule.forFeature([
  { name: 'Channel', schema: channelSchema },
  { name: 'Contact', schema: contactSchema },
  { name: 'Conversation', schema: conversationSchema },
  { name: 'Message', schema: messageSchema },
]);

const repositories = [
  ChannelRepository,
  ContactRepository,
  ConversationRepository,
  MessageRepository,
];

/**
 * Storing and delivering messages, without HTTP routes or sockets. The worker uses it to
 * post AI replies; the API module below builds on it.
 */
@Module({
  imports: [OrgsModule, BillingModule, models],
  providers: [...repositories, ChannelsService, InboxRealtime, MessagingService, OutboxQueue],
  exports: [...repositories, ChannelsService, InboxRealtime, MessagingService, OutboxQueue],
})
export class InboxCoreModule {}

/** The unified inbox: channels, conversations, the website chat and live updates. */
@Module({
  imports: [InboxCoreModule, OrgsModule, BillingModule, UsersModule],
  controllers: [
    ChannelsController,
    ConversationsController,
    InboxTeamController,
    WebchatController,
  ],
  providers: [ConversationsService, WebchatService, RealtimeRelay, AgentsGateway, WebchatGateway],
  exports: [ConversationsService],
})
export class InboxModule {}
