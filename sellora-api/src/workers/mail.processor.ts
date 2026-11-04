import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfig } from '../config/app-config.js';
import { QUEUES } from '../infra/queue/queue.constants.js';
import type { MailMessage } from '../infra/mail/mail.service.js';

@Processor(QUEUES.mail, { concurrency: 10 })
export class MailProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MailProcessor.name);
  private transport?: Transporter;

  constructor(private readonly config: AppConfig) {
    super();
  }

  onModuleInit(): void {
    const url = this.config.get('SMTP_URL');
    if (this.config.get('MAIL_TRANSPORT') === 'smtp' && url)
      this.transport = nodemailer.createTransport(url);
  }

  async process(job: Job<MailMessage>): Promise<{ messageId: string }> {
    if (!this.transport) throw new Error('SMTP transport is not configured');
    const info = (await this.transport.sendMail({
      from: this.config.get('MAIL_FROM'),
      to: job.data.to,
      subject: job.data.subject,
      text: job.data.text,
      html: job.data.html,
      headers: { 'X-Sellora-Category': job.data.category },
    })) as { messageId: string };
    this.logger.log({ jobId: job.id, category: job.data.category }, 'Mail delivered');
    return { messageId: info.messageId };
  }
}
