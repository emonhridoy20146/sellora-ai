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
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
