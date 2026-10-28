import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { randomToken } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import { zodIssuesToFieldErrors } from '../../common/filters/problem-details.filter.js';
import { AppConfig } from '../../config/app-config.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { AuditService } from '../audit/audit.service.js';
import {
  CourierError,
  type CourierContext,
  type CourierKey,
  type CourierProvider,
  type CourierSettings,
  type StoreOption,
} from './courier.types.js';
import { CourierProviders } from './providers/courier-providers.js';
import { CourierAccountRepository, ParcelRepository } from './repositories.js';
import type { CourierAccount } from './schemas.js';

export type CourierAccountDoc = WithId<CourierAccount>;

const MAX_ACCOUNTS = 10;
const WEBHOOK_KEY = /^cw_[A-Za-z0-9_-]{32}$/;

const credentialsAad = (accountId: Types.ObjectId | string) => `courier:${String(accountId)}`;
const webhookAad = (accountId: Types.ObjectId | string) => `courier-webhook:${String(accountId)}`;

/** Keeps the chosen store's name next to its id, as the courier lists it. */
function nameStore(provider: CourierProvider, settings: CourierSettings, stores: StoreOption[]) {
  if (!settings.storeId || provider.descriptor.pickupStore === 'none') return;
  const store = stores.find((s) => s.id === settings.storeId);
  if (store) settings.storeName = store.name;
}

export interface CourierAccountInput {
  provider: CourierKey;
  name: string;
  credentials: Record<string, unknown>;
  sandbox?: boolean;
  settings?: CourierSettings;
  defaultWeightGrams?: number;
  isDefault?: boolean;
}

export interface CourierAccountPatch {
  name?: string;
  credentials?: Record<string, unknown>;
  sandbox?: boolean;
  /** Merged into the saved settings: a missing key keeps its value, null clears it. */
  settings?: { [K in keyof CourierSettings]?: CourierSettings[K] | null };
  defaultWeightGrams?: number;
  enabled?: boolean;
  isDefault?: boolean;
}

/** The result of asking the courier whether the credentials work. */
export interface CourierCheck {
  ok: boolean;
  summary: string;
  stores: StoreOption[];
}

/**
 * Each business's courier accounts. Credentials are checked with the courier before they
 * are saved, stored encrypted, and never returned.
 */
