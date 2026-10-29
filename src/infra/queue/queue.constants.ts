/** BullMQ queue names. Each queue has its own worker processor in src/worker.ts. */
export const QUEUES = {
  mail: 'mail',
  audit: 'audit',
  notifications: 'notifications',
  backups: 'backups',
  ai: 'ai',
  webhooks: 'webhooks',
  /** Messages to customers on Messenger, Instagram and WhatsApp. */
  outbox: 'outbox',
  /** Customers' photos to copy from Meta into the business's storage. */
  media: 'media',
  /** Courier bookings (bulk) and parcel status checks. */
  couriers: 'couriers',
  /** SMS to customers (order updates, cart recovery, campaigns). */
  sms: 'sms',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
