import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AdPlatformError,
  type AdPlatform,
  type ConsentMode,
  type PurchaseWhen,
} from './ad-tracking.types.js';
import { AdPlatforms } from './platforms/ad-platforms.js';
import { AdDestinationRepository, AdTrackingSettingsRepository } from './repositories.js';
import type { AdDestination, AdTrackingSettings, CheckState } from './schemas.js';

export type AdDestinationDoc = WithId<AdDestination>;
export type AdTrackingSettingsDoc = WithId<AdTrackingSettings>;

/** A business has at most this many tracking ids. */
export const MAX_DESTINATIONS = 12;

const secretAad = (id: Types.ObjectId | string) => `ad-destination:${String(id)}`;

/** A store or landing page a tracking id is used on. */
export type AdSite = { type: 'store'; id: string } | { type: 'landing'; id: string };

export interface DestinationInput {
  platform: AdPlatform;
  name?: string;
  publicId: string;
  conversionLabel?: string;
  secret?: string;
  testCode?: string;
  everywhere?: boolean;
  storeIds?: string[];
  landingPageIds?: string[];
  purchaseWhen?: PurchaseWhen;
  chatOrders?: boolean;
}

export interface DestinationPatch {
  name?: string;
  /** A new server key; an empty string removes it. */
  secret?: string;
  testCode?: string;
  conversionLabel?: string;
  enabled?: boolean;
  everywhere?: boolean;
  storeIds?: string[];
  landingPageIds?: string[];
  purchaseWhen?: PurchaseWhen;
  chatOrders?: boolean;
}

/** What the storefront needs to load the browser tags (public ids only, never keys). */
export interface PublicTracking {
  consent: ConsentMode;
  meta: { pixelId: string; purchase: boolean }[];
  tiktok: { pixelCode: string; purchase: boolean }[];
  ga4: { measurementId: string }[];
  googleAds: { conversionId: string; purchaseLabel: string | null; purchase: boolean }[];
}

/**
 * The business's own tracking ids for its stores and landing pages (ADR 0030): checked
 * where the platform allows, keys stored encrypted and never returned.
 */
