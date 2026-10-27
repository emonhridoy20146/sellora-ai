import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { EncryptionService } from '../../../common/crypto/encryption.service.js';
import { AppConfig } from '../../../config/app-config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { zodIssuesToFieldErrors } from '../../../common/filters/problem-details.filter.js';
import { AuditService } from '../../audit/audit.service.js';
import { GATEWAYS, type GatewayConfig, type GatewayKey } from '../payment-schemas.js';
import {
  GATEWAY_CREDENTIAL_SCHEMAS,
  GATEWAY_CURRENCIES,
  type GatewayCredentials,
} from './gateway.types.js';

export interface ResolvedGateway<K extends GatewayKey> {
  key: K;
  enabled: boolean;
  sandbox: boolean;
  credentials: GatewayCredentials[K];
}

/**
 * Payment gateway credentials, set by the super-admin and stored encrypted (AES-256-GCM,
 * bound to the gateway name). They are never returned by the API; only whether they are
 * configured. The manual gateway's "credentials" are the public payment instructions.
 */
@Injectable()
export class GatewayConfigService {
  constructor(
    @InjectModel('GatewayConfig') private readonly configs: Model<GatewayConfig>,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private aad(key: GatewayKey) {
    return `gateway:${key}`;
  }

  /**
   * The address the admin must paste into the gateway's dashboard for server-to-server
   * notifications. bKash gets its callback per payment, so it has none.
   */
  private webhookUrl(key: GatewayKey): string | null {
    const api = this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
    if (key === 'sslcommerz') return `${api}/v1/payments/sslcommerz/ipn`;
    if (key === 'stripe') return `${api}/v1/payments/stripe/webhook`;
    return null;
  }

  async list() {
    const docs = await this.configs.find({}).lean().exec();
    return GATEWAYS.map((key) => {
      const doc = docs.find((d) => d._id === key);
      return {
        key,
        enabled: doc?.enabled ?? false,
        sandbox: doc?.sandbox ?? true,
        configured: Boolean(doc?.credentialsEnc),
        currencies: GATEWAY_CURRENCIES[key],
        updatedAt: (doc as { updatedAt?: Date } | undefined)?.updatedAt?.toISOString() ?? null,
        webhookUrl: this.webhookUrl(key),
        // Manual transfer instructions are public (shown to merchants), so the admin panel
        // can show and edit them. Real gateway secrets are never returned.
        publicConfig:
          key === 'manual' && doc?.credentialsEnc
            ? (JSON.parse(this.encryption.decrypt(doc.credentialsEnc, this.aad(key))) as unknown)
            : null,
      };
    });
  }

  async get<K extends GatewayKey>(key: K): Promise<ResolvedGateway<K> | null> {
    const doc = await this.configs.findById(key).lean().exec();
    if (!doc) return null;
    const json = JSON.parse(this.encryption.decrypt(doc.credentialsEnc, this.aad(key))) as unknown;
    return {
      key,
      enabled: doc.enabled,
      sandbox: doc.sandbox,
      credentials: GATEWAY_CREDENTIAL_SCHEMAS[key].parse(json) as GatewayCredentials[K],
    };
  }

  /** An enabled gateway that can take `currency`, or 422. */
  async require<K extends GatewayKey>(key: K, currency: string): Promise<ResolvedGateway<K>> {
    const gw = await this.get(key);
    if (!gw?.enabled)
      throw AppError.unprocessable(
        'gateway_unavailable',
        'This payment method is not available right now.',
      );
    const currencies = GATEWAY_CURRENCIES[key];
    if (currencies !== 'any' && !currencies.includes(currency)) {
      throw AppError.unprocessable(
        'gateway_currency_unsupported',
        `This payment method does not accept ${currency}.`,
      );
    }
    return gw;
  }

  async set(
    key: GatewayKey,
    input: { enabled?: boolean; sandbox?: boolean; credentials?: unknown },
    actorId: string,
  ) {
    const existing = await this.configs.findById(key).lean().exec();
    const update: Record<string, unknown> = { updatedBy: actorId };
    if (input.enabled !== undefined) update.enabled = input.enabled;
    if (input.sandbox !== undefined) update.sandbox = input.sandbox;
    if (input.credentials !== undefined) {
      const parsed = GATEWAY_CREDENTIAL_SCHEMAS[key].safeParse(input.credentials);
      if (!parsed.success)
        throw AppError.validation(
          zodIssuesToFieldErrors(parsed.error).map((e) => ({
            ...e,
            path: `credentials.${e.path}`,
          })),
        );
      update.credentialsEnc = this.encryption.encrypt(JSON.stringify(parsed.data), this.aad(key));
    }
    if (!existing && !update.credentialsEnc)
      throw AppError.validation([
        { path: 'credentials', message: 'Credentials are required the first time' },
      ]);
    await this.configs
      .updateOne({ _id: key }, { $set: update }, { upsert: true, runValidators: true })
      .exec();
    await this.audit.record({
      action: 'platform.gateway.updated',
      target: { type: 'payment_gateway', id: key, label: key },
      metadata: {
        enabled: input.enabled ?? null,
        sandbox: input.sandbox ?? null,
        credentialsChanged: input.credentials !== undefined,
      },
    });
    return (await this.list()).find((g) => g.key === key)!;
  }

  /** Public payment instructions for manual transfers (account numbers, steps). */
  async manualInstructions() {
    const gw = await this.get('manual').catch(() => null);
    if (!gw?.enabled) return null;
    return gw.credentials;
  }
}
