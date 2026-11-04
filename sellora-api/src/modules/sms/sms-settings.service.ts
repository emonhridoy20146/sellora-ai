import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/validation/schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { WalletService } from '../billing/wallet.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import {
  checkSenderId,
  checkWithProvider,
  ownCredentialsAad,
  parseCredentials,
} from './gateways.js';
import { SmsProviders } from './providers/sms-providers.js';
import { SmsSettingsRepository, type SmsSettingsDoc } from './repositories.js';
import type { SmsMode } from './schemas.js';
import { MAX_SMS_PARTS, smsLength } from './segments.js';
import { SmsPlatformService } from './sms-platform.service.js';
import { SmsService } from './sms.service.js';
import type { SmsProviderKey } from './sms.types.js';
import {
  ORDER_SMS_EVENTS,
  SHIPPING_PLACEHOLDERS,
  defaultOrderTemplates,
  placeholdersFor,
  renderSms,
  smsMoney,
  unknownPlaceholders,
  type OrderSmsEvent,
  type SmsLanguage,
} from './templates.js';

/** The longest order message template, before placeholders are filled. */
export const MAX_TEMPLATE_CHARS = 480;

/** A sender name: 3–11 letters and digits with at least one letter (operator masking rules). */
export const SENDER_NAME_RE = /^(?=.*[A-Za-z])[A-Za-z0-9]{3,11}$/;

export interface SmsSettingsPatch {
  mode?: SmsMode;
  language?: SmsLanguage;
  shopName?: string;
  contactPhone?: string;
  useSenderName?: boolean;
  orderTemplates?: Partial<Record<OrderSmsEvent, { enabled?: boolean; text?: string }>>;
}

const TEST_TEXT: Record<SmsLanguage, string> = {
  en: 'Test message from {shop} via Sellora. SMS is working.',
  bn: '{shop} থেকে পরীক্ষামূলক SMS। Sellora দিয়ে SMS কাজ করছে।',
};

/**
 * Settings › SMS for one business: how it sends (off, Sellora SMS or its own provider), the
 * order message texts, a sender name request and test messages. Runs inside a tenant scope.
 */
