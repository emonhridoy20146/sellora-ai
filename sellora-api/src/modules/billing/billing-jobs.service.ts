import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context.js';
import { CreditsService } from './credits.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

const STALE_RESERVATION_MS = 60 * 60_000;

/**
 * Periodic billing work, run by the worker on a schedule (and directly by tests): renew or
 * downgrade ended periods, grant monthly included credits, and release AI reservations
 * that were never settled. Each business is processed in its own tenant scope, and one
 * failing business never stops the batch.
 */
@Injectable()
export class BillingJobsService {
  private readonly logger = new Logger(BillingJobsService.name);

  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly credits: CreditsService,
  ) {}

  async runRenewals(now = new Date()) {
    const counts = { renewed: 0, past_due: 0, downgraded: 0, skipped: 0, failed: 0 };
    for (const { id, orgId } of await this.subscriptions.findDue(now)) {
      try {
        const result = await RequestContext.withTenant(
          orgId,
          () => this.subscriptions.renew(id, now),
          { type: 'system', id: 'billing-renewals' },
        );
        counts[result] += 1;
      } catch (err) {
        counts.failed += 1;
        this.logger.error({ err, orgId, subscriptionId: id }, 'Renewal failed');
      }
    }
    return counts;
  }

  async runCreditGrants(now = new Date()) {
    let granted = 0;
    let failed = 0;
    for (const { id, orgId } of await this.subscriptions.findCreditGrantsDue(now)) {
      try {
        await RequestContext.withTenant(orgId, () => this.subscriptions.grantDue(id, now), {
          type: 'system',
          id: 'credit-grants',
        });
        granted += 1;
      } catch (err) {
        failed += 1;
        this.logger.error({ err, orgId, subscriptionId: id }, 'Credit grant failed');
      }
    }
    return { processed: granted, failed };
  }

  async releaseStaleReservations(now = new Date()) {
    let released = 0;
    for (const { orgId, requestId } of await this.credits.findStaleReservations(
      new Date(now.getTime() - STALE_RESERVATION_MS),
    )) {
      try {
        await RequestContext.withTenant(orgId, () => this.credits.release(requestId), {
          type: 'system',
          id: 'ai-reservations',
        });
        released += 1;
      } catch (err) {
        this.logger.error({ err, orgId, requestId }, 'Could not release a stale AI reservation');
      }
    }
    return { released };
  }
}
