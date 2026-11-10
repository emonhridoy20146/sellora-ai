import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import {
  isDuplicateKey,
  zodIssuesToFieldErrors,
} from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { AuditService } from '../audit/audit.service.js';
import { GatewayError } from '../billing/payments/gateway.types.js';
import type { ShopGatewayKey } from '../commerce/schemas.js';
import { ShopSettingsService } from '../commerce/shop-settings.service.js';
import type { GatewayChoice } from './checkout-options.js';
import { ShopGateways } from './gateways/shop-gateways.js';
import {
  ShopPaymentAccountRepository,
  ShopPaymentRepository,
  ShopPaymentSettingsRepository,
} from './repositories.js';
import type { AdvanceMode, ShopPaymentAccount, ShopPaymentSettings } from './schemas.js';

export type ShopPaymentAccountDoc = WithId<ShopPaymentAccount>;
export type ShopPaymentSettingsDoc = WithId<ShopPaymentSettings>;

const credentialsAad = (id: Types.ObjectId | string) => `shop-gateway:${String(id)}`;

export interface SettingsPatch {
  cod?: boolean;
  fullOnline?: boolean;
  advance?: {
    mode?: AdvanceMode;
    fixedMinor?: number;
    percent?: number;
    zoneIds?: string[];
    minTotalMinor?: number;
  };
}

/**
 * Each business's own gateway accounts and payment options for checkout (ADR 0029).
 * Credentials are checked with the gateway where it allows, stored encrypted and never
 * returned.
 */
