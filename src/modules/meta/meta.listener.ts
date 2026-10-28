import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../../common/context/request-context.js';
import { INBOX_CHANNEL_REMOVED, type InboxChannelRemovedEvent } from '../inbox/channels.service.js';
import { MetaConnectService } from './meta-connect.service.js';

/** Stops Meta's webhooks for a page or WhatsApp account once its channel is removed. */
@Injectable()
export class MetaChannelListener {
  private readonly logger = new Logger(MetaChannelListener.name);

  constructor(private readonly connect: MetaConnectService) {}

  @OnEvent(INBOX_CHANNEL_REMOVED, { async: true, promisify: true })
  async onRemoved(e: InboxChannelRemovedEvent): Promise<void> {
    try {
      await RequestContext.withTenant(e.orgId, () => this.connect.onChannelRemoved(e), {
        type: 'system',
        id: 'meta-connect',
      });
    } catch (err) {
      this.logger.warn({ err }, 'Unsubscribing a removed channel failed');
    }
  }
}
