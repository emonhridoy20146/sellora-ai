import { Controller, Delete, Get, Headers, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  OwnTokenAuth,
  RequireAnyPermission,
  RequireModule,
  RequirePermissions,
} from '../auth/decorators.js';
import { ChannelsService, toChannelDto } from './channels.service.js';
import { ConversationsService } from './conversations.service.js';
import * as dto from './inbox.dto.js';
import { WebchatService } from './webchat.service.js';

@ApiTags('inbox: channels')
@OrgScoped()
@RequireModule('inbox')
@Controller({ path: 'orgs/:orgId/channels', version: '1' })
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequireAnyPermission('org.integrations.manage', 'inbox.view')
  async list() {
    return { items: (await this.channels.list()).map(toChannelDto) };
  }

  @Post('web-chat')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Add a website chat widget' })
  async createWebChat(@ZodBody(dto.createWebChatBody) body: z.infer<typeof dto.createWebChatBody>) {
    return toChannelDto(await this.channels.createWebChat(body));
  }

  @Get(':channelId')
  @RequireAnyPermission('org.integrations.manage', 'inbox.view')
  async get(@ZodParam('channelId', objectIdSchema) id: string) {
    return toChannelDto(await this.channels.get(id));
  }

  @Patch(':channelId')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Rename, turn on or off, AI on or off, widget settings' })
  async update(
    @ZodParam('channelId', objectIdSchema) id: string,
    @ZodBody(dto.updateChannelBody) body: z.infer<typeof dto.updateChannelBody>,
  ) {
    return toChannelDto(await this.channels.update(id, body));
  }

  @Delete(':channelId')
  @HttpCode(204)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Remove a channel. Its conversations stay as history.' })
  async remove(@ZodParam('channelId', objectIdSchema) id: string): Promise<void> {
    await this.channels.remove(id);
  }
}

@ApiTags('inbox: conversations')
@OrgScoped()
@RequireModule('inbox')
@RequireAnyPermission('inbox.view', 'inbox.view_assigned')
@Controller({ path: 'orgs/:orgId/conversations', version: '1' })
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: 'Conversations, latest activity first' })
  list(@ZodQuery(dto.conversationListQuery) q: z.infer<typeof dto.conversationListQuery>) {
    return this.conversations.list(q);
  }

  @Get(':conversationId')
  get(@ZodParam('conversationId', objectIdSchema) id: string) {
    return this.conversations.get(id);
  }

  @Get(':conversationId/messages')
  @ApiOperation({ summary: 'Messages, newest first. 402 while the monthly limit locks it.' })
  messages(
    @ZodParam('conversationId', objectIdSchema) id: string,
    @ZodQuery(dto.messageListQuery) q: z.infer<typeof dto.messageListQuery>,
  ) {
    return this.conversations.listMessages(id, q);
  }

  @Post(':conversationId/messages')
  @RequirePermissions('inbox.reply')
  @ApiOperation({
    summary: 'Reply or add a note. A reply of just "." pauses or resumes the AI instead.',
  })
  send(
    @ZodParam('conversationId', objectIdSchema) id: string,
    @ZodBody(dto.sendMessageBody) body: z.infer<typeof dto.sendMessageBody>,
  ) {
    return this.conversations.send(id, body);
  }

  @Post(':conversationId/read')
  @HttpCode(200)
  read(@ZodParam('conversationId', objectIdSchema) id: string) {
    return this.conversations.markRead(id);
  }

  @Post(':conversationId/ai')
  @HttpCode(200)
  @RequirePermissions('inbox.ai_control')
  @ApiOperation({ summary: 'Pause or resume the AI in this conversation' })
  ai(
    @ZodParam('conversationId', objectIdSchema) id: string,
    @ZodBody(dto.aiModeBody) body: z.infer<typeof dto.aiModeBody>,
  ) {
    return this.conversations.setAiMode(id, body.mode);
  }

  @Post(':conversationId/assign')
  @HttpCode(200)
  @RequirePermissions('inbox.assign')
  assign(
    @ZodParam('conversationId', objectIdSchema) id: string,
    @ZodBody(dto.assignBody) body: z.infer<typeof dto.assignBody>,
  ) {
    return this.conversations.assign(id, body.assigneeId);
  }

  @Post(':conversationId/status')
  @HttpCode(200)
  @RequirePermissions('inbox.reply')
  @ApiOperation({ summary: 'Close or reopen' })
  status(
    @ZodParam('conversationId', objectIdSchema) id: string,
    @ZodBody(dto.statusBody) body: z.infer<typeof dto.statusBody>,
  ) {
    return this.conversations.setStatus(id, body.status);
  }

  @Patch(':conversationId/contact')
  @RequirePermissions('inbox.reply')
  @ApiOperation({ summary: "Edit the customer's name, phone or email" })
  contact(
    @ZodParam('conversationId', objectIdSchema) id: string,
    @ZodBody(dto.contactPatchBody) body: z.infer<typeof dto.contactPatchBody>,
  ) {
    return this.conversations.updateContact(id, body);
  }
}

@ApiTags('inbox: conversations')
@OrgScoped()
@RequireModule('inbox')
@RequireAnyPermission('inbox.view', 'inbox.view_assigned')
@Controller({ path: 'orgs/:orgId/inbox', version: '1' })
export class InboxTeamController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get('team')
  @ApiOperation({ summary: 'Team members who can reply, for assigning and showing names' })
  async team() {
    return { items: await this.conversations.team() };
  }
}

const widgetKey = z.string().regex(/^wc_[A-Za-z0-9_-]{24}$/);

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

/**
 * The website chat widget's API. Visitors have no account: they carry a signed visitor
 * token in the Authorization header.
 */
@ApiTags('web chat (public)')
@OwnTokenAuth()
@Controller({ path: 'webchat/:key', version: '1' })
export class WebchatController {
  constructor(private readonly webchat: WebchatService) {}

  @Get()
  @ApiOperation({ summary: 'Widget settings: colour, greeting, whether to ask for contact' })
  config(@ZodParam('key', widgetKey) key: string) {
    return this.webchat.config(key);
  }

  @Post('session')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start or resume a chat; returns a visitor token and recent messages' })
  session(
    @ZodParam('key', widgetKey) key: string,
    @ZodBody(dto.visitorSessionBody) body: z.infer<typeof dto.visitorSessionBody>,
  ) {
    return this.webchat.session(key, body.token);
  }

  @Get('messages')
  async history(
    @ZodParam('key', widgetKey) key: string,
    @Headers('authorization') auth: string | undefined,
    @ZodQuery(dto.visitorHistoryQuery) q: z.infer<typeof dto.visitorHistoryQuery>,
  ) {
    const visitor = await this.webchat.visitor(key, bearer(auth));
    return this.webchat.history(visitor, q.before, q.limit);
  }

  @Post('messages')
  async send(
    @ZodParam('key', widgetKey) key: string,
    @Headers('authorization') auth: string | undefined,
    @ZodBody(dto.visitorMessageBody) body: z.infer<typeof dto.visitorMessageBody>,
  ) {
    const visitor = await this.webchat.visitor(key, bearer(auth));
    return this.webchat.send(visitor, body, RequestContext.current()?.ip);
  }

  @Patch('contact')
  async contact(
    @ZodParam('key', widgetKey) key: string,
    @Headers('authorization') auth: string | undefined,
    @ZodBody(dto.visitorContactBody) body: z.infer<typeof dto.visitorContactBody>,
  ) {
    const visitor = await this.webchat.visitor(key, bearer(auth));
    return this.webchat.setContact(visitor, body);
  }
}
