import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type QueryFilter } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { Page } from '../../common/pagination/cursor.js';
import { nationalDigits, normalizePhone } from '../../common/validation/schemas.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import type { OrderDoc } from '../commerce/orders.service.js';
import { OrderRepository } from '../commerce/repositories.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { MAX_SMS_PARTS, smsLength } from '../sms/segments.js';
import { SmsService, type SmsEnqueueResult } from '../sms/sms.service.js';
import type { SmsSettingsDoc } from '../sms/repositories.js';
import type { SmsMessage } from '../sms/schemas.js';
import { renderSms, smsMoney, unknownPlaceholders, type SmsLanguage } from '../sms/templates.js';
import { storeUrl } from '../stores/store-hosts.js';
import {
  ABANDONED_AFTER_MS,
  CART_DELAYS,
  CART_PLACEHOLDER_KEYS,
  CART_PLACEHOLDERS,
  CART_STEPS,
  CART_TTL_MS,
  DEFAULT_CART_TEXTS,
  MAX_CART_TEXT_CHARS,
  MAX_MANUAL_REMINDERS,
  RECOVERY_WINDOW_MS,
  SAME_PHONE_GAP_MS,
  SMS_OFF_RETRY_MS,
  STEP_GRACE_MS,
  defaultCartSteps,
  enabledSteps,
  inQuietHours,
  itemsSummary,
  nextDue,
  optOutSuffix,
  quietHoursEnd,
  type CartStep,
  type QuietHours,
} from './cart-templates.js';
import {
  CartRepository,
  CartSettingsRepository,
  type CartDoc,
  type CartSettingsDoc,
} from './repositories.js';
import type {
  Cart,
  CartLine,
  CartSkip,
  CartSource,
  CartStatus,
  LandingSelection,
} from './schemas.js';

/** What the storefront hands over when a shopper with a number has something in the cart. */
export interface CartCapture {
  source: CartSource;
  store: { id: Types.ObjectId; name: string; url: string };
  landingPage?: { id: string; name: string; slug: string };
  token: string;
  /** As typed; normalised with the business's country. */
  phone: string;
  name: string;
  items: CartLine[];
  selection?: LandingSelection;
  totalMinor: number;
  currency: string;
}

export const CART_VIEWS = ['abandoned', 'recovered', 'ordered', 'dismissed', 'all'] as const;
export type CartView = (typeof CART_VIEWS)[number];

export interface CartSettingsPatch {
  enabled?: boolean;
  language?: SmsLanguage;
  steps?: CartStep[];
  minTotalMinor?: number;
  quietHours?: QuietHours;
}

/** What one sweep look at a cart did (for tests and logs). */
export type CartOutcome =
  'gone' | 'raced' | 'waiting' | 'no_step' | 'ordered' | 'sent' | `skipped:${CartSkip}`;

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const CODE_RE = /^[A-Za-z0-9]{10}$/;
function cartCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Carts older than this cannot have a reminder due under any settings. */
const PLANNABLE_MS = Math.max(...CART_DELAYS) * 60_000 + STEP_GRACE_MS;
/** Orders placed this long before a cart was saved still close it (the save came late). */
const ORDER_LOOKBACK_MS = ABANDONED_AFTER_MS;
/** Carts the sweep looks at in one run. */
const SWEEP_BATCH = 500;

/** A reminder whose message was not refused counts towards "recovered". */
const COUNTED_STATUSES: ReadonlySet<SmsMessage['status']> = new Set([
  'queued',
  'sending',
  'sent',
  'delivered',
  'unknown',
]);

/**
 * Abandoned carts (ADR 0018): saves carts shoppers left with a phone number, sends the
 * timed reminders through SmsService, closes carts when an order comes, and reports what
 * came back. Must run inside a tenant scope, except where a method says it crosses tenants.
 */
@Injectable()
export class CartsService {
  private readonly logger = new Logger(CartsService.name);

