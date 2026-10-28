import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { CourierAccountsService } from './courier-accounts.service.js';
import type { WebhookHeaders } from './courier.types.js';
import { ParcelsService } from './parcels.service.js';

export interface CourierWebhookReply {
  status: number;
  headers: Record<string, string>;
  body: { ok: true; parcels: number };
}

/**
 * Courier webhooks. The address names the account (a random key); the courier's own proof
 * (a bearer token or secret header) is checked where it has one. The body is never trusted
 * for a status: it only says which parcels to look up again through the courier's API.
 */
@Injectable()
export class CourierWebhooksService {
  private readonly logger = new Logger(CourierWebhooksService.name);

  constructor(
    private readonly accounts: CourierAccountsService,
    private readonly parcels: ParcelsService,
  ) {}

  async receive(key: string, headers: WebhookHeaders, body: unknown): Promise<CourierWebhookReply> {
    const account = await this.accounts.findByWebhookKey(key);
    if (!account) throw AppError.notFound('webhook', 'Unknown webhook address.');
    const provider = this.accounts.provider(account.provider);
    const secret = this.accounts.webhookSecret(account);
    if (!provider.verifyWebhook(headers, secret))
      throw AppError.unauthorized('invalid_webhook_secret', 'The webhook secret does not match.');

    const refs = provider.webhookRefs(body);
    const parcels = await RequestContext.withTenant(
      account.orgId.toHexString(),
      async () => {
        await this.accounts.noteWebhook(account._id);
        return this.parcels.nudge(account._id, refs);
      },
      { type: 'system', id: `courier:${account.provider}` },
    );
    if (!parcels && refs.consignmentIds.length + refs.trackingCodes.length + refs.invoices.length)
      this.logger.debug(
        { accountId: account._id.toHexString() },
        'Courier webhook for no tracked parcel',
      );
    const reply = provider.webhookReply(secret);
    return { status: reply.status, headers: reply.headers, body: { ok: true, parcels } };
  }
}
