import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  PLATFORM_ALERT,
  PLATFORM_SIGNAL,
  type PlatformAlertEvent,
  type PlatformSignalEvent,
} from '../../common/alerts/platform-alert.js';
import { AI_HANDOVER } from '../ai/agent/ai-replies.service.js';
import type { AuditEvent } from '../audit/audit-event.schema.js';
import { AUDIT_RECORDED } from '../audit/audit.service.js';
import { AlertsService } from './alerts.service.js';

/** Failed sign-ins and 2-step codes, by where they happened. */
const SIGN_IN_FAILURES: Record<string, string> = {
  'auth.login.failed': 'Business sign-ins',
  'auth.mfa.failed': 'Business 2-step codes',
  'platform.auth.login.failed': 'Super-admin sign-ins',
  'platform.auth.mfa.failed': 'Super-admin 2-step codes',
};

/**
 * Turns events from the rest of the app into owner alerts and report counts (ADR 0022).
 * Runs in the API and in the worker; nothing here can fail the code that emitted.
 */
@Injectable()
export class TelegramListener {
  private readonly logger = new Logger(TelegramListener.name);

  constructor(private readonly alerts: AlertsService) {}

  @OnEvent(PLATFORM_ALERT, { async: true, promisify: true, suppressErrors: true })
  async onAlert(event: PlatformAlertEvent): Promise<void> {
    await this.alerts.raise(event).catch((err: unknown) => {
      this.logger.error({ err, key: event.key }, 'Alert not sent');
    });
  }

  @OnEvent(PLATFORM_SIGNAL, { async: true, promisify: true, suppressErrors: true })
  async onSignal(event: PlatformSignalEvent): Promise<void> {
    await this.alerts.count(event.kind, event.detail).catch((err: unknown) => {
      this.logger.error({ err, kind: event.kind }, 'Spike count failed');
    });
  }

  @OnEvent(AUDIT_RECORDED, { async: true, promisify: true, suppressErrors: true })
  async onAudit(event: Pick<AuditEvent, 'action'>): Promise<void> {
    const where = SIGN_IN_FAILURES[event.action];
    if (!where) return;
    await this.alerts.count('login_failure', where).catch((err: unknown) => {
      this.logger.error({ err }, 'Sign-in failure count failed');
    });
  }

  @OnEvent(AI_HANDOVER, { async: true, promisify: true, suppressErrors: true })
  async onHandover(): Promise<void> {
    await this.alerts.add('handovers').catch((err: unknown) => {
      this.logger.error({ err }, 'Handover count failed');
    });
  }
}
