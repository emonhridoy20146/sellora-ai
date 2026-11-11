import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../../common/context/request-context.js';
import {
  ORDER_CREATED,
  ORDER_STATUS_CHANGED,
  type OrderCreatedEvent,
  type OrderStatusChangedEvent,
} from '../commerce/orders.service.js';
import { AdEventsService } from './ad-events.service.js';

/**
 * Order events for the ad platforms (ADR 0030): orders from the inbox or added by hand when
 * a tracking id takes them, purchases counted on delivery, and refunds. Store and landing
 * page orders are queued by the checkout itself, with the shopper's browser details. Runs in
 * the API and in the worker (courier updates mark orders delivered).
 */
@Injectable()
export class AdTrackingListener {
  private readonly logger = new Logger(AdTrackingListener.name);

  constructor(private readonly events: AdEventsService) {}

  @OnEvent(ORDER_CREATED, { async: true, promisify: true, suppressErrors: true })
  async onOrderCreated(e: OrderCreatedEvent): Promise<void> {
    if (e.source === 'store' || e.source === 'landing_page') return;
    await this.run(e.orgId, e.orderId, () => this.events.orderCreated(e.orderId));
  }

  @OnEvent(ORDER_STATUS_CHANGED, { async: true, promisify: true, suppressErrors: true })
  async onOrderStatusChanged(e: OrderStatusChangedEvent): Promise<void> {
    if (e.to !== 'delivered' && e.to !== 'cancelled' && e.to !== 'returned') return;
    await this.run(e.orgId, e.orderId, () => this.events.orderStatusChanged(e.orderId, e.to));
  }

  private async run(orgId: string, orderId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await RequestContext.withTenant(orgId, fn, { type: 'system', id: 'ad-tracking' });
    } catch (err) {
      this.logger.error({ err, orgId, orderId }, 'Could not queue the order’s ad events');
    }
  }
}