  constructor(
    private readonly carts: CartRepository,
    private readonly settingsRepo: CartSettingsRepository,
    @InjectModel('Cart') private readonly cartModel: Model<Cart>,
    private readonly sms: SmsService,
    private readonly orgs: OrgsService,
    private readonly entitlements: EntitlementsService,
    private readonly orders: OrderRepository,
    private readonly limits: RateLimitService,
    private readonly config: AppConfig,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  // ---------------------------------------------------------------- settings

  /** The business's cart settings, made with defaults on first use (reminders off). */
  async settings(): Promise<CartSettingsDoc> {
    const found = await this.settingsRepo.findOne({});
    if (found) return found;
    const org = await this.orgs.get(this.orgId());
    try {
      return await this.settingsRepo.create({
        enabled: false,
        language: org.locale,
        steps: defaultCartSteps(org.locale),
        minTotalMinor: 0,
        quietHours: { enabled: true, startHour: 22, endHour: 9 },
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return (await this.settingsRepo.findOne({}))!;
    }
  }

  /** Whether the storefront should save carts (and show the notice under the phone field). */
  async capturing(): Promise<boolean> {
    const s = await this.settingsRepo.findOne({}, { enabled: 1 });
    if (!s?.enabled) return false;
    return this.entitlements.hasModule(this.orgId(), 'marketing');
  }

  private sampleLink(): string {
    return `${storeUrl('your-shop', this.config.get('STOREFRONT_BASE_DOMAIN'), this.config.get('STOREFRONT_URL_SCHEME'))}/r/Ab12Cd34Ef`;
  }

  private sampleOptOut(): string {
    return `${this.config.get('WEB_APP_URL').replace(/\/$/, '')}/u/Ab12Cd34`;
  }

  /** {name} … {link} with made-up values, for the preview and the length check. */
  private async samples(language: SmsLanguage, smsSettings: SmsSettingsDoc) {
    const org = await this.orgs.get(this.orgId());
    return {
      name: language === 'bn' ? 'রহিম' : 'Rahim',
      shop: (await this.sms.shopValues(smsSettings)).shop,
      items: itemsSummary(
        [
          { name: language === 'bn' ? 'লাল শাড়ি' : 'Red saree', quantity: 1 },
          { name: 'x', quantity: 1 },
        ],
        language,
      ),
      total: smsMoney(250_000, org.currency, language),
      link: this.sampleLink(),
    };
  }

  /** The reminder text with values filled in and the opt-out link added. */
  private compose(
    text: string,
    values: Record<string, string>,
    language: SmsLanguage,
    optOutUrl: string,
  ): string {
    let body = renderSms(text, values).replace(/^[\s,،।.:;-]+/, '');
    if (language === 'en' && body) body = body[0]!.toUpperCase() + body.slice(1);
    return `${body}${optOutSuffix(language, optOutUrl)}`;
  }

  async getSettings() {
    return this.settingsDto(await this.settings());
  }

  async settingsDto(s: CartSettingsDoc) {
    const smsSettings = await this.sms.settings();
    const [route, samplesEn, samplesBn, org, included] = await Promise.all([
      this.sms.resolveRoute(smsSettings),
      this.samples('en', smsSettings),
      this.samples('bn', smsSettings),
      this.orgs.get(this.orgId()),
      this.entitlements.hasModule(this.orgId(), 'marketing'),
    ]);
    const samples = s.language === 'bn' ? samplesBn : samplesEn;
    const price = 'failure' in route ? null : route.pricePerPart;
    return {
      enabled: s.enabled,
      language: s.language,
      steps: s.steps.map((step, i) => {
        const text = this.compose(step.text, samples, s.language, this.sampleOptOut());
        const length = smsLength(text);
        return {
          step: i + 1,
          enabled: step.enabled,
          delayMinutes: step.delayMinutes,
          text: step.text,
          preview: {
            text,
            parts: length.parts,
            encoding: length.encoding,
            priceMinor: price === null ? null : price * length.parts,
          },
        };
      }),
      minTotalMinor: s.minTotalMinor,
      quietHours: s.quietHours,
      timezone: org.timezone,
      currency: org.currency,
      delays: CART_DELAYS,
      placeholders: CART_PLACEHOLDER_KEYS.map((key) => ({
        key,
        label: CART_PLACEHOLDERS[key as keyof typeof CART_PLACEHOLDERS],
      })),
      defaults: DEFAULT_CART_TEXTS,
      // Made-up values and the stop text, so the editor can preview what it has not saved.
      samples: { en: samplesEn, bn: samplesBn },
      stopSuffix: {
        en: optOutSuffix('en', this.sampleOptOut()),
        bn: optOutSuffix('bn', this.sampleOptOut()),
      },
      maxChars: MAX_CART_TEXT_CHARS,
      maxParts: MAX_SMS_PARTS,
      included,
      sms:
        'failure' in route
          ? { mode: smsSettings.mode, ready: false as const, message: route.message }
          : {
              mode: smsSettings.mode,
              ready: true as const,
              providerName: route.provider.descriptor.name,
              pricePerPartMinor: route.pricePerPart,
              currency: route.currency,
            },
    };
  }

  private async stepProblems(
    steps: CartStep[],
    language: SmsLanguage,
    enabling: boolean,
  ): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    const samples = await this.samples(language, await this.sms.settings());
    steps.forEach((step, i) => {
      const path = `steps.${i}`;
      if (!(CART_DELAYS as readonly number[]).includes(step.delayMinutes))
        errors.push({ path: `${path}.delayMinutes`, message: 'Choose one of the delays' });
      const text = step.text.trim();
      if (!step.enabled && !text) return;
      if (!text) {
        errors.push({ path: `${path}.text`, message: 'Write the message or turn it off' });
        return;
      }
      if (text.length > MAX_CART_TEXT_CHARS) {
        errors.push({ path: `${path}.text`, message: `At most ${MAX_CART_TEXT_CHARS} characters` });
        return;
      }
      const unknown = unknownPlaceholders(text, CART_PLACEHOLDER_KEYS);
      if (unknown.length) {
        errors.push({
          path: `${path}.text`,
          message: `This message cannot use ${unknown.map((u) => `{${u}}`).join(', ')}`,
        });
        return;
      }
      if (step.enabled && !text.includes('{link}')) {
        errors.push({
          path: `${path}.text`,
          message: 'Put {link} in the message, so the shopper can go back to the cart',
        });
        return;
      }
      const parts = smsLength(this.compose(text, samples, language, this.sampleOptOut())).parts;
      if (parts > MAX_SMS_PARTS)
        errors.push({
          path: `${path}.text`,
          message: `With real values and the stop link this needs about ${parts} SMS parts; the most is ${MAX_SMS_PARTS}. Make it shorter.`,
        });
    });
    const [first, second] = steps;
    if (first?.enabled && second?.enabled && second.delayMinutes <= first.delayMinutes)
      errors.push({
        path: 'steps.1.delayMinutes',
        message: 'The second reminder must come after the first',
      });
    if (enabling && !steps.some((s) => s.enabled))
      errors.push({ path: 'steps', message: 'Turn on at least one reminder' });
    return errors;
  }

  async updateSettings(patch: CartSettingsPatch, now = new Date()) {
    const s = await this.settings();
    const next = {
      enabled: patch.enabled ?? s.enabled,
      language: patch.language ?? s.language,
      steps: (patch.steps ?? s.steps).map((x) => ({
        enabled: x.enabled,
        delayMinutes: x.delayMinutes,
        text: x.text.trim(),
      })),
      minTotalMinor: patch.minTotalMinor ?? s.minTotalMinor,
      quietHours: patch.quietHours ?? s.quietHours,
    };
    if (next.steps.length !== CART_STEPS)
      throw AppError.validation([{ path: 'steps', message: `Send ${CART_STEPS} steps` }]);
    const errors = await this.stepProblems(next.steps, next.language, next.enabled);
    if (next.quietHours.enabled && next.quietHours.startHour === next.quietHours.endHour)
      errors.push({ path: 'quietHours.endHour', message: 'Quiet hours must end at another hour' });
    if (errors.length) throw AppError.validation(errors);
    if (
      next.enabled &&
      !s.enabled &&
      !(await this.entitlements.hasModule(this.orgId(), 'marketing'))
    )
      throw AppError.paymentRequired(
        'module_not_in_plan',
        'Abandoned cart reminders are not in your plan. Upgrade to turn them on.',
      );

    const updated = (await this.settingsRepo.findOneAndUpdate({ _id: s._id }, { $set: next }))!;
    // Waiting carts follow the new settings: looked at again on the next sweep, or not at all.
    if (!next.enabled)
      await this.carts.updateMany({ status: 'open' }, { $set: { nextReminderAt: null } });
    else
      await this.carts.updateMany(
        { status: 'open', lastActivityAt: { $gte: new Date(now.getTime() - PLANNABLE_MS) } },
        { $set: { nextReminderAt: now } },
      );
    return this.settingsDto(updated);
  }

  // ---------------------------------------------------------------- saving carts (storefront)

  /**
   * Saves (or updates) the shopper's cart. Nothing is stored while reminders are off, the
   * plan lacks the module, the number is not valid yet, or the cart is empty; the storefront
   * gets `{ saved: false }` and carries on. Runs as the shopper, inside the store's business.
   */
  async capture(input: CartCapture, now = new Date()): Promise<{ saved: boolean }> {
    const ip = RequestContext.current()?.ip;
    if (ip) await this.limits.consume('cart-capture:ip', ip);
    if (!(await this.capturing())) return { saved: false };
    return this.save(input, now);
  }

  private async save(input: CartCapture, now: Date): Promise<{ saved: boolean }> {
    const org = await this.orgs.get(this.orgId());
    const phone = normalizePhone(input.phone, org.country);
    if (!phone || !input.items.length) return { saved: false };

    const settings = await this.settings();
    const existing = await this.carts.findOne({ token: input.token });
    if (existing && existing.status !== 'open') return { saved: false };
    const fields = {
      source: input.source,
      storeId: input.store.id,
      storeName: input.store.name,
      baseUrl: input.store.url.replace(/\/$/, ''),
      ...(input.landingPage ? { landingPage: input.landingPage } : {}),
      phone,
      name: input.name.trim(),
      items: input.items,
      ...(input.selection ? { selection: input.selection } : {}),
      totalMinor: input.totalMinor,
      currency: input.currency,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + CART_TTL_MS),
    };
    const steps = enabledSteps(settings.steps);
    if (existing) {
      const due = nextDue(now, steps, existing.nextStep, now);
      await this.carts.updateOne(
        { _id: existing._id, status: 'open' },
        { $set: { ...fields, nextReminderAt: due?.at ?? null } },
      );
      return { saved: true };
    }
    // An order from this number a moment ago: the save arrived after the checkout.
    if (
      await this.orders.exists({
        'customer.phone': phone,
        placedAt: { $gte: new Date(now.getTime() - 10 * 60_000) },
      })
    )
      return { saved: false };
    const due = nextDue(now, steps, 0, now);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.carts.create({
          ...fields,
          token: input.token,
          code: cartCode(),
          status: 'open',
          nextStep: 0,
          nextReminderAt: due?.at ?? null,
          reminders: [],
          manualReminders: 0,
          clicks: 0,
          recovered: false,
        });
        return { saved: true };
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        // The same token saved twice at once: update the one that won.
        if (await this.carts.exists({ token: input.token })) return this.save(input, now);
      }
    }
    throw new Error('Could not make a cart code');
  }

  /** The cart behind a reminder link, on this store; counts the click. */
  async restore(storeId: Types.ObjectId, code: string, now = new Date()) {
    const ip = RequestContext.current()?.ip;
    if (ip) await this.limits.consume('cart-restore:ip', ip);
    if (!CODE_RE.test(code)) return null;
    const cart = await this.carts.findOne({ code, storeId });
    if (!cart) return null;
    if (cart.status === 'open')
      await this.carts.updateOne(
        { _id: cart._id },
        { $inc: { clicks: 1 }, $set: { lastClickAt: now } },
      );
    return {
      kind: cart.source,
      status: cart.status,
      // Later saves from the restored browser keep updating this cart.
      token: cart.status === 'open' ? cart.token : null,
      items: cart.items.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        quantity: l.quantity,
      })),
      landingPage: cart.landingPage ? { slug: cart.landingPage.slug } : null,
      selection: cart.selection ?? null,
      customer: { name: cart.name, phone: nationalDigits(cart.phone) ?? cart.phone },
    };
  }

  // ---------------------------------------------------------------- orders close carts

  /** The order came from the cart with this token (the storefront knows which). */
  async checkedOut(token: string | undefined, order: OrderDoc): Promise<void> {
    if (!token) return;
    await this.markOrdered({ token }, order);
  }

  /** Any new order closes the business's open carts for the customer's number. */
  async orderCreated(order: OrderDoc): Promise<number> {
    const phone = order.customer.phone ?? order.shippingAddress.phone;
    if (!phone) return 0;
    return this.markOrdered(
      { phone, createdAt: { $lte: new Date(order.placedAt.getTime() + 60_000) } },
      order,
    );
  }

  private async markOrdered(filter: QueryFilter<Cart>, order: OrderDoc): Promise<number> {
    const open = await this.carts.find({ ...filter, status: 'open' });
    if (!open.length) return 0;
    const ids = open.flatMap((c) =>
      c.reminders
        .filter(
          (r) =>
            r.messageId &&
            r.at.getTime() <= order.placedAt.getTime() &&
            order.placedAt.getTime() - r.at.getTime() <= RECOVERY_WINDOW_MS,
        )
        .map((r) => r.messageId!),
    );
    const counted = new Set(
      (await this.sms.findMessages(ids))
        .filter((m) => COUNTED_STATUSES.has(m.status))
        .map((m) => m._id.toHexString()),
    );
    let closed = 0;
    for (const cart of open) {
      const recovered = cart.reminders.some((r) => r.messageId && counted.has(r.messageId));
      const done = await this.carts.updateOne(
        { _id: cart._id, status: 'open' },
        {
          $set: {
            status: 'ordered',
            recovered,
            nextReminderAt: null,
            order: {
              id: order._id.toHexString(),
              number: order.number,
              totalMinor: order.totalMinor,
              at: order.placedAt,
            },
          },
        },
      );
      if (done.modified) closed += 1;
    }
    return closed;
  }

  // ---------------------------------------------------------------- reminders

  private restoreUrl(cart: CartDoc): string {
    return `${cart.baseUrl}/r/${cart.code}`;
  }

  private async sendReminder(
    cart: CartDoc,
    text: string,
    key: string,
    settings: CartSettingsDoc,
    smsSettings: SmsSettingsDoc,
  ): Promise<SmsEnqueueResult> {
    const language = settings.language;
    const body = this.compose(
      text,
      {
        name: cart.name,
        shop: (await this.sms.shopValues(smsSettings)).shop,
        items: itemsSummary(cart.items, language),
        total: smsMoney(cart.totalMinor, cart.currency, language),
        link: this.restoreUrl(cart),
      },
      language,
      await this.sms.optOutUrl(cart.phone),
    );
    return this.sms.enqueue({
      to: cart.phone,
      text: body,
      purpose: 'cart_recovery',
      key,
      ref: {
        type: 'cart',
        id: cart._id.toHexString(),
        label: cart.landingPage?.name ?? cart.storeName,
      },
    });
  }

  /** Writes what the SMS layer did onto the reminder just added. */
  private async noteReminder(cart: CartDoc, index: number, result: SmsEnqueueResult) {
    await this.carts.updateOne(
      { _id: cart._id },
      {
        $set:
          result.message === null
            ? { [`reminders.${index}.skipped`]: result.skipped }
            : { [`reminders.${index}.messageId`]: result.message._id.toHexString() },
      },
    );
  }

  /** When the step after `index` should go, given that `index` went now. */
  private following(
    cart: CartDoc,
    steps: ReturnType<typeof enabledSteps>,
    index: number,
    now: Date,
  ): Date | null {
    const next = nextDue(cart.lastActivityAt, steps, index + 1, now);
    if (!next) return null;
    const gap = (steps[next.index]!.delayMinutes - steps[index]!.delayMinutes) * 60_000;
    return new Date(Math.max(next.at.getTime(), now.getTime() + gap));
  }

  /**
   * Looks at one due cart: sends its next reminder, or works out when to look again and
   * why not now. Runs inside the cart's business.
   */
  async evaluate(cartId: Types.ObjectId, now = new Date()): Promise<CartOutcome> {
    const cart = await this.carts.findById(cartId);
    if (!cart || cart.status !== 'open') return 'gone';
    // Only while nobody changed the cart meanwhile (a save moves its times).
    const same: QueryFilter<Cart> = {
      _id: cart._id,
      status: 'open',
      nextStep: cart.nextStep,
      lastActivityAt: cart.lastActivityAt,
    };
    const wait = async (at: Date | null, reason?: CartSkip): Promise<CartOutcome> => {
      await this.carts.updateOne(same, {
        $set: { nextReminderAt: at, ...(reason ? { lastSkip: { reason, at: now } } : {}) },
      });
      return reason ? `skipped:${reason}` : at ? 'waiting' : 'no_step';
    };

    const settings = await this.settings();
    if (!settings.enabled) return wait(null, 'reminders_off');
    if (!(await this.entitlements.hasModule(this.orgId(), 'marketing')))
      return wait(null, 'not_in_plan');
    const steps = enabledSteps(settings.steps);
    const due = nextDue(cart.lastActivityAt, steps, cart.nextStep, now);
    if (!due) return wait(null);
    if (due.at.getTime() > now.getTime()) return wait(due.at);

    const org = await this.orgs.get(this.orgId());
    if (inQuietHours(now, settings.quietHours, org.timezone))
      return wait(quietHoursEnd(now, settings.quietHours, org.timezone), 'quiet_hours');
    const order = await this.orders.findOne(
      {
        'customer.phone': cart.phone,
        placedAt: { $gte: new Date(cart.createdAt.getTime() - ORDER_LOOKBACK_MS) },
      },
      undefined,
      { sort: { placedAt: -1 } },
    );
    if (order) {
      await this.markOrdered({ _id: cart._id }, order);
      return 'ordered';
    }
    const recent = await this.carts.findOne(
      {
        phone: cart.phone,
        _id: { $ne: cart._id },
        lastReminderAt: { $gt: new Date(now.getTime() - SAME_PHONE_GAP_MS) },
      },
      { lastReminderAt: 1 },
      { sort: { lastReminderAt: -1 } },
    );
    if (recent?.lastReminderAt)
      return wait(new Date(recent.lastReminderAt.getTime() + SAME_PHONE_GAP_MS), 'recent_reminder');
    if (settings.minTotalMinor > 0 && cart.totalMinor < settings.minTotalMinor)
      return wait(null, 'below_minimum');
    const smsSettings = await this.sms.settings();
    if (smsSettings.mode === 'off')
      return wait(new Date(now.getTime() + SMS_OFF_RETRY_MS), 'sms_off');
    if (await this.sms.isOptedOut(cart.phone)) return wait(null, 'opted_out');

    const step = steps[due.index]!;
    const claimed = await this.carts.findOneAndUpdate(same, {
      $set: {
        nextStep: due.index + 1,
        lastReminderAt: now,
        nextReminderAt: this.following(cart, steps, due.index, now),
      },
      $unset: { lastSkip: 1 },
      $push: { reminders: { step: step.step, manual: false, at: now } },
    });
    if (!claimed) return 'raced';
    const result = await this.sendReminder(
      claimed,
      step.text,
      `cart:${cart._id.toHexString()}:${step.step}`,
      settings,
      smsSettings,
    );
    await this.noteReminder(claimed, claimed.reminders.length - 1, result);
    return 'sent';
  }

  /**
   * Looks at every cart whose next look has come, in every business, oldest first.
   * Crosses tenants: each cart is handled inside its own business.
   */
  async sweep(now = new Date()): Promise<Record<string, number>> {
    const due = await this.cartModel
      .find(
        { status: 'open', nextReminderAt: { $lte: now } },
        { _id: 1, orgId: 1 },
        { [CROSS_TENANT]: true },
      )
      .sort({ nextReminderAt: 1 })
      .limit(SWEEP_BATCH)
      .lean()
      .exec();
    const counts: Record<string, number> = {};
    for (const c of due) {
      let outcome: CartOutcome | 'error';
      try {
        outcome = await RequestContext.withTenant(
          c.orgId.toHexString(),
          () => this.evaluate(c._id, now),
          { type: 'system', id: 'cart-reminders' },
        );
      } catch (err) {
        this.logger.error({ err, cartId: c._id.toHexString() }, 'Cart reminder failed');
        outcome = 'error';
        // Look again in a while rather than on every sweep.
        await RequestContext.withTenant(c.orgId.toHexString(), () =>
          this.carts.updateOne(
            { _id: c._id, status: 'open' },
            { $set: { nextReminderAt: new Date(now.getTime() + SMS_OFF_RETRY_MS) } },
          ),
        ).catch(() => undefined);
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * "Send reminder now": the cart's next reminder goes at once (its step is then done), or,
   * when both steps went, the last one again. Skips quiet hours and the 24-hour rule.
   */
  async remindNow(id: string, now = new Date()) {
    const cart = await this.carts.findById(id);
    if (!cart) throw AppError.notFound('cart');
    if (cart.status !== 'open')
      throw AppError.conflict(
        'cart_closed',
        'This cart was ordered or its reminders were stopped.',
      );
    if (cart.manualReminders >= MAX_MANUAL_REMINDERS)
      throw AppError.conflict(
        'manual_limit',
        `This cart has had ${MAX_MANUAL_REMINDERS} reminders sent by hand already.`,
      );
    const smsSettings = await this.sms.settings();
    if (smsSettings.mode === 'off')
      throw AppError.unprocessable('sms_off', 'Turn on SMS in Settings › SMS first.');
    if (await this.sms.isOptedOut(cart.phone))
      throw AppError.unprocessable('opted_out', 'This number asked not to get these messages.');
    const settings = await this.settings();
    const steps = enabledSteps(settings.steps);
    // The next automatic step goes now (and counts as done); after both, the last one again.
    const due = cart.nextStep < steps.length ? { index: cart.nextStep } : null;
    const text =
      (due ? steps[due.index]!.text : steps.at(-1)?.text) ||
      settings.steps.find((s) => s.text.trim())?.text ||
      DEFAULT_CART_TEXTS[settings.language][0];
    const n = cart.manualReminders + 1;
    const actor = RequestContext.actor();
    const claimed = await this.carts.findOneAndUpdate(
      { _id: cart._id, status: 'open', manualReminders: cart.manualReminders },
      {
        $set: {
          manualReminders: n,
          lastReminderAt: now,
          ...(due
            ? {
                nextStep: due.index + 1,
                nextReminderAt: this.following(cart, steps, due.index, now),
              }
            : {}),
        },
        $unset: { lastSkip: 1 },
        $push: {
          reminders: {
            step: 0,
            manual: true,
            at: now,
            ...(actor.type === 'user' ? { by: actor.id } : {}),
          },
        },
      },
    );
    if (!claimed) throw AppError.conflict('try_again', 'The cart changed. Try again.');
    const result = await this.sendReminder(
      claimed,
      text,
      `cart:${cart._id.toHexString()}:manual:${n}`,
      settings,
      smsSettings,
    );
    await this.noteReminder(claimed, claimed.reminders.length - 1, result);
    return this.get(id);
  }

  async dismiss(id: string) {
    const done = await this.carts.findOneAndUpdate(
      { _id: new Types.ObjectId(id), status: 'open' },
      { $set: { status: 'dismissed', nextReminderAt: null } },
    );
    if (!done) {
      if (!(await this.carts.exists({ _id: new Types.ObjectId(id) })))
        throw AppError.notFound('cart');
      throw AppError.conflict('cart_closed', 'This cart was already ordered or stopped.');
    }
    return this.get(id);
  }

  // ---------------------------------------------------------------- reading

  private viewFilter(view: CartView, now: Date): QueryFilter<Cart> {
    switch (view) {
      case 'abandoned':
        return {
          status: 'open',
          lastActivityAt: { $lt: new Date(now.getTime() - ABANDONED_AFTER_MS) },
        };
      case 'recovered':
        return { status: 'ordered', recovered: true };
      case 'ordered':
        return { status: 'ordered' };
      case 'dismissed':
        return { status: 'dismissed' };
      case 'all':
        return {};
    }
  }

  async list(
    q: { view: CartView; phone?: string; limit: number; cursor?: string },
    now = new Date(),
  ): Promise<Page<ReturnType<CartsService['toDto']>>> {
    const filter: QueryFilter<Cart> = { ...this.viewFilter(q.view, now) };
    if (q.phone) filter.phone = q.phone;
    const page = await this.carts.paginate(filter, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const messages = await this.messagesFor(page.items);
    return { ...page, items: page.items.map((c) => this.toDto(c, messages, now)) };
  }

  async get(id: string) {
    const cart = Types.ObjectId.isValid(id) ? await this.carts.findById(id) : null;
    if (!cart) throw AppError.notFound('cart');
    return this.toDto(cart, await this.messagesFor([cart]));
  }

  private async messagesFor(carts: CartDoc[]) {
    const ids = carts.flatMap((c) =>
      c.reminders.map((r) => r.messageId).filter(Boolean),
    ) as string[];
    const found = await this.sms.findMessages(ids);
    return new Map(found.map((m) => [m._id.toHexString(), m]));
  }

  toDto(
    c: CartDoc,
    messages: Map<
      string,
      { status: SmsMessage['status']; priceMinor: number; currency: string; error?: string }
    >,
    now = new Date(),
  ) {
    const state: CartStatus | 'shopping' =
      c.status === 'open' && now.getTime() - c.lastActivityAt.getTime() < ABANDONED_AFTER_MS
        ? 'shopping'
        : c.status;
    return {
      id: c._id.toHexString(),
      source: c.source,
      store: { id: c.storeId.toHexString(), name: c.storeName },
      landingPage: c.landingPage ?? null,
      customer: { name: c.name, phone: c.phone },
      items: c.items,
      totalMinor: c.totalMinor,
      currency: c.currency,
      status: c.status,
      state,
      link: this.restoreUrl(c),
      lastActivityAt: c.lastActivityAt.toISOString(),
      nextReminderAt: c.status === 'open' ? (c.nextReminderAt?.toISOString() ?? null) : null,
      lastSkip:
        c.status === 'open' && c.lastSkip
          ? { reason: c.lastSkip.reason, at: c.lastSkip.at.toISOString() }
          : null,
      reminders: c.reminders.map((r) => {
        const m = r.messageId ? messages.get(r.messageId) : undefined;
        return {
          step: r.step,
          manual: r.manual,
          at: r.at.toISOString(),
          skipped: r.skipped ?? null,
          message: m
            ? {
                id: r.messageId!,
                status: m.status,
                priceMinor: m.priceMinor,
                currency: m.currency,
                error: m.error ?? null,
              }
            : null,
        };
      }),
      manualRemindersLeft: Math.max(0, MAX_MANUAL_REMINDERS - c.manualReminders),
      clicks: c.clicks,
      lastClickAt: c.lastClickAt?.toISOString() ?? null,
      order: c.order
        ? {
            id: c.order.id,
            number: c.order.number,
            totalMinor: c.order.totalMinor,
            at: c.order.at.toISOString(),
          }
        : null,
      recovered: c.recovered,
      createdAt: c.createdAt.toISOString(),
    };
  }

  /** The last 30 days: carts left, reminded, recovered and what the reminders cost. */
  async summary(now = new Date()) {
    const since = new Date(now.getTime() - 30 * 24 * 3600_000);
    const idleBefore = new Date(now.getTime() - ABANDONED_AFTER_MS);
    const remindedExpr = {
      $gt: [
        {
          $size: {
            $filter: { input: '$reminders', as: 'r', cond: { $gt: ['$$r.messageId', null] } },
          },
        },
        0,
      ],
    };
    const [row] = await this.carts.aggregate<{
      left: number;
      reminded: number;
      recovered: number;
      recoveredMinor: number;
      orderedOther: number;
      open: number;
      openMinor: number;
      dismissed: number;
      clicked: number;
    }>([
      { $match: { createdAt: { $gte: since } } },
      {
        $match: {
          $or: [{ status: { $ne: 'open' } }, { lastActivityAt: { $lt: idleBefore } }],
        },
      },
      {
        $group: {
          _id: null,
          left: { $sum: 1 },
          reminded: { $sum: { $cond: [remindedExpr, 1, 0] } },
          recovered: { $sum: { $cond: ['$recovered', 1, 0] } },
          recoveredMinor: { $sum: { $cond: ['$recovered', '$order.totalMinor', 0] } },
          orderedOther: {
            $sum: {
              $cond: [{ $and: [{ $eq: ['$status', 'ordered'] }, { $not: ['$recovered'] }] }, 1, 0],
            },
          },
          open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
          openMinor: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, '$totalMinor', 0] } },
          dismissed: { $sum: { $cond: [{ $eq: ['$status', 'dismissed'] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $gt: ['$clicks', 0] }, 1, 0] } },
        },
      },
    ]);
    const spent = await this.sms.spentOn('cart_recovery', since);
    const org = await this.orgs.get(this.orgId());
    const r = row ?? {
      left: 0,
      reminded: 0,
      recovered: 0,
      recoveredMinor: 0,
      orderedOther: 0,
      open: 0,
      openMinor: 0,
      dismissed: 0,
      clicked: 0,
    };
    return {
      days: 30,
      currency: org.currency,
      left: r.left,
      reminded: r.reminded,
      clicked: r.clicked,
      recovered: r.recovered,
      recoveredMinor: r.recoveredMinor,
      orderedWithoutReminder: r.orderedOther,
      open: r.open,
      openMinor: r.openMinor,
      dismissed: r.dismissed,
      smsSent: spent.count,
      smsSpentMinor: spent.spentMinor,
      recoveryRate: r.reminded ? r.recovered / r.reminded : null,
    };
  }
}
