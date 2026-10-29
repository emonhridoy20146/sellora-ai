import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../../common/context/request-context.js';
import {
  ORDER_CREATED,
  ORDER_STATUS_CHANGED,
  OrdersService,
  type OrderCreatedEvent,
  type OrderDoc,
  type OrderStatusChangedEvent,
} from '../commerce/orders.service.js';
import type { OrderStatus } from '../commerce/schemas.js';
import { COURIER_KEYS, type CourierKey } from '../couriers/courier.types.js';
import { CourierProviders } from '../couriers/providers/courier-providers.js';
import { SmsService } from './sms.service.js';
import { renderSms, smsMoney, type OrderSmsEvent, type SmsLanguage } from './templates.js';

/** The order message each status change sends (statuses not listed send nothing). */
const STATUS_EVENTS: Partial<Record<OrderStatus, OrderSmsEvent>> = {
  confirmed: 'order_confirmed',
  shipped: 'order_shipped',
  delivered: 'order_delivered',
  cancelled: 'order_cancelled',
};

/** {courier} when the order was marked shipped without a Sellora courier booking. */
const NO_COURIER: Record<SmsLanguage, string> = {
  en: 'our delivery partner',
  bn: 'আমাদের ডেলিভারি পার্টনার',
};

/**
 * Texts the customer when an order is placed or moves on, if the business turned that
 * message on in Settings › SMS. Each order and event sends at most one message, however
 * often the event repeats. Runs in the API and in the worker (courier updates).
 */
@Injectable()
export class OrderSmsListener {
  private readonly logger = new Logger(OrderSmsListener.name);

  constructor(
    private readonly sms: SmsService,
    private readonly orders: OrdersService,
    private readonly couriers: CourierProviders,
  ) {}

  @OnEvent(ORDER_CREATED, { async: true, promisify: true, suppressErrors: true })
  async onOrderCreated(e: OrderCreatedEvent): Promise<void> {
    await this.notify(
      e.orgId,
      e.orderId,
      e.status === 'confirmed' ? 'order_confirmed' : 'order_placed',
    );
  }

  @OnEvent(ORDER_STATUS_CHANGED, { async: true, promisify: true, suppressErrors: true })
  async onOrderStatusChanged(e: OrderStatusChangedEvent): Promise<void> {
    const event = STATUS_EVENTS[e.to];
    if (event) await this.notify(e.orgId, e.orderId, event);
  }

  /** Writes the order's message down for sending; returns whether one was made. */
  async notify(orgId: string, orderId: string, event: OrderSmsEvent): Promise<boolean> {
    try {
      return await RequestContext.withTenant(
        orgId,
        async () => {
          const s = await this.sms.settings();
          const template = s.orderTemplates[event];
          if (s.mode === 'off' || !template?.enabled || !template.text.trim()) return false;
          const order = await this.orders.get(orderId);
          const to = order.customer.phone ?? order.shippingAddress.phone;
          if (!to) return false;
          const text = renderSms(template.text, {
            ...(await this.sms.shopValues(s)),
            name: order.customer.name,
            order: order.number,
            total: smsMoney(order.totalMinor, order.currency, s.language),
            ...(event === 'order_shipped' ? this.shipping(order, s.language) : {}),
          });
          const result = await this.sms.enqueue({
            to,
            text,
            purpose: event,
            key: `order:${orderId}:${event}`,
            ref: { type: 'order', id: orderId, label: order.number },
          });
          return result.message !== null && result.created;
        },
        { type: 'system', id: 'order-sms' },
      );
    } catch (err) {
      this.logger.error({ err, orgId, orderId, event }, 'Could not write the order SMS');
      return false;
    }
  }

  private shipping(order: OrderDoc, language: SmsLanguage): { courier: string; tracking: string } {
    const shipment = order.shipment;
    if (!shipment || !COURIER_KEYS.includes(shipment.provider as CourierKey))
      return { courier: NO_COURIER[language], tracking: '' };
    const provider = this.couriers.get(shipment.provider as CourierKey);
    const tracking =
      shipment.consignmentId || shipment.trackingCode
        ? provider.trackingUrl({
            ...(shipment.consignmentId ? { consignmentId: shipment.consignmentId } : {}),
            ...(shipment.trackingCode ? { trackingCode: shipment.trackingCode } : {}),
            phone: order.customer.phone ?? order.shippingAddress.phone ?? '',
          })
        : null;
    return { courier: provider.descriptor.name, tracking: tracking ?? '' };
  }
}
