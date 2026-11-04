import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { RequestContext } from '../../common/context/request-context.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import { ShopSettingsRepository } from './repositories.js';
import type { ShopSettings } from './schemas.js';

export type ShopSettingsDoc = WithId<ShopSettings>;

export function toShopSettingsDto(s: ShopSettingsDoc) {
  return {
    deliveryZones: s.deliveryZones.map((z) => ({
      id: z.id,
      name: z.name,
      chargeMinor: z.chargeMinor,
    })),
    defaultZoneId: s.defaultZoneId ?? null,
    invoiceNote: s.invoiceNote,
    lowStockThreshold: s.lowStockThreshold,
    autoConfirmManualOrders: s.autoConfirmManualOrders,
  };
}

/** Delivery charges and selling preferences, one document per business. */
@Injectable()
export class ShopSettingsService {
  constructor(
    private readonly repo: ShopSettingsRepository,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<ShopSettingsDoc> {
    const existing = await this.repo.findOne({});
    if (existing) return existing;
    try {
      return await this.repo.create({ deliveryZones: [], invoiceNote: '' });
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.repo.findOne({}))!;
      throw err;
    }
  }

  async update(input: {
    deliveryZones?: { id?: string; name: string; chargeMinor: number }[];
    defaultZoneId?: string | null;
    invoiceNote?: string;
    lowStockThreshold?: number;
    autoConfirmManualOrders?: boolean;
  }): Promise<ShopSettingsDoc> {
    const before = await this.get();
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    let zones = before.deliveryZones;
    if (input.deliveryZones) {
      zones = input.deliveryZones.map((z) => ({
        id: z.id ?? randomUUID().slice(0, 8),
        name: z.name,
        chargeMinor: z.chargeMinor,
      }));
      $set.deliveryZones = zones;
    }
    let defaultZone =
      input.defaultZoneId !== undefined ? input.defaultZoneId : (before.defaultZoneId ?? null);
    if (defaultZone && !zones.some((z) => z.id === defaultZone)) {
      if (input.defaultZoneId)
        throw AppError.validation([
          { path: 'defaultZoneId', message: 'Pick one of the delivery zones' },
        ]);
      defaultZone = null; // the default zone was removed
    }
    if (defaultZone) $set.defaultZoneId = defaultZone;
    else $unset.defaultZoneId = '';
    if (input.invoiceNote !== undefined) $set.invoiceNote = input.invoiceNote;
    if (input.lowStockThreshold !== undefined) $set.lowStockThreshold = input.lowStockThreshold;
    if (input.autoConfirmManualOrders !== undefined)
      $set.autoConfirmManualOrders = input.autoConfirmManualOrders;
    const after = await this.repo.findOneAndUpdate(
      {},
      {
        ...(Object.keys($set).length ? { $set } : {}),
        ...(Object.keys($unset).length ? { $unset } : {}),
      },
    );
    await this.audit.record({
      action: 'shop.settings.updated',
      orgId: RequestContext.tenant()!.orgId,
      metadata: { before: toShopSettingsDto(before), after: toShopSettingsDto(after!) },
    });
    return after!;
  }
}