@Injectable()
export class ShopPaymentAccountsService {
  constructor(
    private readonly accounts: ShopPaymentAccountRepository,
    private readonly settingsRepo: ShopPaymentSettingsRepository,
    private readonly payments: ShopPaymentRepository,
    private readonly gateways: ShopGateways,
    private readonly encryption: EncryptionService,
    private readonly shopSettings: ShopSettingsService,
    private readonly audit: AuditService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  /** The five gateways with the fields their forms need. */
  descriptors() {
    return this.gateways.all().map((g) => g.descriptor);
  }

  toDto(a: ShopPaymentAccountDoc) {
    const d = this.gateways.get(a.gateway).descriptor;
    return {
      id: a._id.toHexString(),
      gateway: a.gateway,
      name: d.name,
      enabled: a.enabled,
      sandbox: a.sandbox,
      credentialsHint: a.credentialsHint,
      lastCheck: {
        at: a.lastCheck.at.toISOString(),
        checked: a.lastCheck.checked,
        summary: a.lastCheck.summary,
      },
      lastError: a.lastError
        ? { at: a.lastError.at.toISOString(), message: a.lastError.message }
        : null,
      lastPaymentAt: a.lastPaymentAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  list(): Promise<ShopPaymentAccountDoc[]> {
    return this.accounts.find({}, { sort: { createdAt: 1 } });
  }

  async get(id: string): Promise<ShopPaymentAccountDoc> {
    const a = Types.ObjectId.isValid(id) ? await this.accounts.findById(id) : null;
    if (!a) throw AppError.notFound('payment_account');
    return a;
  }

  /** The switched-on account for a gateway, if there is one. */
  enabledFor(gateway: ShopGatewayKey): Promise<ShopPaymentAccountDoc | null> {
    return this.accounts.findOne({ gateway, enabled: true });
  }

  /** Switched-on gateways, in the order shoppers see them. */
  async choices(): Promise<GatewayChoice[]> {
    const on = await this.accounts.find({ enabled: true });
    return this.gateways.all().flatMap((g) => {
      const a = on.find((x) => x.gateway === g.descriptor.key);
      return a
        ? [
            {
              key: g.descriptor.key,
              name: g.descriptor.name,
              hint: g.descriptor.shopperHint,
              sandbox: a.sandbox,
            },
          ]
        : [];
    });
  }

  credentials(a: ShopPaymentAccountDoc): Record<string, string> {
    const json = JSON.parse(
      this.encryption.decrypt(a.credentialsEnc, credentialsAad(a._id)),
    ) as unknown;
    return this.gateways.get(a.gateway).credentials.parse(json);
  }

  private parse(gateway: ShopGatewayKey, raw: unknown): Record<string, string> {
    const parsed = this.gateways.get(gateway).credentials.safeParse(raw);
    if (!parsed.success)
      throw AppError.validation(
        zodIssuesToFieldErrors(parsed.error).map((e) => ({
          ...e,
          path: `credentials.${e.path}`,
        })),
      );
    return parsed.data;
  }

  /** Asks the gateway whether the keys work. A refusal is a 422, an unreachable gateway 503. */
  private async check(gateway: ShopGatewayKey, creds: Record<string, string>, sandbox: boolean) {
    try {
      return await this.gateways.get(gateway).check(creds, sandbox);
    } catch (err) {
      if (err instanceof GatewayError) {
        const status = Number(err.details.httpStatus);
        if (Number.isFinite(status) && status >= 500)
          throw new AppError(
            'payment_gateway_unavailable',
            503,
            `${this.gateways.get(gateway).descriptor.name} did not answer. Try again in a few minutes.`,
          );
        throw AppError.unprocessable(
          'payment_account_check_failed',
          `${this.gateways.get(gateway).descriptor.name} did not accept these keys: ${err.message}`,
        );
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'TypeError'))
        throw new AppError(
          'payment_gateway_unavailable',
          503,
          `${this.gateways.get(gateway).descriptor.name} did not answer. Try again in a few minutes.`,
        );
      throw err;
    }
  }

  async create(input: {
    gateway: ShopGatewayKey;
    credentials: Record<string, unknown>;
    sandbox?: boolean;
  }): Promise<ShopPaymentAccountDoc> {
    const creds = this.parse(input.gateway, input.credentials);
    if (await this.accounts.findOne({ gateway: input.gateway }))
      throw AppError.conflict(
        'payment_account_exists',
        `${this.gateways.get(input.gateway).descriptor.name} is already connected. Change its keys instead.`,
      );
    const sandbox = input.sandbox ?? false;
    const result = await this.check(input.gateway, creds, sandbox);
    const _id = new Types.ObjectId();
    const actor = RequestContext.actor();
    let account: ShopPaymentAccountDoc;
    try {
      account = await this.accounts.create({
        _id,
        gateway: input.gateway,
        enabled: true,
        sandbox,
        credentialsEnc: this.encryption.encrypt(JSON.stringify(creds), credentialsAad(_id)),
        credentialsHint: this.gateways.get(input.gateway).hint(creds),
        lastCheck: { at: new Date(), ...result },
        ...(actor.type === 'user' ? { createdBy: new Types.ObjectId(actor.id) } : {}),
      });
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('payment_account_exists', 'This gateway is already connected.');
      throw err;
    }
    await this.audit.record({
      action: 'shop_payment.account_connected',
      orgId: this.orgId(),
      target: { type: 'payment_account', id: _id.toHexString(), label: input.gateway },
      metadata: { gateway: input.gateway, sandbox, checked: result.checked },
    });
    return account;
  }

  async update(
    id: string,
    patch: { credentials?: Record<string, unknown>; sandbox?: boolean; enabled?: boolean },
  ): Promise<ShopPaymentAccountDoc> {
    const before = await this.get(id);
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const sandbox = patch.sandbox ?? before.sandbox;
    if (patch.credentials !== undefined || sandbox !== before.sandbox) {
      const creds =
        patch.credentials !== undefined
          ? this.parse(before.gateway, patch.credentials)
          : this.credentials(before);
      const result = await this.check(before.gateway, creds, sandbox);
      set.sandbox = sandbox;
      set.lastCheck = { at: new Date(), ...result };
      unset.lastError = '';
      if (patch.credentials !== undefined) {
        set.credentialsEnc = this.encryption.encrypt(
          JSON.stringify(creds),
          credentialsAad(before._id),
        );
        set.credentialsHint = this.gateways.get(before.gateway).hint(creds);
      }
    }
    const after = await this.accounts.findOneAndUpdate(
      { _id: before._id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
    if (!after) throw AppError.notFound('payment_account');
    await this.audit.record({
      action: 'shop_payment.account_updated',
      orgId: this.orgId(),
      target: { type: 'payment_account', id, label: before.gateway },
      metadata: {
        fields: Object.keys(patch).filter((k) => k !== 'credentials'),
        credentialsChanged: patch.credentials !== undefined,
        sandbox: after.sandbox,
        enabled: after.enabled,
      },
    });
    return after;
  }

  /**
   * Refused while payments started with it are still being checked (their keys are read
   * from it); turning it off stops new payments at once.
   */
  async remove(id: string): Promise<void> {
    const a = await this.get(id);
    const open = await this.payments.count({ accountId: a._id, settled: false });
    if (open > 0)
      throw AppError.conflict(
        'payment_account_in_use',
        `${open} payment${open === 1 ? ' is' : 's are'} still being checked with ${this.gateways.get(a.gateway).descriptor.name}. Turn it off now and remove it in two days.`,
        { openPayments: open },
      );
    await this.accounts.deleteOne({ _id: a._id });
    await this.audit.record({
      action: 'shop_payment.account_removed',
      orgId: this.orgId(),
      target: { type: 'payment_account', id, label: a.gateway },
      metadata: { gateway: a.gateway },
    });
  }

  /** Kept on the account until a start works again, for the business to see. */
  async noteStart(accountId: Types.ObjectId, error: string | null): Promise<void> {
    await this.accounts.updateOne(
      { _id: accountId },
      error
        ? { $set: { lastError: { at: new Date(), message: error.slice(0, 300) } } }
        : { $set: { lastPaymentAt: new Date() }, $unset: { lastError: '' } },
    );
  }

  // ---------------------------------------------------------------- options

  async settings(): Promise<ShopPaymentSettingsDoc> {
    const existing = await this.settingsRepo.findOne({});
    if (existing) return existing;
    try {
      return await this.settingsRepo.create({});
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.settingsRepo.findOne({}))!;
      throw err;
    }
  }

  settingsDto(s: ShopPaymentSettingsDoc) {
    return {
      cod: s.cod,
      fullOnline: s.fullOnline,
      advance: {
        mode: s.advance.mode,
        fixedMinor: s.advance.fixedMinor,
        percent: s.advance.percent,
        zoneIds: s.advance.zoneIds,
        minTotalMinor: s.advance.minTotalMinor,
      },
    };
  }

  async updateSettings(patch: SettingsPatch): Promise<ShopPaymentSettingsDoc> {
    const before = await this.settings();
    const next = {
      cod: patch.cod ?? before.cod,
      fullOnline: patch.fullOnline ?? before.fullOnline,
      advance: { ...before.advance, ...(patch.advance ?? {}) },
    };
    if (!next.cod) {
      if (!next.fullOnline)
        throw AppError.validation([
          { path: 'cod', message: 'Keep cash on delivery on, or turn on paying in full online' },
        ]);
      if (!(await this.accounts.count({ enabled: true })))
        throw AppError.validation([
          { path: 'cod', message: 'Connect and switch on a payment gateway first' },
        ]);
    }
    const a = next.advance;
    if (a.mode === 'fixed' && a.fixedMinor <= 0)
      throw AppError.validation([{ path: 'advance.fixedMinor', message: 'Enter the advance' }]);
    if (a.mode === 'percent' && (a.percent <= 0 || a.percent > 100))
      throw AppError.validation([
        { path: 'advance.percent', message: 'Enter a percent from 1 to 100' },
      ]);
    if (a.zoneIds.length) {
      const zones = (await this.shopSettings.get()).deliveryZones.map((z) => z.id);
      const unknown = a.zoneIds.filter((z) => !zones.includes(z));
      if (unknown.length)
        throw AppError.validation([
          { path: 'advance.zoneIds', message: 'Choose delivery areas from Settings › Shop' },
        ]);
      a.zoneIds = [...new Set(a.zoneIds)];
    }
    const after = await this.settingsRepo.findOneAndUpdate(
      { _id: before._id },
      { $set: { cod: next.cod, fullOnline: next.fullOnline, advance: a } },
    );
    await this.audit.record({
      action: 'shop_payment.settings_updated',
      orgId: this.orgId(),
      target: { type: 'shop_payment_settings', id: before._id.toHexString() },
      metadata: { cod: next.cod, fullOnline: next.fullOnline, advance: a.mode },
    });
    return after!;
  }
}
