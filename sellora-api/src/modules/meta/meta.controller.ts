import { Controller, Get, Header, Headers, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodBody, ZodParam } from '../../common/validation/zod.js';
import {
  OrgScoped,
  OwnTokenAuth,
  Public,
  RequireModule,
  RequirePermissions,
} from '../auth/decorators.js';
import { toChannelDto } from '../inbox/channels.service.js';
import { MetaConnectService } from './meta-connect.service.js';
import { MetaWebhookService } from './meta-webhook.service.js';
import * as dto from './meta.dto.js';

/** Meta's webhook: the subscription handshake and signed deliveries. */
@ApiTags('webhooks')
@Controller({ path: 'webhooks/meta', version: '1' })
export class MetaWebhookController {
  constructor(private readonly webhooks: MetaWebhookService) {}

  @Public()
  @Get()
  @Header('content-type', 'text/plain; charset=utf-8')
  @ApiExcludeEndpoint()
  verify(@Query() q: Record<string, unknown>): string {
    return this.webhooks.verify(q['hub.mode'], q['hub.verify_token'], q['hub.challenge']);
  }

  /** Authorised by the X-Hub-Signature-256 header, not a session. */
  @OwnTokenAuth()
  @Post()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    return this.webhooks.receive(req.rawBody, signature);
  }
}

@ApiTags('inbox: channels')
@OrgScoped()
@RequireModule('inbox')
@RequirePermissions('org.integrations.manage')
@Controller({ path: 'orgs/:orgId/channels/meta', version: '1' })
export class MetaConnectController {
  constructor(private readonly connect: MetaConnectService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Whether Messenger, Instagram and WhatsApp can be connected here' })
  settings() {
    return this.connect.settings();
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start connecting Facebook pages: returns the Facebook Login URL' })
  startLogin() {
    return this.connect.startPageLogin();
  }

  @Post('login/finish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish Facebook Login and list the pages that can be connected' })
  finishLogin(@ZodBody(dto.pageLoginFinishBody) body: z.infer<typeof dto.pageLoginFinishBody>) {
    return this.connect.finishPageLogin(body.code, body.state);
  }

  @Get('login/:sessionId')
  @ApiOperation({ summary: 'The pages from a recent Facebook Login, again' })
  pages(@ZodParam('sessionId', dto.connectSessionId) sessionId: string) {
    return this.connect.sessionPages(sessionId);
  }

  @Post('pages')
  @ApiOperation({ summary: 'Connect a page’s Messenger, its Instagram account, or both' })
  async connectPage(@ZodBody(dto.connectPageBody) body: z.infer<typeof dto.connectPageBody>) {
    return { items: (await this.connect.connectPage(body)).map(toChannelDto) };
  }

  @Post('whatsapp')
  @ApiOperation({ summary: 'Connect a WhatsApp number with a system user token' })
  async connectWhatsApp(
    @ZodBody(dto.connectWhatsAppBody) body: z.infer<typeof dto.connectWhatsAppBody>,
  ) {
    return toChannelDto(await this.connect.connectWhatsApp(body));
  }

  @Post('whatsapp/embedded')
  @ApiOperation({ summary: 'Connect a WhatsApp number from Embedded Signup' })
  async connectWhatsAppEmbedded(
    @ZodBody(dto.connectWhatsAppEmbeddedBody)
    body: z.infer<typeof dto.connectWhatsAppEmbeddedBody>,
  ) {
    return toChannelDto(await this.connect.connectWhatsAppEmbedded(body));
  }
}
