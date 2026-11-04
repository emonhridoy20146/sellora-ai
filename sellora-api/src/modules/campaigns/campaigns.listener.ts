import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../../common/context/request-context.js';
import {
  ORDER_CREATED,
  ORDER_STATUS_CHANGED,
  type OrderCreatedEvent,
  type OrderStatusChangedEvent,
} from '../commerce/orders.service.js';
import { OrderRepository } from '../commerce/repositories.js';
import { AutomationsService } from './automations.service.js';
import { CampaignsService } from './campaigns.service.js';

/**
 * Orders and SMS marketing (ADR 0019): a new order counts for the campaign or automation
 * text the number got in the 7 days before it, and a delivered order plans the thank-you.
 * Runs in the API and in the worker (couriers mark orders delivered there).
 */
@Injectable()
export class CampaignsListener {
  private readonly logger = new Logger(CampaignsListener.name);

  constructor(
    private readonly campaigns: CampaignsService,
    private readonly automations: AutomationsService,
    private readonly orders: OrderRepository,
  ) {}

  @OnEvent(ORDER_CREATED, { async: true, promisify: true, suppressErrors: true })
  async onOrderCreated(e: OrderCreatedEvent): Promise<void> {
    try {
      await RequestContext.withTenant(
        e.orgId,
        async () => {
          const order = await this.orders.findById(e.orderId);
          if (order) await this.campaigns.orderCreated(order);
        },
        { type: 'system', id: 'campaigns' },
      );
    } catch (err) {
      this.logger.error({ err, orgId: e.orgId, orderId: e.orderId }, 'Could not credit the order');
    }
  }

  @OnEvent(ORDER_STATUS_CHANGED, { async: true, promisify: true, suppressErrors: true })
  async onOrderStatusChanged(e: OrderStatusChangedEvent): Promise<void> {
    if (e.to !== 'delivered') return;
    try {
      await RequestContext.withTenant(
        e.orgId,
        async () => {
          const order = await this.orders.findById(e.orderId);
          if (order?.status === 'delivered') await this.automations.orderDelivered(order);
        },
        { type: 'system', id: 'automations' },
      );
    } catch (err) {
      this.logger.error(
        { err, orgId: e.orgId, orderId: e.orderId },
        'Could not plan the after-delivery text',
      );
    }
  }
}
