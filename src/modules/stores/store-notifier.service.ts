import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { MailService } from '../../infra/mail/mail.service.js';
import type { RenderedMail } from '../../infra/mail/templates.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { UsersService } from '../users/users.service.js';
import type { StoreDoc } from './stores.service.js';

/** Emails a store's business owner about decisions on their store and its domains. */
@Injectable()
export class StoreNotifier {
  private readonly logger = new Logger(StoreNotifier.name);

  constructor(
    private readonly orgs: OrgsService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly config: AppConfig,
  ) {}

  /** The store's page in the merchant dashboard. */
  dashboardUrl(store: Pick<StoreDoc, '_id' | 'orgId'>, tab = ''): string {
    const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
    return `${web}/app/${store.orgId.toHexString()}/store/${store._id.toHexString()}${tab ? `/${tab}` : ''}`;
  }

  /** Emails the business owner in their language. A mail failure never undoes the decision. */
  async notifyOwner(
    store: Pick<StoreDoc, '_id' | 'orgId'>,
    category: string,
    render: (locale: 'en' | 'bn') => RenderedMail,
  ): Promise<void> {
    try {
      const org = await this.orgs.get(store.orgId.toHexString());
      const [owner] = await this.users.findByIds([org.ownerUserId]);
      if (!owner) return;
      await this.mail.send({ to: owner.email, category, ...render(owner.locale) });
    } catch (err) {
      this.logger.error(
        { err, storeId: store._id.toHexString() },
        'Could not email the store owner',
      );
    }
  }
}
