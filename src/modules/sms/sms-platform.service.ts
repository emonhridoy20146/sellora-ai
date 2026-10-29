import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AuditService } from '../audit/audit.service.js';
import {
  PLATFORM_CREDENTIALS_AAD,
  checkSenderId,
  checkWithProvider,
  parseCredentials,
} from './gateways.js';
import { SmsProviders } from './providers/sms-providers.js';
import type { SmsPlatform, SmsPrice } from './schemas.js';
import type { SmsContext, SmsProvider, SmsProviderKey } from './sms.types.js';

const ID = 'global';
const CACHE_MS = 10_000;

/** Placeholder prices (BDT, per part) until the super-admin sets real ones. */
export const DEFAULT_SMS_PRICES: SmsPrice[] = [
  { currency: 'BDT', perPartMinor: 50, senderNamePerPartMinor: 70 },
];
export const DEFAULT_SMS_COSTS: SmsPrice[] = [
  { currency: 'BDT', perPartMinor: 30, senderNamePerPartMinor: 45 },
];

export interface SmsPlatformPatch {
  enabled?: boolean;
  senderId?: string;
  prices?: SmsPrice[];
  costs?: SmsPrice[];
}

/** Sellora's own SMS account (the "Sellora SMS" route), configured in Admin › SMS. */
@Injectable()
export class SmsPlatformService {
  private cache?: { at: number; value: SmsPlatform };

  constructor(
    @InjectModel('SmsPlatform') private readonly model: Model<SmsPlatform>,
    private readonly providers: SmsProviders,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<SmsPlatform> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const doc = await this.model
      .findOneAndUpdate(
        { _id: ID },
        {
          $setOnInsert: {
            _id: ID,
            prices: DEFAULT_SMS_PRICES,
            costs: DEFAULT_SMS_COSTS,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .lean<SmsPlatform>()
      .exec();
    this.cache = { at: Date.now(), value: doc };
    return doc;
  }

  private forget(): void {
    this.cache = undefined;
  }

  /** Whether Sellora SMS can send right now (switched on and a provider connected). */
  ready(p: SmsPlatform): p is SmsPlatform & { provider: SmsProviderKey; credentialsEnc: string } {
    return p.enabled && Boolean(p.provider && p.credentialsEnc);
  }

  /** The price of one part in `currency`, from the shared sender or a sender name. */
  priceFor(list: SmsPrice[], currency: string, senderName: boolean): number | null {
    const p = list.find((x) => x.currency === currency);
    if (!p) return null;
    return senderName ? p.senderNamePerPartMinor : p.perPartMinor;
  }

  provider(p: SmsPlatform & { provider: SmsProviderKey }): SmsProvider {
    return this.providers.get(p.provider);
  }

  context(
    p: SmsPlatform & { provider: SmsProviderKey; credentialsEnc: string },
    senderId: string,
    statusCallbackUrl?: string,
  ): SmsContext<unknown> {
    const provider = this.provider(p);
    return {
      credentials: provider.credentials.parse(
        JSON.parse(this.encryption.decrypt(p.credentialsEnc, PLATFORM_CREDENTIALS_AAD)),
      ),
      ...(senderId ? { senderId } : {}),
      ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
    };
  }

  /** Credentials of the platform account, for checking a delivery callback. */
  credentials(p: SmsPlatform): unknown {
    if (!p.provider || !p.credentialsEnc) return null;
    return this.providers
      .get(p.provider)
      .credentials.parse(
        JSON.parse(this.encryption.decrypt(p.credentialsEnc, PLATFORM_CREDENTIALS_AAD)),
      );
  }

  toDto(p: SmsPlatform) {
    const d = p.provider ? this.providers.get(p.provider).descriptor : null;
    return {
      enabled: p.enabled,
      ready: this.ready(p),
      provider: p.provider ?? null,
      providerName: d?.name ?? null,
      credentialsHint: p.hint ?? null,
      senderId: p.senderId,
      reach: d?.reach ?? null,
      lastCheck: p.checkedAt
        ? { at: p.checkedAt.toISOString(), summary: p.checkSummary ?? '' }
        : null,
      prices: p.prices,
      costs: p.costs,
    };
  }

  /** Connects (or replaces) Sellora's provider account; the credentials are checked first. */
  async connect(input: {
    provider: SmsProviderKey;
    credentials: Record<string, unknown>;
    senderId?: string;
  }): Promise<{ platform: SmsPlatform; summary: string }> {
    const provider = this.providers.get(input.provider);
    const credentials = parseCredentials(provider, input.credentials);
    const senderId = checkSenderId(provider, input.senderId);
    const check = await checkWithProvider(provider, { credentials, senderId });
    await this.model
      .updateOne(
        { _id: ID },
        {
          $set: {
            provider: input.provider,
            credentialsEnc: this.encryption.encrypt(
              JSON.stringify(credentials),
              PLATFORM_CREDENTIALS_AAD,
            ),
            hint: provider.hint(credentials),
            senderId,
            checkedAt: new Date(),
            checkSummary: check.summary,
          },
        },
        { upsert: true },
      )
      .exec();
    this.forget();
    await this.audit.record({
      action: 'platform.sms.connected',
      metadata: { provider: input.provider, senderId },
    });
    return { platform: await this.get(), summary: check.summary };
  }

  async disconnect(): Promise<SmsPlatform> {
    await this.model
      .updateOne(
        { _id: ID },
        {
          $set: { enabled: false },
          $unset: { provider: 1, credentialsEnc: 1, hint: 1, checkedAt: 1, checkSummary: 1 },
        },
      )
      .exec();
    this.forget();
    await this.audit.record({ action: 'platform.sms.disconnected' });
    return this.get();
  }

  async update(patch: SmsPlatformPatch): Promise<SmsPlatform> {
    const before = await this.get();
    if (patch.enabled && !(before.provider && before.credentialsEnc))
      throw AppError.unprocessable(
        'sms_provider_missing',
        'Connect an SMS provider before switching Sellora SMS on.',
      );
    const $set: Record<string, unknown> = {};
    if (patch.enabled !== undefined) $set.enabled = patch.enabled;
    if (patch.senderId !== undefined) {
      if (!before.provider)
        throw AppError.unprocessable('sms_provider_missing', 'Connect an SMS provider first.');
      $set.senderId = checkSenderId(this.providers.get(before.provider), patch.senderId);
    }
    for (const key of ['prices', 'costs'] as const) {
      const list = patch[key];
      if (!list) continue;
      const currencies = list.map((p) => p.currency);
      if (new Set(currencies).size !== currencies.length)
        throw AppError.validation([{ path: key, message: 'One row per currency' }]);
      $set[key] = list;
    }
    await this.model.updateOne({ _id: ID }, { $set }, { upsert: true, runValidators: true }).exec();
    this.forget();
    const after = await this.get();
    await this.audit.record({
      action: 'platform.sms.updated',
      metadata: {
        before: {
          enabled: before.enabled,
          senderId: before.senderId,
          prices: before.prices,
          costs: before.costs,
        },
        after: {
          enabled: after.enabled,
          senderId: after.senderId,
          prices: after.prices,
          costs: after.costs,
        },
      },
    });
    return after;
  }
}