@Injectable()
export class SmsSettingsService {
  constructor(
    private readonly sms: SmsService,
    private readonly repo: SmsSettingsRepository,
    private readonly platform: SmsPlatformService,
    private readonly providers: SmsProviders,
    private readonly encryption: EncryptionService,
    private readonly orgs: OrgsService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  descriptors() {
    return this.providers.all().map((p) => p.descriptor);
  }

  /** What the order messages look like with made-up values, for the editor's preview. */
  async samples(s: SmsSettingsDoc): Promise<Record<string, string>> {
    const shop = await this.sms.shopValues(s);
    return {
      name: s.language === 'bn' ? 'রহিম' : 'Rahim',
      order: 'SL-1024',
      total: smsMoney(125_000, (await this.orgs.get(this.orgId())).currency, s.language),
      shop: shop.shop,
      phone: shop.phone,
      courier: 'Steadfast',
      tracking: 'https://steadfast.com.bd/t/SF12AB34',
    };
  }

  async get() {
    return this.toDto(await this.sms.settings());
  }

  async toDto(s: SmsSettingsDoc) {
    const [org, platform, route, samples, wallet] = await Promise.all([
      this.orgs.get(this.orgId()),
      this.platform.get(),
      this.sms.resolveRoute(s),
      this.samples(s),
      this.wallet.get(),
    ]);
    const own = s.own;
    const ownDescriptor = own ? this.providers.get(own.provider).descriptor : null;
    const price = platform.prices.find((p) => p.currency === wallet.currency) ?? null;
    return {
      mode: s.mode,
      language: s.language,
      shopName: s.shopName,
      contactPhone: s.contactPhone,
      defaults: { shopName: org.name, contactPhone: org.contact?.phone ?? '' },
      own:
        own && ownDescriptor
          ? {
              provider: own.provider,
              providerName: ownDescriptor.name,
              credentialsHint: own.hint,
              senderId: own.senderId,
              reach: ownDescriptor.reach,
              deliveryReports: ownDescriptor.deliveryReports,
              lastCheck: own.checkedAt
                ? { at: own.checkedAt.toISOString(), summary: own.checkSummary ?? '' }
                : null,
              lastError: own.lastErrorAt
                ? { at: own.lastErrorAt.toISOString(), message: own.lastError ?? '' }
                : null,
            }
          : null,
      sellora: {
        available: this.platform.ready(platform),
        sharedSender: platform.senderId,
        reach: platform.provider ? this.providers.get(platform.provider).descriptor.reach : null,
        price: price
          ? {
              currency: price.currency,
              perPartMinor: price.perPartMinor,
              senderNamePerPartMinor: price.senderNamePerPartMinor,
            }
          : null,
      },
      senderName: s.senderName
        ? {
            name: s.senderName.name,
            status: s.senderName.status,
            reason: s.senderName.reason ?? null,
            requestedAt: s.senderName.requestedAt.toISOString(),
            decidedAt: s.senderName.decidedAt?.toISOString() ?? null,
          }
        : null,
      useSenderName: s.useSenderName,
      route:
        'failure' in route
          ? {
              ready: false as const,
              route: route.route,
              failure: route.failure,
              message: route.message,
            }
          : {
              ready: true as const,
              route: route.route,
              providerName: route.provider.descriptor.name,
              senderId: route.senderId,
              senderName: route.senderName,
              pricePerPartMinor: route.pricePerPart,
              currency: route.currency,
            },
      orderTemplates: ORDER_SMS_EVENTS.map((event) => ({
        event,
        enabled: s.orderTemplates[event]?.enabled ?? false,
        text: s.orderTemplates[event]?.text ?? '',
        placeholders: placeholdersFor(event).map((key) => ({
          key,
          label: SHIPPING_PLACEHOLDERS[key as keyof typeof SHIPPING_PLACEHOLDERS],
        })),
      })),
      samples,
      maxParts: MAX_SMS_PARTS,
      maxTemplateChars: MAX_TEMPLATE_CHARS,
      dailyLimit: this.sms.dailyLimit(s),
      providers: this.descriptors(),
    };
  }

  /** Problems with the order texts, at `orderTemplates.<event>.text`. */
  private templateProblems(
    templates: SmsSettingsDoc['orderTemplates'],
    samples: Record<string, string>,
  ): FieldError[] {
    const errors: FieldError[] = [];
    for (const event of ORDER_SMS_EVENTS) {
      const t = templates[event];
      const path = `orderTemplates.${event}.text`;
      const text = (t?.text ?? '').trim();
      if (t?.enabled && !text) {
        errors.push({ path, message: 'Write the message or turn it off' });
        continue;
      }
      if (text.length > MAX_TEMPLATE_CHARS) {
        errors.push({ path, message: `At most ${MAX_TEMPLATE_CHARS} characters` });
        continue;
      }
      const unknown = unknownPlaceholders(text, placeholdersFor(event));
      if (unknown.length) {
        errors.push({
          path,
          message: `This message cannot use ${unknown.map((u) => `{${u}}`).join(', ')}`,
        });
        continue;
      }
      const parts = smsLength(renderSms(text, samples)).parts;
      if (parts > MAX_SMS_PARTS)
        errors.push({
          path,
          message: `With real values this needs about ${parts} SMS parts; the most is ${MAX_SMS_PARTS}. Make it shorter.`,
        });
    }
    return errors;
  }

  async update(patch: SmsSettingsPatch) {
    const s = await this.sms.settings();
    const $set: Record<string, unknown> = {};
    if (patch.mode !== undefined && patch.mode !== s.mode) {
      if (patch.mode === 'own' && !s.own)
        throw AppError.unprocessable(
          'sms_provider_missing',
          'Connect your SMS provider before choosing it.',
        );
      if (patch.mode === 'sellora' && !this.platform.ready(await this.platform.get()))
        throw AppError.unprocessable(
          'sms_unavailable',
          'Sellora SMS is not available right now. Connect your own SMS provider instead.',
        );
      $set.mode = patch.mode;
    }
    if (patch.language !== undefined) $set.language = patch.language;
    if (patch.shopName !== undefined) $set.shopName = patch.shopName.trim();
    if (patch.contactPhone !== undefined) $set.contactPhone = patch.contactPhone.trim();
    if (patch.useSenderName !== undefined) {
      if (patch.useSenderName && s.senderName?.status !== 'approved')
        throw AppError.unprocessable(
          'sender_name_not_approved',
          'Your sender name has to be approved before messages can go out from it.',
        );
      $set.useSenderName = patch.useSenderName;
    }
    if (patch.orderTemplates) {
      const next = structuredClone(s.orderTemplates);
      for (const [event, t] of Object.entries(patch.orderTemplates) as [
        OrderSmsEvent,
        { enabled?: boolean; text?: string },
      ][]) {
        next[event] = {
          enabled: t.enabled ?? next[event]?.enabled ?? false,
          text: t.text !== undefined ? t.text.trim() : (next[event]?.text ?? ''),
        };
      }
      const samples = await this.samples({ ...s, ...($set as Partial<SmsSettingsDoc>) });
      const errors = this.templateProblems(next, samples);
      if (errors.length) throw AppError.validation(errors);
      $set.orderTemplates = next;
    }
    if (!Object.keys($set).length) return this.toDto(s);
    const after = (await this.repo.findOneAndUpdate({ _id: s._id }, { $set }))!;
    await this.audit.record({
      action: 'sms.settings.updated',
      orgId: this.orgId(),
      metadata: {
        changed: Object.keys($set),
        ...($set.mode ? { mode: { from: s.mode, to: $set.mode } } : {}),
        ...(patch.orderTemplates
          ? {
              enabled: ORDER_SMS_EVENTS.filter((e) => after.orderTemplates[e]?.enabled),
            }
          : {}),
      },
    });
    return this.toDto(after);
  }

  /** Puts the default texts back in a language; whether each message is on stays as it was. */
  async resetTemplates(language?: SmsLanguage) {
    const s = await this.sms.settings();
    const lang = language ?? s.language;
    const defaults = defaultOrderTemplates(lang);
    for (const e of ORDER_SMS_EVENTS) defaults[e].enabled = s.orderTemplates[e]?.enabled ?? false;
    const after = (await this.repo.findOneAndUpdate(
      { _id: s._id },
      { $set: { orderTemplates: defaults, language: lang } },
    ))!;
    await this.audit.record({
      action: 'sms.settings.updated',
      orgId: this.orgId(),
      metadata: { changed: ['orderTemplates'], reset: lang },
    });
    return this.toDto(after);
  }

  // ---------------------------------------------------------------- own provider

  async connectOwn(input: {
    provider: SmsProviderKey;
    credentials: Record<string, unknown>;
    senderId?: string;
  }) {
    const provider = this.providers.get(input.provider);
    const credentials = parseCredentials(provider, input.credentials);
    const senderId = checkSenderId(provider, input.senderId);
    const check = await checkWithProvider(provider, { credentials, senderId });
    const s = await this.sms.settings();
    const after = (await this.repo.findOneAndUpdate(
      { _id: s._id },
      {
        $set: {
          own: {
            provider: input.provider,
            credentialsEnc: this.encryption.encrypt(
              JSON.stringify(credentials),
              ownCredentialsAad(this.orgId()),
            ),
            hint: provider.hint(credentials),
            senderId,
            checkedAt: new Date(),
            checkSummary: check.summary,
          },
        },
      },
    ))!;
    await this.audit.record({
      action: 'sms.gateway.connected',
      orgId: this.orgId(),
      metadata: { provider: input.provider, senderId, replaced: s.own?.provider ?? null },
    });
    return { settings: await this.toDto(after), check };
  }

  /** New credentials are checked with the provider; a new sender id alone is saved as it is. */
  async updateOwn(input: { credentials?: Record<string, unknown>; senderId?: string }) {
    const s = await this.sms.settings();
    if (!s.own) throw AppError.notFound('sms_provider_missing', 'No SMS provider is connected.');
    const provider = this.providers.get(s.own.provider);
    const senderId =
      input.senderId !== undefined ? checkSenderId(provider, input.senderId) : s.own.senderId;
    const $set: Record<string, unknown> = { 'own.senderId': senderId };
    let check: { summary: string; checked: boolean } | null = null;
    if (input.credentials) {
      const credentials = parseCredentials(provider, input.credentials);
      check = await checkWithProvider(provider, { credentials, senderId });
      Object.assign($set, {
        'own.credentialsEnc': this.encryption.encrypt(
          JSON.stringify(credentials),
          ownCredentialsAad(this.orgId()),
        ),
        'own.hint': provider.hint(credentials),
        'own.checkedAt': new Date(),
        'own.checkSummary': check.summary,
      });
    }
    const after = (await this.repo.findOneAndUpdate(
      { _id: s._id },
      {
        $set,
        ...(input.credentials ? { $unset: { 'own.lastError': 1, 'own.lastErrorAt': 1 } } : {}),
      },
    ))!;
    await this.audit.record({
      action: 'sms.gateway.updated',
      orgId: this.orgId(),
      metadata: { provider: s.own.provider, senderId, credentials: Boolean(input.credentials) },
    });
    return { settings: await this.toDto(after), check };
  }

  /** Checks the saved credentials with the provider again. */
  async checkOwn() {
    const s = await this.sms.settings();
    if (!s.own) throw AppError.notFound('sms_provider_missing', 'No SMS provider is connected.');
    const provider = this.providers.get(s.own.provider);
    const check = await checkWithProvider(provider, this.sms.ownContext(s));
    const after = (await this.repo.findOneAndUpdate(
      { _id: s._id },
      {
        $set: { 'own.checkedAt': new Date(), 'own.checkSummary': check.summary },
        ...(check.checked ? { $unset: { 'own.lastError': 1, 'own.lastErrorAt': 1 } } : {}),
      },
    ))!;
    return { settings: await this.toDto(after), check };
  }

  /** Forgets the business's provider; SMS turns off if it was sending through it. */
  async removeOwn() {
    const s = await this.sms.settings();
    if (!s.own) return this.toDto(s);
    const after = (await this.repo.findOneAndUpdate(
      { _id: s._id },
      { $unset: { own: 1 }, ...(s.mode === 'own' ? { $set: { mode: 'off' } } : {}) },
    ))!;
    await this.audit.record({
      action: 'sms.gateway.removed',
      orgId: this.orgId(),
      metadata: { provider: s.own.provider, turnedOff: s.mode === 'own' },
    });
    return this.toDto(after);
  }

  // ---------------------------------------------------------------- sender name

  async requestSenderName(raw: string) {
    const name = raw.trim();
    if (!SENDER_NAME_RE.test(name))
      throw AppError.validation([
        {
          path: 'name',
          message: '3 to 11 English letters and digits, with at least one letter and no spaces',
        },
      ]);
    const s = await this.sms.settings();
    if (s.senderName && s.senderName.name === name && s.senderName.status !== 'rejected')
      return this.toDto(s);
    const after = (await this.repo.findOneAndUpdate(
      { _id: s._id },
      {
        $set: {
          senderName: {
            name,
            status: 'pending',
            requestedAt: new Date(),
            requestedBy: RequestContext.actor().id,
          },
          useSenderName: false,
        },
      },
    ))!;
    await this.audit.record({
      action: 'sms.sender_name.requested',
      orgId: this.orgId(),
      metadata: { name, previous: s.senderName?.name ?? null },
    });
    return this.toDto(after);
  }

  async cancelSenderName() {
    const s = await this.sms.settings();
    if (!s.senderName) return this.toDto(s);
    const after = (await this.repo.findOneAndUpdate(
      { _id: s._id },
      { $unset: { senderName: 1 }, $set: { useSenderName: false } },
    ))!;
    await this.audit.record({
      action: 'sms.sender_name.removed',
      orgId: this.orgId(),
      metadata: { name: s.senderName.name, status: s.senderName.status },
    });
    return this.toDto(after);
  }

  // ---------------------------------------------------------------- test message

  /** Sends one message now, the way order messages go, and says what happened. */
  async sendTest(input: { to: string; text?: string }) {
    await this.rateLimit.consume('sms-test:org', this.orgId());
    const s = await this.sms.settings();
    if (s.mode === 'off')
      throw AppError.unprocessable('sms_off', 'Choose how to send SMS before sending a test.');
    const org = await this.orgs.get(this.orgId());
    const to = normalizePhone(input.to, org.country);
    if (!to) throw AppError.validation([{ path: 'to', message: 'Invalid phone number' }]);
    const shop = await this.sms.shopValues(s);
    const text = renderSms(input.text?.trim() || TEST_TEXT[s.language], shop);
    const result = await this.sms.enqueue(
      { to, text, purpose: 'test', key: `test:${randomUUID()}` },
      { now: true },
    );
    return this.sms.toDto(result.message!);
  }
}
