import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import type { AuditEvent } from '../audit/audit-event.schema.js';
import { AUDIT_RECORDED } from '../audit/audit.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import { StoreRepository } from './repositories.js';
import type { ReviewFlag, StoreChangeArea } from './schemas.js';
import { changedTexts, storeTexts } from './store-changes.js';
import { precheckStore } from './store-precheck.js';
import type { StoreDoc } from './stores.service.js';

const MAX_FLAGS = 50;
const PRODUCT_SAVED = new Set(['catalog.product.created', 'catalog.product.updated']);

/**
 * Edits to a store after it was approved (ADR 0028). They go live at once, so a business is
 * never stuck waiting; the store joins the super-admin's "changed since approval" queue with
 * what the automatic check found in the new words. With automatic approval on, changes the
 * check finds nothing in are accepted on their own. Products saved later are checked too, and
 * only a flagged product puts the store in the queue (products change all the time).
 */
@Injectable()
export class StoreChangesService {
  private readonly logger = new Logger(StoreChangesService.name);

  constructor(
    private readonly stores: StoreRepository,
    private readonly products: ProductRepository,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /** Notes a merchant's edit to an approved store. Runs inside the store's business. */
  async noted(store: StoreDoc, areas: StoreChangeArea[]): Promise<void> {
    if (!store.liveSince || areas.length === 0) return;
    const texts = storeTexts(store);
    const found = precheckStore(changedTexts(store.review.approvedTexts, texts));
    // Product warnings stay until that product is saved again.
    const productFlags = (store.changes?.flags ?? []).filter((f) => f.where.startsWith('product:'));
    const flags = [...productFlags, ...found].slice(0, MAX_FLAGS);
    const { stores: settings } = await this.platformSettings.get();
    if (settings.autoApprove && flags.length === 0 && !store.changes?.askedAt) {
      await this.stores.updateOne(
        { _id: store._id },
        { $set: { 'review.approvedTexts': texts }, $unset: { changes: '' } },
      );
      return;
    }
    await this.mark(store, areas, flags);
  }

  /** Checks a product saved in a business with an approved store. */
  async productSaved(productId: string): Promise<void> {
    if (!Types.ObjectId.isValid(productId)) return;
    const stores = await this.stores.find({ liveSince: { $exists: true } });
    if (stores.length === 0) return;
    const product = await this.products.findById(new Types.ObjectId(productId), {
      name: 1,
      description: 1,
      tags: 1,
      status: 1,
    });
    const where = `product:${productId}`;
    const found =
      product?.status === 'active'
        ? precheckStore([
            {
              where,
              label: `Product: ${product.name}`,
              text: `${product.name} ${product.description} ${product.tags.join(' ')}`,
            },
          ])
        : [];
    for (const store of stores) {
      const others = (store.changes?.flags ?? []).filter((f) => f.where !== where);
      if (found.length) await this.mark(store, ['products'], [...others, ...found]);
      else if (store.changes && others.length !== store.changes.flags.length)
        // The product was fixed or taken down: its warning goes, the change stays to look at.
        await this.stores.updateOne(
          { _id: store._id, changes: { $exists: true } },
          { $set: { 'changes.flags': others } },
        );
    }
  }

  private async mark(store: StoreDoc, areas: StoreChangeArea[], flags: ReviewFlag[]) {
    const now = new Date();
    await this.stores.updateOne(
      { _id: store._id },
      {
        $set: { 'changes.lastAt': now, 'changes.flags': flags.slice(0, MAX_FLAGS) },
        $min: { 'changes.since': now },
        $addToSet: { 'changes.areas': { $each: areas } },
      },
    );
  }

  @OnEvent(AUDIT_RECORDED, { async: true, promisify: true, suppressErrors: true })
  async onAudit(event: Pick<AuditEvent, 'action' | 'orgId' | 'target'>): Promise<void> {
    if (!PRODUCT_SAVED.has(event.action) || !event.orgId || !event.target?.id) return;
    const orgId = event.orgId.toHexString();
    const productId = event.target.id;
    try {
      await RequestContext.withTenant(orgId, () => this.productSaved(productId), {
        type: 'system',
        id: 'store-changes',
      });
    } catch (err) {
      this.logger.error({ err, orgId, productId }, 'Could not check a saved product');
    }
  }
}
