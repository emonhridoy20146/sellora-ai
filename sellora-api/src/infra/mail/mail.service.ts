import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Connection } from 'mongoose';
import { AppConfig } from '../../config/app-config.js';
import { QUEUES } from '../queue/queue.constants.js';
import type { RenderedMail } from './templates.js';

export interface MailMessage extends RenderedMail {
  to: string;
  /** Category for analytics and suppression, e.g. "auth.verify". */
  category: string;
}

export interface OutboxMail extends MailMessage {
  createdAt: Date;
}

/**
 * Outbound email. With MAIL_TRANSPORT=smtp messages go through the mail queue and the
 * worker delivers them with retries. With MAIL_TRANSPORT=log (development and tests only)
 * they are stored in the mail_outbox collection so flows can be exercised end to end.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: AppConfig,
    @InjectConnection() private readonly connection: Connection,
    @InjectQueue(QUEUES.mail) private readonly queue: Queue,
  ) {}

  async send(message: MailMessage): Promise<void> {
    if (this.config.get('MAIL_TRANSPORT') === 'log') {
      await this.connection
        .db!.collection<OutboxMail>('mail_outbox')
        .insertOne({ ...message, createdAt: new Date() });
      this.logger.log(
        { to: message.to, category: message.category, subject: message.subject },
        'Mail stored in dev outbox',
      );
      return;
    }
    await this.queue.add('send', message, { attempts: 8 });
  }
}
