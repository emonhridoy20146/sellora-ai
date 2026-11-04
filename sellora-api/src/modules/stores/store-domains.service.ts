import { randomBytes } from 'node:crypto';
import { domainToUnicode } from 'node:url';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { AppConfig } from '../../config/app-config.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { escapeRegex } from '../commerce/text.js';
import { OrgsService, type OrganizationDoc } from '../orgs/orgs.service.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import {
  ACTIVE_RECHECK_MS,
  DOMAIN_MESSAGES,
  MAX_DOMAINS_PER_STORE,
  checkDomain,
  dnsRecords,
  judgeDns,
  nextPendingCheck,
  normalizeDomain,
  platformRoots,
} from './custom-domains.js';
import { DNS_LOOKUP, type DnsLookup } from './dns-lookup.js';
import { StoreDomainRepository, StoreRepository } from './repositories.js';
import type { DomainDnsCheck, DomainStatus, Store, StoreDomain } from './schemas.js';
import { StoreLinksService } from './store-links.service.js';
import { StoreNotifier } from './store-notifier.service.js';
import type { StoreDoc } from './stores.service.js';

export type StoreDomainDoc = WithId<StoreDomain>;

/** Due domains the worker checks per tick. */
const DUE_BATCH = 100;
const SYSTEM_ACTOR = { type: 'system' as const, id: 'store-domains' };

/**
 * Custom domains for stores (ADR 0015): a business adds its own domain, proves it with a
 * TXT record and points it at the storefront; once the DNS is right a super-admin approves
 * it (or it connects at once with automatic approval), and the store is served there.
 */
@Injectable()
export class StoreDomainsService {
  private readonly logger = new Logger(StoreDomainsService.name);

  constructor(
    @InjectModel('StoreDomain') private readonly model: Model<StoreDomain>,
    @InjectModel('Store') private readonly storeModel: Model<Store>,
    private readonly domains: StoreDomainRepository,
    private readonly stores: StoreRepository,
    private readonly entitlements: EntitlementsService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly orgs: OrgsService,
    private readonly links: StoreLinksService,
    private readonly notifier: StoreNotifier,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    @Inject(DNS_LOOKUP) private readonly dns: DnsLookup,
  ) {}

  // ---------------------------------------------------------------- set-up

  /** Where domains point; null when this server has no target (custom domains are off). */
  private target(): string | null {
    return this.config.get('STOREFRONT_DOMAIN_TARGET') ?? null;
  }

  private ips(): string[] {
    return this.config.get('STOREFRONT_DOMAIN_IPS');
  }

  /** What the dashboard needs to explain the records before a domain is added. */
  settings() {
    const target = this.target();
    return {
      enabled: target !== null,
      target,
      apexAllowed: target !== null && this.ips().length > 0,
      maxPerStore: MAX_DOMAINS_PER_STORE,
    };
  }

  private assertEnabled(): string {
    const target = this.target();
    if (!target)
      throw new AppError(
        'custom_domains_off',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Custom domains are not set up on this server yet. Ask the platform team to set STOREFRONT_DOMAIN_TARGET.',
      );
    return target;
  }

  /** Sellora's own registrable domains, which no business may add. */
  private roots(): string[] {
    const host = (url: string) => {
      try {
        return new URL(url).hostname;
      } catch {
        return undefined;
      }
    };
    return platformRoots([
      this.links.baseDomain(),
      this.target() ?? undefined,
      host(this.config.get('WEB_APP_URL')),
      host(this.config.get('API_PUBLIC_URL')),
    ]);
  }

  // ---------------------------------------------------------------- dto

