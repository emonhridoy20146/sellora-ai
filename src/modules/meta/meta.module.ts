import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { InboxCoreModule } from '../inbox/inbox.module.js';
import { MetaConnectService } from './meta-connect.service.js';
import { META_FETCH, MetaGraph } from './meta-graph.js';
import { MetaInbound } from './meta-inbound.service.js';
import { MetaSender } from './meta-sender.service.js';
import { MetaWebhookService } from './meta-webhook.service.js';
import { MetaChannelListener } from './meta.listener.js';
import { MetaConnectController, MetaWebhookController } from './meta.controller.js';

/**
 * Messenger, Instagram and WhatsApp without HTTP routes: the Graph client, the sender the
 * outbox worker uses and the webhook handler the webhooks worker uses.
 */
@Module({
  imports: [InboxCoreModule, BillingModule],
  providers: [
    { provide: META_FETCH, useFactory: (): typeof fetch => globalThis.fetch.bind(globalThis) },
    MetaGraph,
    MetaSender,
    MetaInbound,
  ],
  exports: [MetaGraph, MetaSender, MetaInbound],
})
export class MetaCoreModule {}

/** Meta's webhook endpoint and the connect flows. */
@Module({
  imports: [MetaCoreModule, InboxCoreModule],
  controllers: [MetaWebhookController, MetaConnectController],
  providers: [MetaWebhookService, MetaConnectService, MetaChannelListener],
})
export class MetaModule {}
