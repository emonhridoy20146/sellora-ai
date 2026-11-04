import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../../common/context/request-context.js';
import { ORDER_CREATED, type OrderCreatedEvent } from '../commerce/orders.service.js';
import { OrderRepository } from '../commerce/repositories.js';
import { CartsService } from './carts.service.js';

/**
 * Closes a business's open carts for a customer's number when any order for that number is
 * created: from the store, a landing page, the inbox or by hand (ADR 0018).
 */
@Injectable()
export class CartsListener {
  private readonly logger = new Logger(CartsListener.name);

  constructor(
    private readonly carts: CartsService,
    private readonly orders: OrderRepository,
  ) {}

  @OnEvent(ORDER_CREATED, { async: true, promisify: true, suppressErrors: true })
  async onOrderCreated(e: OrderCreatedEvent): Promise<void> {
    try {
      await RequestContext.withTenant(
        e.orgId,
        async () => {
          const order = await this.orders.findById(e.orderId);
          if (order) await this.carts.orderCreated(order);
        },
        { type: 'system', id: 'carts' },
      );
    } catch (err) {
      this.logger.error({ err, orgId: e.orgId, orderId: e.orderId }, 'Could not close carts');
    }
  }
}