  toDto(d: StoreDomainDoc, store?: Pick<Store, 'primaryDomain'> | null) {
    const target = this.target() ?? '';
    return {
      id: d._id.toHexString(),
      storeId: d.storeId.toHexString(),
      domain: d.domain,
      /** The domain as people write it (international names in their own script). */
      displayDomain: domainToUnicode(d.domain) || d.domain,
      apex: d.apex,
      status: d.status,
      primary: Boolean(store?.primaryDomain && store.primaryDomain === d.domain),
      url: `${this.config.get('STOREFRONT_URL_SCHEME')}://${this.links.domainHost(d.domain)}`,
      records: dnsRecords(d.domain, d.apex, d.token, target, this.ips()),
      dns: d.dns
        ? {
            checkedAt: d.dns.checkedAt.toISOString(),
            ownership: d.dns.ownership,
            routing: d.dns.routing,
            problems: d.dns.problems,
            found: d.dns.found,
          }
        : null,
      nextCheckAt: d.nextCheckAt?.toISOString() ?? null,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      activatedAt: d.activatedAt?.toISOString() ?? null,
      review: {
        decidedAt: d.review?.decidedAt?.toISOString() ?? null,
        reason: d.review?.reason ?? null,
      },
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- merchant

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private async store(storeId: string): Promise<StoreDoc> {
    const store = await this.stores.findById(storeId);
    if (!store) throw AppError.notFound('store');
    return store;
  }

  private async domain(store: StoreDoc, domainId: string): Promise<StoreDomainDoc> {
    const d = Types.ObjectId.isValid(domainId)
      ? await this.domains.findOne({ _id: new Types.ObjectId(domainId), storeId: store._id })
      : null;
    if (!d) throw AppError.notFound('domain');
    return d;
  }

  async list(storeId: string) {
    const store = await this.store(storeId);
    const [items, used, ent] = await Promise.all([
      this.domains.find({ storeId: store._id }, { sort: { createdAt: 1 } }),
      this.domains.count({ status: { $ne: 'rejected' } }),
      this.entitlements.forOrg(this.orgId()),
    ]);
    return {
      ...this.settings(),
      items: items.map((d) => this.toDto(d, store)),
      limit: ent.limits.customDomains,
      used,
    };
  }

  /** Whether a store anywhere holds this name (its DNS was proven). */
  private async claimedElsewhere(domain: string): Promise<boolean> {
    const found = await this.model
      .exists({ domain, claimed: true })
      .setOptions({ [CROSS_TENANT]: true })
      .exec();
    return found !== null;
  }

  async add(storeId: string, input: string) {
    this.assertEnabled();
    const store = await this.store(storeId);
    if (store.status === 'suspended')
      throw AppError.conflict(
        'store_suspended',
        'This store is suspended, so no domain can be added to it.',
      );
    const domain = normalizeDomain(input);
    const checked = domain
      ? checkDomain(domain, this.roots(), this.ips().length > 0)
      : ({ ok: false, problem: 'format' } as const);
    if (!checked.ok)
      throw AppError.validation([{ path: 'domain', message: DOMAIN_MESSAGES[checked.problem] }]);
    const { parsed } = checked;

    if ((await this.domains.count({ storeId: store._id })) >= MAX_DOMAINS_PER_STORE)
      throw AppError.conflict(
        'too_many_domains',
        `A store can have ${MAX_DOMAINS_PER_STORE} domains. Remove one to add another.`,
      );
    await this.entitlements.assertWithinLimit(
      this.orgId(),
      'customDomains',
      await this.domains.count({ status: { $ne: 'rejected' } }),
    );
    if (await this.domains.exists({ domain: parsed.domain }))
      throw AppError.conflict(
        'domain_exists',
        'This domain is already added to one of your stores.',
        { domain: parsed.domain },
      );
    if (await this.claimedElsewhere(parsed.domain))
      throw AppError.conflict(
        'domain_taken',
        'This domain is connected to another store on Sellora. If it is yours, contact support.',
        { domain: parsed.domain },
      );

    const created = await this.domains.create({
      storeId: store._id,
      domain: parsed.domain,
      apex: parsed.apex,
      token: randomBytes(16).toString('base64url'),
      status: 'pending',
      claimed: false,
      checks: 0,
      review: {},
      createdBy: new Types.ObjectId(RequestContext.actor().id),
    });
    await this.audit.record({
      action: 'store.domain_added',
      orgId: this.orgId(),
      target: { type: 'store', id: store._id.toHexString(), label: store.name },
      metadata: { domain: parsed.domain, apex: parsed.apex },
    });
    // The records may already be there (a domain added again); look straight away.
    const checkedNow = await this.runCheck(created, store);
    return this.toDto(checkedNow, await this.stores.findById(store._id));
  }

  /** "Check now" from the dashboard. */
  async check(storeId: string, domainId: string) {
    this.assertEnabled();
    const store = await this.store(storeId);
    const d = await this.domain(store, domainId);
    await this.limits.consume('domain-check:domain', d._id.toHexString());
    const after = await this.runCheck(d, store);
    return this.toDto(after, await this.stores.findById(store._id));
  }

  /** Makes an active domain the store's main address, or (null) goes back to Sellora's. */
  async setPrimary(storeId: string, domainId: string | null) {
    const store = await this.store(storeId);
    let primary: string | null = null;
    if (domainId) {
      const d = await this.domain(store, domainId);
      if (d.status !== 'active')
        throw AppError.conflict(
          'domain_not_active',
          'Only a connected domain can be the main address.',
        );
      primary = d.domain;
    }
    const after = (await this.stores.findOneAndUpdate(
      { _id: store._id },
      primary ? { $set: { primaryDomain: primary } } : { $unset: { primaryDomain: '' } },
    ))!;
    await this.audit.record({
      action: 'store.domain_primary',
      orgId: this.orgId(),
      target: { type: 'store', id: store._id.toHexString(), label: store.name },
      metadata: { from: store.primaryDomain ?? null, to: primary },
    });
    return after;
  }

  async remove(storeId: string, domainId: string): Promise<void> {
    const store = await this.store(storeId);
    const d = await this.domain(store, domainId);
    await this.domains.deleteOne({ _id: d._id });
    if (store.primaryDomain === d.domain)
      await this.stores.updateOne(
        { _id: store._id, primaryDomain: d.domain },
        { $unset: { primaryDomain: '' } },
      );
    await this.audit.record({
      action: 'store.domain_removed',
      orgId: this.orgId(),
      target: { type: 'store', id: store._id.toHexString(), label: store.name },
      metadata: { domain: d.domain, status: d.status },
    });
  }

  // ---------------------------------------------------------------- checking DNS

  /**
   * Looks the domain up and records what was found. A pending domain whose records are both
   * right claims its name and goes to review (or straight to active with automatic approval);
   * an active one only records the result, so the business sees a warning if it broke.
   */
  async runCheck(d: StoreDomainDoc, store: StoreDoc): Promise<StoreDomainDoc> {
    const target = this.target();
    if (!target) return d;
    const answer = await this.dns.lookup(d.domain);
    const verdict = judgeDns(answer, { apex: d.apex, token: d.token, target, ips: this.ips() });
    const now = new Date();
    const dns: DomainDnsCheck = {
      checkedAt: now,
      ownership: verdict.ownership,
      routing: verdict.routing,
      problems: verdict.problems,
      found: { txt: answer.txt, cname: answer.cname, addresses: answer.addresses },
    };
    const checks = d.checks + 1;

    if (d.status === 'pending' && verdict.ownership && verdict.routing) {
      const auto = (await this.platformSettings.get()).stores.autoApproveDomains;
      try {
        const claimed = await this.domains.findOneAndUpdate(
          { _id: d._id, status: 'pending' },
          {
            $set: {
              status: auto ? 'active' : 'review',
              claimed: true,
              verifiedAt: now,
              dns,
              checks,
              ...(auto
                ? {
                    activatedAt: now,
                    nextCheckAt: new Date(now.getTime() + ACTIVE_RECHECK_MS),
                    review: { decidedAt: now, decidedBy: { id: 'auto' } },
                  }
                : {}),
            },
            ...(auto ? {} : { $unset: { nextCheckAt: '' } }),
          },
        );
        if (claimed) {
          await this.audit.record({
            action: auto ? 'store.domain_connected' : 'store.domain_verified',
            orgId: d.orgId,
            target: { type: 'store', id: store._id.toHexString(), label: store.name },
            metadata: { domain: d.domain, autoApproved: auto },
          });
          if (auto) await this.afterActivation(claimed, store);
          return claimed;
        }
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        dns.problems = ['Another store on Sellora has connected this domain.'];
      }
    }

    const update: Record<string, unknown> = { dns, checks };
    const unset: Record<string, ''> = {};
    if (d.status === 'pending') {
      const next = nextPendingCheck(d.createdAt, checks, now);
      if (next) update.nextCheckAt = next;
      else unset.nextCheckAt = '';
    } else if (d.status === 'active') {
      update.nextCheckAt = new Date(now.getTime() + ACTIVE_RECHECK_MS);
    }
    return (
      (await this.domains.findOneAndUpdate(
        { _id: d._id },
        { $set: update, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      )) ?? d
    );
  }

  /** A newly active domain becomes the main address when the store has none. */
  private async afterActivation(d: StoreDomainDoc, store: StoreDoc): Promise<void> {
    await this.stores.updateOne(
      { _id: store._id, primaryDomain: { $exists: false } },
      { $set: { primaryDomain: d.domain } },
    );
    const after = await this.stores.findById(store._id);
    await this.notifier.notifyOwner(store, 'store.domain_connected', (locale) =>
      mailTemplates.domainConnected(locale, {
        storeName: store.name,
        domain: domainToUnicode(d.domain) || d.domain,
        storeUrl: this.links.url(after ?? store),
      }),
    );
  }

  /** The worker's tick: checks domains whose next check is due. */
  async runDueChecks(now = new Date()): Promise<{ checked: number }> {
    if (!this.target()) return { checked: 0 };
    const due = await this.model
      .find({ nextCheckAt: { $lte: now } }, null, { [CROSS_TENANT]: true })
      .sort({ nextCheckAt: 1 })
      .limit(DUE_BATCH)
      .lean<StoreDomainDoc[]>()
      .exec();
    let checked = 0;
    for (const d of due) {
      try {
        await RequestContext.withTenant(
          d.orgId.toHexString(),
          async () => {
            const store = await this.stores.findById(d.storeId);
            if (!store) {
              await this.domains.deleteOne({ _id: d._id });
              return;
            }
            await this.runCheck(d, store);
          },
          SYSTEM_ACTOR,
        );
        checked += 1;
      } catch (err) {
        this.logger.error({ err, domainId: d._id.toHexString() }, 'Domain check failed');
      }
    }
    return { checked };
  }

  // ---------------------------------------------------------------- finding stores

  /** The store id an active custom domain serves, or null. */
  async activeStoreId(domain: string): Promise<Types.ObjectId | null> {
    const d = await this.model
      .findOne({ domain, status: 'active' }, { storeId: 1 })
      .setOptions({ [CROSS_TENANT]: true })
      .lean<{ storeId: Types.ObjectId }>()
      .exec();
    return d?.storeId ?? null;
  }

  // ---------------------------------------------------------------- super-admin

  private async load(id: string): Promise<StoreDomainDoc> {
    const d = Types.ObjectId.isValid(id)
      ? await this.model
          .findById(id)
          .setOptions({ [CROSS_TENANT]: true })
          .lean<StoreDomainDoc>()
          .exec()
      : null;
    if (!d) throw AppError.notFound('domain');
    return d;
  }

  private orgSummary(org: OrganizationDoc | undefined) {
    return org ? { id: org._id.toHexString(), name: org.name, status: org.status } : null;
  }

  async platformList(q: { status?: DomainStatus; q?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.q) filter.domain = { $regex: escapeRegex(q.q.toLowerCase()), $options: 'i' };
    const sort: Record<string, 1 | -1> =
      q.status === 'review' ? { verifiedAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
    const [items, total, review] = await Promise.all([
      this.model
        .find(filter, null, { [CROSS_TENANT]: true })
        .sort(sort)
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<StoreDomainDoc[]>()
        .exec(),
      this.model
        .countDocuments(filter)
        .setOptions({ [CROSS_TENANT]: true })
        .exec(),
      this.model
        .countDocuments({ status: 'review' })
        .setOptions({ [CROSS_TENANT]: true })
        .exec(),
    ]);
    const [stores, orgs] = await Promise.all([
      this.storeModel
        .find({ _id: { $in: items.map((d) => d.storeId) } }, null, { [CROSS_TENANT]: true })
        .lean<StoreDoc[]>()
        .exec(),
      Promise.all(
        [...new Set(items.map((d) => d.orgId.toHexString()))].map((id) =>
          this.orgs.get(id).catch(() => undefined),
        ),
      ),
    ]);
    const storeById = new Map(stores.map((s) => [s._id.toHexString(), s]));
    const orgById = new Map(orgs.filter(Boolean).map((o) => [o!._id.toHexString(), o!]));
    return {
      items: items.map((d) => {
        const store = storeById.get(d.storeId.toHexString());
        return {
          ...this.toDto(d, store),
          store: store
            ? {
                id: store._id.toHexString(),
                name: store.name,
                handle: store.handle,
                status: store.status,
              }
            : null,
          org: this.orgSummary(orgById.get(d.orgId.toHexString())),
        };
      }),
      total,
      review,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** A store's domains, for the super-admin's store page. */
  async forStore(store: StoreDoc) {
    const items = await this.model
      .find({ storeId: store._id }, null, { [CROSS_TENANT]: true })
      .sort({ createdAt: 1 })
      .lean<StoreDomainDoc[]>()
      .exec();
    return items.map((d) => this.toDto(d, store));
  }

  private async decide(
    id: string,
    from: DomainStatus[],
    to: DomainStatus,
    reason: string | undefined,
    action: string,
    message: string,
  ): Promise<{ domain: StoreDomainDoc; store: StoreDoc }> {
    const d = await this.load(id);
    return RequestContext.withTenant(d.orgId.toHexString(), async () => {
      const store = await this.stores.findById(d.storeId);
      if (!store) throw AppError.notFound('store');
      const now = new Date();
      const by = { id: RequestContext.actor().id };
      const after = await this.domains.findOneAndUpdate(
        { _id: d._id, status: { $in: from } },
        {
          $set: {
            status: to,
            claimed: to === 'active',
            'review.decidedAt': now,
            'review.decidedBy': by,
            ...(to === 'active'
              ? { activatedAt: now, nextCheckAt: new Date(now.getTime() + ACTIVE_RECHECK_MS) }
              : { 'review.reason': reason }),
          },
          ...(to === 'active'
            ? { $unset: { 'review.reason': '' } }
            : { $unset: { nextCheckAt: '' } }),
        },
      );
      if (!after) throw AppError.conflict('invalid_domain_status', message, { status: d.status });
      if (to !== 'active' && store.primaryDomain === d.domain)
        await this.stores.updateOne(
          { _id: store._id, primaryDomain: d.domain },
          { $unset: { primaryDomain: '' } },
        );
      await this.audit.record({
        action,
        orgId: d.orgId,
        target: { type: 'store', id: store._id.toHexString(), label: store.name },
        metadata: { domain: d.domain, from: d.status, to, ...(reason ? { reason } : {}) },
      });
      return { domain: after, store };
    });
  }

  async approve(id: string) {
    const { domain, store } = await this.decide(
      id,
      ['review'],
      'active',
      undefined,
      'platform.store_domain.approved',
      'Only a domain waiting for review can be approved.',
    );
    await RequestContext.withTenant(domain.orgId.toHexString(), () =>
      this.afterActivation(domain, store),
    );
    return this.load(id);
  }

  /** Refuses a domain in review, or disconnects an active one. */
  async reject(id: string, reason: string) {
    const { domain, store } = await this.decide(
      id,
      ['review', 'active'],
      'rejected',
      reason,
      'platform.store_domain.rejected',
      'Only a domain in review or connected can be refused.',
    );
    await this.notifier.notifyOwner(store, 'store.domain_rejected', (locale) =>
      mailTemplates.domainRejected(locale, {
        storeName: store.name,
        domain: domainToUnicode(domain.domain) || domain.domain,
        reason,
        dashboardUrl: this.notifier.dashboardUrl(store, 'domain'),
      }),
    );
    return this.load(id);
  }

  /** The super-admin's view of one domain, with its store. */
  async platformDetail(d: StoreDomainDoc) {
    const store = await this.storeModel
      .findById(d.storeId)
      .setOptions({ [CROSS_TENANT]: true })
      .lean<StoreDoc>()
      .exec();
    return this.toDto(d, store);
  }
}