@Injectable()
export class AdDestinationsService {
  constructor(
    private readonly destinations: AdDestinationRepository,
    private readonly settingsRepo: AdTrackingSettingsRepository,
    private readonly platforms: AdPlatforms,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  descriptors() {
    return this.platforms.descriptors().map((d) => ({
      key: d.key,
      name: d.name,
      publicIdLabel: d.publicIdLabel,
      publicIdHint: d.publicIdHint,
      publicIdPattern: d.publicIdPattern.source,
      secretLabel: d.secretLabel,
      secretHint: d.secretHint,
      testCodeLabel: d.testCodeLabel,
      conversionLabel: d.conversionLabel,
      serverEvents: d.serverEvents,
      chatOrders: d.chatOrders,
    }));
  }

  toDto(d: AdDestinationDoc) {
    return {
      id: d._id.toHexString(),
      platform: d.platform,
      platformName: this.platforms.descriptor(d.platform).name,
      name: d.name,
      publicId: d.publicId,
      conversionLabel: d.conversionLabel ?? null,
      hasSecret: Boolean(d.secretEnc),
      secretHint: d.secretHint ?? null,
      testCode: d.testCode ?? null,
      enabled: d.enabled,
      everywhere: d.everywhere,
      storeIds: d.storeIds.map(String),
      landingPageIds: d.landingPageIds.map(String),
      purchaseWhen: d.purchaseWhen,
      chatOrders: d.chatOrders,
      lastCheck: {
        at: d.lastCheck.at.toISOString(),
        state: d.lastCheck.state,
        summary: d.lastCheck.summary,
      },
      lastSentAt: d.lastSentAt?.toISOString() ?? null,
      lastError: d.lastError
        ? { at: d.lastError.at.toISOString(), message: d.lastError.message }
        : null,
      createdAt: d.createdAt.toISOString(),
    };
  }

  list(): Promise<AdDestinationDoc[]> {
    return this.destinations.find({}, { sort: { createdAt: 1 } });
  }

  async get(id: string): Promise<AdDestinationDoc> {
    const d = Types.ObjectId.isValid(id) ? await this.destinations.findById(id) : null;
    if (!d) throw AppError.notFound('tracking_id', 'There is no such tracking id.');
    return d;
  }

  secret(d: AdDestinationDoc): string | null {
    return d.secretEnc ? this.encryption.decrypt(d.secretEnc, secretAad(d._id)) : null;
  }

  /**
   * The stores and landing pages a tracking id can be limited to (names for the picker). Read
   * from their collections directly: the stores module depends on this one, not the reverse.
   */
  async sites() {
    const orgId = new Types.ObjectId(this.orgId());
    const [stores, pages] = await Promise.all([
      this.connection
        .collection('stores')
        .find({ orgId }, { projection: { name: 1 }, sort: { createdAt: 1 } })
        .toArray(),
      this.connection
        .collection('landing_pages')
        .find({ orgId }, { projection: { name: 1, slug: 1 }, sort: { createdAt: -1 } })
        .limit(200)
        .toArray(),
    ]);
    return {
      stores: stores.map((s) => ({ id: String(s._id), name: String(s.name) })),
      landingPages: pages.map((p) => ({
        id: String(p._id),
        name: String(p.name),
        slug: String(p.slug),
      })),
    };
  }

  private async scope(
    input: { everywhere?: boolean; storeIds?: string[]; landingPageIds?: string[] },
    before?: AdDestinationDoc,
  ) {
    const everywhere = input.everywhere ?? before?.everywhere ?? true;
    const storeIds = [...new Set(input.storeIds ?? before?.storeIds.map(String) ?? [])];
    const landingPageIds = [
      ...new Set(input.landingPageIds ?? before?.landingPageIds.map(String) ?? []),
    ];
    if (everywhere) return { everywhere, storeIds: [], landingPageIds: [] };
    if (!storeIds.length && !landingPageIds.length)
      throw AppError.validation([
        { path: 'everywhere', message: 'Choose at least one store or landing page' },
      ]);
    const known = await this.sites();
    const bad = (ids: string[], list: { id: string }[]) =>
      ids.some((id) => !list.some((x) => x.id === id));
    if (bad(storeIds, known.stores))
      throw AppError.validation([{ path: 'storeIds', message: 'Choose your own stores' }]);
    if (bad(landingPageIds, known.landingPages))
      throw AppError.validation([
        { path: 'landingPageIds', message: 'Choose your own landing pages' },
      ]);
    return {
      everywhere,
      storeIds: storeIds.map((id) => new Types.ObjectId(id)),
      landingPageIds: landingPageIds.map((id) => new Types.ObjectId(id)),
    };
  }

  /** Rules each platform's fields follow; the error points at the field to fix. */
  private validate(
    platform: AdPlatform,
    v: {
      publicId?: string;
      conversionLabel?: string | undefined;
      hasSecret: boolean;
      purchaseWhen: PurchaseWhen;
      chatOrders: boolean;
    },
  ) {
    const d = this.platforms.descriptor(platform);
    if (v.publicId !== undefined && !d.publicIdPattern.test(v.publicId))
      throw AppError.validation([
        { path: 'publicId', message: `This is not a ${d.name} ${d.publicIdLabel}` },
      ]);
    if (d.conversionLabel && v.conversionLabel !== undefined && !v.conversionLabel)
      throw AppError.validation([
        { path: 'conversionLabel', message: 'Enter the purchase conversion’s label' },
      ]);
    if (v.purchaseWhen === 'delivered' && !v.hasSecret)
      throw AppError.validation([
        {
          path: 'purchaseWhen',
          message: d.secretLabel
            ? `Counting purchases on delivery needs the ${d.secretLabel}`
            : `${d.name} can only count purchases when the order is placed`,
        },
      ]);
    if (v.chatOrders && (!d.chatOrders || !v.hasSecret))
      throw AppError.validation([
        {
          path: 'chatOrders',
          message: d.chatOrders
            ? `Orders from the inbox need the ${d.secretLabel}`
            : `${d.name} cannot take orders that did not come from a web page`,
        },
      ]);
  }

  /** Asks the platform about the id and key where it can. A refused key is a 422. */
  private async check(
    platform: AdPlatform,
    publicId: string,
    secret: string | undefined,
  ): Promise<{ state: CheckState; summary: string }> {
    const d = this.platforms.descriptor(platform);
    if (!secret)
      return {
        state: 'unchecked',
        summary: d.secretLabel
          ? 'Browser only. Add the server key so purchases still count when a browser blocks the tag.'
          : 'Runs in the shopper’s browser; Google Ads shows conversions a few hours later.',
      };
    if (platform === 'meta') {
      try {
        const { name } = await this.platforms.meta.check({ publicId, secret });
        return { state: 'ok', summary: `Meta accepted the token for the pixel “${name}”.` };
      } catch (err) {
        if (err instanceof AdPlatformError && !err.retry)
          throw AppError.unprocessable(
            'tracking_check_failed',
            `Meta did not accept this pixel and token: ${err.message}`,
          );
        return {
          state: 'unchecked',
          summary: 'Meta could not be reached to check the token; the first event will tell.',
        };
      }
    }
    return {
      state: 'unchecked',
      summary:
        platform === 'tiktok'
          ? 'Not checked yet. TikTok confirms the token with the first event: send a test event.'
          : 'Not checked. Google Analytics never reports a wrong secret: send a test event and look in DebugView.',
    };
  }

  async create(input: DestinationInput): Promise<AdDestinationDoc> {
    const d = this.platforms.descriptor(input.platform);
    if ((await this.destinations.count({})) >= MAX_DESTINATIONS)
      throw AppError.conflict(
        'tracking_limit',
        `A business can have up to ${MAX_DESTINATIONS} tracking ids.`,
      );
    const secret = d.secretLabel ? input.secret?.trim() || undefined : undefined;
    const purchaseWhen = input.purchaseWhen ?? 'placed';
    const chatOrders = input.chatOrders ?? false;
    this.validate(input.platform, {
      publicId: input.publicId,
      conversionLabel: d.conversionLabel ? (input.conversionLabel ?? '') : undefined,
      hasSecret: Boolean(secret),
      purchaseWhen,
      chatOrders,
    });
    if (await this.destinations.findOne({ platform: input.platform, publicId: input.publicId }))
      throw AppError.conflict('tracking_id_exists', `This ${d.publicIdLabel} is already added.`);
    const scope = await this.scope(input);
    const lastCheck = {
      at: new Date(),
      ...(await this.check(input.platform, input.publicId, secret)),
    };
    const _id = new Types.ObjectId();
    const actor = RequestContext.actor();
    let doc: AdDestinationDoc;
    try {
      doc = await this.destinations.create({
        _id,
        platform: input.platform,
        name: input.name?.trim() || `${d.name} ${input.publicId.slice(-4)}`,
        publicId: input.publicId,
        ...(d.conversionLabel && input.conversionLabel
          ? { conversionLabel: input.conversionLabel.trim() }
          : {}),
        ...(secret
          ? {
              secretEnc: this.encryption.encrypt(secret, secretAad(_id)),
              secretHint: `…${secret.slice(-4)}`,
            }
          : {}),
        ...(d.testCodeLabel && input.testCode?.trim() ? { testCode: input.testCode.trim() } : {}),
        enabled: true,
        ...scope,
        purchaseWhen,
        chatOrders,
        lastCheck,
        ...(actor.type === 'user' ? { createdBy: new Types.ObjectId(actor.id) } : {}),
      });
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('tracking_id_exists', `This ${d.publicIdLabel} is already added.`);
      throw err;
    }
    await this.audit.record({
      action: 'ad_tracking.added',
      orgId: this.orgId(),
      target: { type: 'tracking_id', id: _id.toHexString(), label: doc.name },
      metadata: { platform: input.platform, serverKey: Boolean(secret), purchaseWhen },
    });
    return doc;
  }

  async update(id: string, patch: DestinationPatch): Promise<AdDestinationDoc> {
    const before = await this.get(id);
    const d = this.platforms.descriptor(before.platform);
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    const newSecret =
      patch.secret !== undefined && d.secretLabel ? patch.secret.trim() || null : undefined;
    const hasSecret = newSecret === undefined ? Boolean(before.secretEnc) : Boolean(newSecret);
    const purchaseWhen = patch.purchaseWhen ?? before.purchaseWhen;
    const chatOrders = patch.chatOrders ?? before.chatOrders;
    this.validate(before.platform, {
      conversionLabel: d.conversionLabel ? patch.conversionLabel : undefined,
      hasSecret,
      purchaseWhen,
      chatOrders,
    });
    if (patch.name !== undefined) set.name = patch.name.trim() || before.name;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (d.conversionLabel && patch.conversionLabel !== undefined)
      set.conversionLabel = patch.conversionLabel.trim();
    if (d.testCodeLabel && patch.testCode !== undefined) {
      if (patch.testCode.trim()) set.testCode = patch.testCode.trim();
      else unset.testCode = '';
    }
    set.purchaseWhen = purchaseWhen;
    set.chatOrders = chatOrders;
    if (
      patch.everywhere !== undefined ||
      patch.storeIds !== undefined ||
      patch.landingPageIds !== undefined
    )
      Object.assign(set, await this.scope(patch, before));
    if (newSecret !== undefined) {
      set.lastCheck = {
        at: new Date(),
        ...(await this.check(before.platform, before.publicId, newSecret ?? undefined)),
      };
      unset.lastError = '';
      if (newSecret) {
        set.secretEnc = this.encryption.encrypt(newSecret, secretAad(before._id));
        set.secretHint = `…${newSecret.slice(-4)}`;
      } else {
        unset.secretEnc = '';
        unset.secretHint = '';
      }
    }
    const after = await this.destinations.findOneAndUpdate(
      { _id: before._id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
    if (!after) throw AppError.notFound('tracking_id', 'There is no such tracking id.');
    await this.audit.record({
      action: 'ad_tracking.updated',
      orgId: this.orgId(),
      target: { type: 'tracking_id', id, label: after.name },
      metadata: {
        fields: Object.keys(patch).filter((k) => k !== 'secret'),
        serverKeyChanged: newSecret !== undefined,
        enabled: after.enabled,
      },
    });
    return after;
  }

  async remove(id: string): Promise<void> {
    const d = await this.get(id);
    await this.destinations.deleteOne({ _id: d._id });
    await this.audit.record({
      action: 'ad_tracking.removed',
      orgId: this.orgId(),
      target: { type: 'tracking_id', id, label: d.name },
      metadata: { platform: d.platform },
    });
  }

  /** Kept on the destination for the business to see: the last delivery or refusal. */
  async noteDelivery(id: Types.ObjectId, error: string | null): Promise<void> {
    await this.destinations.updateOne(
      { _id: id },
      error
        ? { $set: { lastError: { at: new Date(), message: error.slice(0, 300) } } }
        : { $set: { lastSentAt: new Date() }, $unset: { lastError: '' } },
    );
  }

  // ---------------------------------------------------------------- consent

  async settings(): Promise<AdTrackingSettingsDoc> {
    const existing = await this.settingsRepo.findOne({});
    if (existing) return existing;
    try {
      return await this.settingsRepo.create({});
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.settingsRepo.findOne({}))!;
      throw err;
    }
  }

  async updateSettings(patch: { consent: ConsentMode }): Promise<AdTrackingSettingsDoc> {
    const before = await this.settings();
    const after = await this.settingsRepo.findOneAndUpdate(
      { _id: before._id },
      { $set: { consent: patch.consent } },
    );
    if (before.consent !== patch.consent)
      await this.audit.record({
        action: 'ad_tracking.consent_changed',
        orgId: this.orgId(),
        target: { type: 'ad_tracking_settings', id: before._id.toHexString() },
        metadata: { consent: patch.consent },
      });
    return after!;
  }

  // ---------------------------------------------------------------- shoppers

  /** Whether a switched-on destination is used on this store or landing page. */
  static covers(d: AdDestination, site: AdSite): boolean {
    if (!d.enabled) return false;
    if (d.everywhere) return true;
    return site.type === 'store'
      ? d.storeIds.some((id) => String(id) === site.id)
      : d.landingPageIds.some((id) => String(id) === site.id);
  }

  async forSite(site: AdSite): Promise<AdDestinationDoc[]> {
    const all = await this.destinations.find({ enabled: true }, { sort: { createdAt: 1 } });
    return all.filter((d) => AdDestinationsService.covers(d, site));
  }

  /** The browser tags for a store or landing page (inside its business). */
  async publicTracking(site: AdSite): Promise<PublicTracking> {
    const [list, settings] = await Promise.all([this.forSite(site), this.settings()]);
    const placed = (d: AdDestinationDoc) => d.purchaseWhen === 'placed';
    return {
      consent: settings.consent,
      meta: list
        .filter((d) => d.platform === 'meta')
        .map((d) => ({ pixelId: d.publicId, purchase: placed(d) })),
      tiktok: list
        .filter((d) => d.platform === 'tiktok')
        .map((d) => ({ pixelCode: d.publicId, purchase: placed(d) })),
      ga4: list.filter((d) => d.platform === 'ga4').map((d) => ({ measurementId: d.publicId })),
      googleAds: list
        .filter((d) => d.platform === 'google_ads')
        .map((d) => ({
          conversionId: d.publicId,
          purchaseLabel: d.conversionLabel ?? null,
          purchase: placed(d),
        })),
    };
  }
}