@Injectable()
export class CourierAccountsService {
  constructor(
    private readonly accounts: CourierAccountRepository,
    private readonly parcels: ParcelRepository,
    @InjectModel('CourierAccount') private readonly accountModel: Model<CourierAccount>,
    private readonly providers: CourierProviders,
    private readonly encryption: EncryptionService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  provider(key: CourierKey): CourierProvider {
    return this.providers.get(key);
  }

  webhookUrl(a: Pick<CourierAccount, 'webhookKey'>): string {
    return `${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/v1/webhooks/couriers/${a.webhookKey}`;
  }

  webhookSecret(a: Pick<CourierAccountDoc, '_id' | 'webhookSecretEnc'>): string {
    return this.encryption.decrypt(a.webhookSecretEnc, webhookAad(a._id));
  }

  toDto(a: CourierAccountDoc) {
    const d = this.provider(a.provider).descriptor;
    return {
      id: a._id.toHexString(),
      provider: a.provider,
      providerName: d.name,
      name: a.name,
      isDefault: a.isDefault,
      enabled: a.enabled,
      status: a.status,
      statusReason: a.statusReason ?? null,
      sandbox: a.sandbox,
      credentialsHint: a.credentialsHint,
      settings: {
        deliveryType: a.settings.deliveryType ?? null,
        storeId: a.settings.storeId ?? null,
        storeName: a.settings.storeName ?? null,
      },
      defaultWeightGrams: a.defaultWeightGrams,
      lastCheck: a.lastCheck
        ? { at: a.lastCheck.at.toISOString(), ok: a.lastCheck.ok, summary: a.lastCheck.summary }
        : null,
      // Only staff who manage integrations reach this DTO; they paste these into the courier's panel.
      webhook: {
        url: this.webhookUrl(a),
        secret: d.webhookAuth === 'url' ? null : this.webhookSecret(a),
        auth: d.webhookAuth,
        help: d.webhookHelp,
        lastReceivedAt: a.lastWebhookAt?.toISOString() ?? null,
      },
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  /** What staff who book parcels need to know about an account (nothing secret). */
  toChoiceDto(a: CourierAccountDoc) {
    const d = this.provider(a.provider).descriptor;
    return {
      id: a._id.toHexString(),
      provider: a.provider,
      providerName: d.name,
      name: a.name,
      isDefault: a.isDefault,
      enabled: a.enabled,
      status: a.status,
      ready: a.enabled && (d.pickupStore !== 'required' || Boolean(a.settings.storeId)),
      location: d.location,
      locationRequired: d.locationRequired,
      weightGrams: d.weightGrams,
      defaultWeightGrams: a.defaultWeightGrams,
    };
  }

  /** Couriers Sellora supports, with the fields their forms need. */
  descriptors() {
    return this.providers.all().map((p) => p.descriptor);
  }

  async list(): Promise<CourierAccountDoc[]> {
    return this.accounts.find({}, { sort: { isDefault: -1, createdAt: 1 } });
  }

  async get(id: string): Promise<CourierAccountDoc> {
    const a = await this.accounts.findById(id);
    if (!a) throw AppError.notFound('courier_account');
    return a;
  }

  /** The account to book with: the one asked for, or the default. Must be switched on. */
  async forBooking(id?: string): Promise<CourierAccountDoc> {
    const a = id
      ? await this.accounts.findById(id)
      : await this.accounts.findOne({ isDefault: true, enabled: true });
    if (!a)
      throw id
        ? AppError.notFound('courier_account')
        : AppError.unprocessable(
            'no_courier_account',
            'Connect a courier in Settings › Couriers first, or choose one.',
          );
    if (!a.enabled)
      throw AppError.unprocessable(
        'courier_account_disabled',
        `${a.name} is turned off. Turn it on in Settings › Couriers to book with it.`,
      );
    return a;
  }

  context(a: CourierAccountDoc): CourierContext<unknown> {
    const json = JSON.parse(
      this.encryption.decrypt(a.credentialsEnc, credentialsAad(a._id)),
    ) as unknown;
    return {
      accountId: a._id.toHexString(),
      credentials: this.provider(a.provider).credentials.parse(json),
      settings: a.settings,
      sandbox: a.sandbox,
    };
  }

  private parseCredentials(provider: CourierProvider, raw: unknown) {
    const parsed = provider.credentials.safeParse(raw);
    if (!parsed.success)
      throw AppError.validation(
        zodIssuesToFieldErrors(parsed.error).map((e) => ({
          ...e,
          path: `credentials.${e.path}`,
        })),
      );
    return parsed.data;
  }

  private validateSettings(provider: CourierProvider, settings: CourierSettings): CourierSettings {
    const d = provider.descriptor;
    const out: CourierSettings = {};
    if (settings.deliveryType) {
      if (!d.deliveryTypes.some((t) => t.value === settings.deliveryType))
        throw AppError.validation([
          { path: 'settings.deliveryType', message: `${d.name} has no such delivery type` },
        ]);
      out.deliveryType = settings.deliveryType;
    }
    if (settings.storeId) {
      if (d.pickupStore === 'none')
        throw AppError.validation([
          { path: 'settings.storeId', message: `${d.name} does not use pickup stores` },
        ]);
      out.storeId = settings.storeId;
    }
    return out;
  }

  /** Asks the courier whether the credentials work. Unreachable couriers are a 503. */
  private async verify(provider: CourierProvider, ctx: CourierContext<unknown>) {
    try {
      return await provider.verify(ctx);
    } catch (err) {
      if (!(err instanceof CourierError)) throw err;
      if (err.kind === 'unavailable' || err.kind === 'busy' || err.kind === 'uncertain')
        throw new AppError('courier_unavailable', 503, err.message);
      throw AppError.unprocessable('courier_check_failed', err.message);
    }
  }

  async create(
    input: CourierAccountInput,
  ): Promise<{ account: CourierAccountDoc; check: CourierCheck }> {
    const provider = this.provider(input.provider);
    const d = provider.descriptor;
    if (input.sandbox && !d.sandbox)
      throw AppError.validation([{ path: 'sandbox', message: `${d.name} has no sandbox` }]);
    const credentials = this.parseCredentials(provider, input.credentials);
    const settings = this.validateSettings(provider, input.settings ?? {});
    if ((await this.accounts.count()) >= MAX_ACCOUNTS)
      throw AppError.unprocessable(
        'courier_account_limit',
        `A business can connect at most ${MAX_ACCOUNTS} courier accounts.`,
      );

    const _id = new Types.ObjectId();
    const ctx = {
      accountId: _id.toHexString(),
      credentials,
      settings,
      sandbox: input.sandbox ?? false,
    };
    const result = await this.verify(provider, ctx);
    // A courier with one pickup store needs no choice.
    if (!settings.storeId && d.pickupStore !== 'none' && result.stores.length === 1)
      settings.storeId = result.stores[0]!.id;
    nameStore(provider, settings, result.stores);

    const first = (await this.accounts.count()) === 0;
    const makeDefault = first || input.isDefault === true;
    if (makeDefault)
      await this.accounts.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    const actor = RequestContext.actor();
    const account = await this.accounts.create({
      _id,
      provider: input.provider,
      name: input.name,
      isDefault: makeDefault,
      enabled: true,
      status: 'active',
      sandbox: ctx.sandbox,
      credentialsEnc: this.encryption.encrypt(JSON.stringify(credentials), credentialsAad(_id)),
      credentialsHint: provider.hint(credentials),
      settings,
      defaultWeightGrams: input.defaultWeightGrams ?? 500,
      webhookKey: `cw_${randomToken(24)}`,
      webhookSecretEnc: this.encryption.encrypt(randomToken(24), webhookAad(_id)),
      lastCheck: { at: new Date(), ok: true, summary: result.summary },
      ...(actor.type === 'user' ? { createdBy: new Types.ObjectId(actor.id) } : {}),
    });
    await this.audit.record({
      action: 'courier.account.created',
      orgId: this.orgId(),
      target: { type: 'courier_account', id: _id.toHexString(), label: input.name },
      metadata: { provider: input.provider, sandbox: ctx.sandbox },
    });
    return { account, check: { ok: true, summary: result.summary, stores: result.stores } };
  }

  async update(
    id: string,
    patch: CourierAccountPatch,
  ): Promise<{ account: CourierAccountDoc; check: CourierCheck | null }> {
    const before = await this.get(id);
    const provider = this.provider(before.provider);
    const d = provider.descriptor;
    if (patch.sandbox && !d.sandbox)
      throw AppError.validation([{ path: 'sandbox', message: `${d.name} has no sandbox` }]);
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.defaultWeightGrams !== undefined) set.defaultWeightGrams = patch.defaultWeightGrams;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    let settings: CourierSettings = before.settings;
    if (patch.settings) {
      const merged: CourierSettings = {
        ...(before.settings.deliveryType ? { deliveryType: before.settings.deliveryType } : {}),
        ...(before.settings.storeId ? { storeId: before.settings.storeId } : {}),
      };
      for (const key of ['deliveryType', 'storeId'] as const) {
        const value = patch.settings[key];
        if (value === null) delete merged[key];
        else if (value !== undefined) merged[key] = value;
      }
      settings = this.validateSettings(provider, merged);
      if (settings.storeId && settings.storeId === before.settings.storeId)
        settings.storeName = before.settings.storeName;
      set.settings = settings;
    }

    // New credentials, a switch to or from the sandbox, or a new pickup store are checked
    // with the courier first.
    const storeChanged = Boolean(settings.storeId) && settings.storeId !== before.settings.storeId;
    let check: CourierCheck | null = null;
    if (
      patch.credentials !== undefined ||
      (patch.sandbox !== undefined && patch.sandbox !== before.sandbox) ||
      storeChanged
    ) {
      const credentials =
        patch.credentials !== undefined
          ? this.parseCredentials(provider, patch.credentials)
          : this.context(before).credentials;
      const sandbox = patch.sandbox ?? before.sandbox;
      const result = await this.verify(provider, { accountId: id, credentials, settings, sandbox });
      check = { ok: true, ...result };
      if (storeChanged && !result.stores.some((s) => s.id === settings.storeId))
        throw AppError.validation([
          {
            path: 'settings.storeId',
            message: `${d.name} has no pickup store ${settings.storeId}`,
          },
        ]);
      nameStore(provider, settings, result.stores);
      set.settings = settings;
      if (patch.credentials !== undefined) {
        set.credentialsEnc = this.encryption.encrypt(
          JSON.stringify(credentials),
          credentialsAad(before._id),
        );
        set.credentialsHint = provider.hint(credentials);
      }
      set.sandbox = sandbox;
      set.status = 'active';
      unset.statusReason = '';
      set.lastCheck = { at: new Date(), ok: true, summary: result.summary };
    }

    if (patch.isDefault === true && !before.isDefault)
      await this.accounts.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    if (patch.isDefault !== undefined) set.isDefault = patch.isDefault;

    const account = await this.accounts.findOneAndUpdate(
      { _id: before._id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
    if (!account) throw AppError.notFound('courier_account');
    await this.audit.record({
      action: 'courier.account.updated',
      orgId: this.orgId(),
      target: { type: 'courier_account', id, label: account.name },
      metadata: {
        fields: Object.keys(patch).filter((k) => k !== 'credentials'),
        credentialsChanged: patch.credentials !== undefined,
      },
    });
    return { account, check };
  }

  /** Accounts with parcels still on the way cannot be removed (they would stop being tracked). */
  async remove(id: string): Promise<void> {
    const a = await this.get(id);
    const open = await this.parcels.count({
      accountId: a._id,
      status: {
        $in: ['queued', 'sending', 'booked', 'picked_up', 'in_transit', 'on_hold', 'returning'],
      },
    });
    if (open > 0)
      throw AppError.conflict(
        'courier_account_in_use',
        `${open} parcel${open === 1 ? ' is' : 's are'} still on the way with ${a.name}. Turn the account off instead; it keeps tracking them.`,
        { openParcels: open },
      );
    await this.accounts.deleteOne({ _id: a._id });
    if (a.isDefault) {
      const next = await this.accounts.findOne({ enabled: true }, undefined, {
        sort: { createdAt: 1 },
      });
      if (next) await this.accounts.updateOne({ _id: next._id }, { $set: { isDefault: true } });
    }
    await this.audit.record({
      action: 'courier.account.removed',
      orgId: this.orgId(),
      target: { type: 'courier_account', id, label: a.name },
      metadata: { provider: a.provider },
    });
  }

  /** Checks saved credentials again (and lists pickup stores). */
  async check(id: string): Promise<{ account: CourierAccountDoc; check: CourierCheck }> {
    const a = await this.get(id);
    const provider = this.provider(a.provider);
    let check: CourierCheck;
    try {
      const result = await provider.verify(this.context(a));
      check = { ok: true, ...result };
    } catch (err) {
      if (!(err instanceof CourierError)) throw err;
      if (err.kind !== 'auth' && err.kind !== 'rejected')
        throw new AppError('courier_unavailable', 503, err.message);
      check = { ok: false, summary: err.message, stores: [] };
    }
    const lastCheck = { at: new Date(), ok: check.ok, summary: check.summary };
    // The courier's current name for the chosen store (it may have been renamed there).
    const settings: CourierSettings = { ...a.settings };
    nameStore(provider, settings, check.stores);
    const account = await this.accounts.findOneAndUpdate(
      { _id: a._id },
      check.ok
        ? { $set: { status: 'active', lastCheck, settings }, $unset: { statusReason: '' } }
        : { $set: { status: 'error', statusReason: check.summary, lastCheck } },
    );
    return { account: account!, check };
  }

  async rotateWebhookSecret(id: string): Promise<CourierAccountDoc> {
    const a = await this.get(id);
    const account = await this.accounts.findOneAndUpdate(
      { _id: a._id },
      { $set: { webhookSecretEnc: this.encryption.encrypt(randomToken(24), webhookAad(a._id)) } },
    );
    await this.audit.record({
      action: 'courier.account.webhook_secret_rotated',
      orgId: this.orgId(),
      target: { type: 'courier_account', id, label: a.name },
    });
    return account!;
  }

  /** The courier refused the credentials while booking or tracking: show it in Settings. */
  async markRejected(accountId: Types.ObjectId, reason: string): Promise<void> {
    await this.accounts.updateOne(
      { _id: accountId },
      { $set: { status: 'error', statusReason: reason.slice(0, 300) } },
    );
  }

  async markWorking(accountId: Types.ObjectId): Promise<void> {
    await this.accounts.updateOne(
      { _id: accountId, status: 'error' },
      { $set: { status: 'active' }, $unset: { statusReason: '' } },
    );
  }

  /** The account behind a webhook address, from any business. */
  async findByWebhookKey(key: string): Promise<CourierAccountDoc | null> {
    if (!WEBHOOK_KEY.test(key)) return null;
    return this.accountModel
      .findOne({ webhookKey: key }, null, { [CROSS_TENANT]: true })
      .lean<CourierAccountDoc>()
      .exec();
  }

  async noteWebhook(accountId: Types.ObjectId): Promise<void> {
    await this.accounts.updateOne({ _id: accountId }, { $set: { lastWebhookAt: new Date() } });
  }
}
