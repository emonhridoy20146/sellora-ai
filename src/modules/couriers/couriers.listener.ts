import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../../common/context/request-context.js';
import { ORDER_STATUS_CHANGED, type OrderStatusChangedEvent } from '../commerce/orders.service.js';
import { ParcelsService } from './parcels.service.js';

/** Once an order is delivered, returned or cancelled, its parcel notes have been dealt with. */
@Injectable()
export class CouriersListener {
  constructor(private readonly parcels: ParcelsService) {}

  @OnEvent(ORDER_STATUS_CHANGED, { async: true, promisify: true, suppressErrors: true })
  async onOrderStatusChanged(e: OrderStatusChangedEvent): Promise<void> {
    if (!['delivered', 'returned', 'cancelled'].includes(e.to)) return;
    await RequestContext.withTenant(e.orgId, () => this.parcels.orderSettled(e.orderId));
  }
}
