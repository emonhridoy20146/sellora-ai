import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DnsAnswer } from '../../src/modules/stores/custom-domains.js';
import type { DnsLookup } from '../../src/modules/stores/dns-lookup.js';
import { StoreDomainsService } from '../../src/modules/stores/store-domains.service.js';
import { TestApp, type Session } from '../helpers/test-app.js';

const TARGET = 'edge.sellora-dns.test';
const IPS = ['203.0.113.10', '2001:db8::10'];

/** Plays the DNS provider: records per name, or a server that does not answer. */
class FakeDns implements DnsLookup {
  readonly zones = new Map<string, Partial<DnsAnswer>>();
  unreachable = false;
  lookups = 0;

  set(domain: string, records: Partial<DnsAnswer>) {
    this.zones.set(domain, records);
  }

  lookup(domain: string): Promise<DnsAnswer> {
    this.lookups += 1;
    const z = this.zones.get(domain) ?? {};
    return Promise.resolve({
      txt: z.txt ?? [],
      cname: z.cname ?? [],
      addresses: z.addresses ?? [],
      unreachable: this.unreachable,
    });
  }
}

interface DomainDto {
  id: string;
  domain: string;
  displayDomain: string;
  apex: boolean;
  status: string;
  primary: boolean;
  url: string;
  records: { type: string; name: string; value: string }[];
  dns: { ownership: boolean; routing: boolean; problems: string[] } | null;
  nextCheckAt: string | null;
  review: { reason: string | null };
}

describe('custom domains for stores', () => {
  let t: TestApp;
  const dns = new FakeDns();
  let owner: Session;
  let orgId: string;
  let storeId: string;
  let handle: string;
  let other: Session;
  let otherOrg: string;
  let otherStore: string;
  let platform: string;
  let key: string;

  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const domainsUrl = (store = storeId, org = orgId) => `/v1/orgs/${org}/stores/${store}/domains`;

  const add = async (domain: string, session = owner, org = orgId, store = storeId) =>
    (await t.as(session.token).post(domainsUrl(store, org)).send({ domain }).expect(201))
      .body as DomainDto;
  const check = async (id: string, session = owner, org = orgId, store = storeId) =>
    (
      await t
        .as(session.token)
        .post(`${domainsUrl(store, org)}/${id}/check`)
        .expect(200)
    ).body as DomainDto;
  const tokenOf = (d: DomainDto) => d.records.find((r) => r.type === 'TXT')!.value;
  const pointSubdomain = (d: DomainDto, extraTxt: string[] = []) =>
    dns.set(d.domain, { txt: [tokenOf(d), ...extraTxt], cname: [TARGET] });

  const shop = (host: string) =>
    t.http().get('/v1/storefront/resolve').set('x-storefront-key', key).set('x-store-host', host);
  const storeDto = async () =>
    (await O().get(`/v1/orgs/${orgId}/stores/${storeId}`).expect(200)).body as {
      url: string;
      selloraUrl: string;
      primaryDomain: string | null;
    };
  const setSettings = (stores: Record<string, unknown>) =>
    P().patch('/v1/platform/settings').send({ stores }).expect(200);
  const removeAll = async () => {
    for (const [org, store, session] of [
      [orgId, storeId, owner],
      [otherOrg, otherStore, other],
    ] as const) {
      const list = (await t.as(session.token).get(domainsUrl(store, org)).expect(200)).body as {
        items: DomainDto[];
      };
      for (const d of list.items)
        await t
          .as(session.token)
          .delete(`${domainsUrl(store, org)}/${d.id}`)
          .expect(204);
    }
    dns.zones.clear();
    dns.unreachable = false;
  };

  beforeAll(async () => {
    t = await TestApp.create(
      {
        STOREFRONT_DOMAIN_TARGET: TARGET,
        STOREFRONT_DOMAIN_IPS: IPS.join(','),
        WEB_APP_URL: 'https://app.sellora-web.test',
      },
      { dnsLookup: dns },
    );
    key = t.env.STOREFRONT_API_KEY!;
    await Promise.all(['Store', 'StoreDomain'].map((m) => t.db.model(m).init()));
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Nakshi Ghor', category: 'handicrafts' })).id;
    const store = (
      await O().post(`/v1/orgs/${orgId}/stores`).send({ name: 'Nakshi Ghor' }).expect(201)
    ).body as { id: string; handle: string };
    storeId = store.id;
    handle = store.handle;
    other = await t.registerUser({ name: 'Other owner' });
    otherOrg = (await t.createOrg(other, { name: 'Copy Shop' })).id;
    otherStore = (
      (
        await t
          .as(other.token)
          .post(`/v1/orgs/${otherOrg}/stores`)
          .send({ name: 'Copy Shop' })
          .expect(201)
      ).body as { id: string }
    ).id;
    platform = (await t.platformOwner()).token;
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await removeAll();
    await setSettings({ autoApproveDomains: false });
  });

  it('says how domains connect before one is added', async () => {
    const res = await O().get(domainsUrl()).expect(200);
    expect(res.body).toMatchObject({
      enabled: true,
      target: TARGET,
      apexAllowed: true,
      maxPerStore: 3,
      items: [],
      used: 0,
    });
  });

  it('refuses domains a business cannot own, and Sellora’s own names', async () => {
    const refused = async (domain: string, message: RegExp) => {
      const res = await O().post(domainsUrl()).send({ domain }).expect(422);
      expect(res.body.errors[0]).toMatchObject({
        path: 'domain',
        message: expect.stringMatching(message),
      });
    };
    await refused('not a domain', /Enter a domain/);
    await refused('203.0.113.9', /not an IP address/);
    await refused('com.bd', /not a domain you can own/);
    await refused('*.example.com', /without \*/);
    await refused(`${handle}.shops.test`, /Sellora address/);
    await refused('x.sellora-dns.test', /Sellora address/);
    await refused('app.sellora-web.test', /Sellora address/);
  });

  it('adds a domain with the records to create, and waits for them', async () => {
    const d = await add('https://WWW.Nakshi-Shop.com/');
    expect(d).toMatchObject({
      domain: 'www.nakshi-shop.com',
      apex: false,
      status: 'pending',
      primary: false,
      url: 'https://www.nakshi-shop.com',
    });
    expect(d.records).toEqual([
      expect.objectContaining({
        type: 'TXT',
        name: '_sellora-verify.www.nakshi-shop.com',
        value: expect.stringMatching(/^sellora-verify=[A-Za-z0-9_-]{22}$/),
      }),
      expect.objectContaining({ type: 'CNAME', name: 'www.nakshi-shop.com', value: TARGET }),
    ]);
    // Checked straight away: nothing there yet, so it tries again on its own.
    expect(d.dns).toMatchObject({ ownership: false, routing: false });
    expect(d.dns!.problems).toContain('The TXT record is not there yet.');
    expect(d.nextCheckAt).not.toBeNull();
    // Not served, and no certificate, while it is pending.
    await shop('www.nakshi-shop.com').expect(404);
    await t.http().get('/v1/public/store-domains/check?domain=www.nakshi-shop.com').expect(404);
    // The same name twice in one business is refused.
    const again = await O().post(domainsUrl()).send({ domain: 'www.nakshi-shop.com' }).expect(409);
    expect(again.body.code).toBe('domain_exists');
  });

  it('goes to review once both records are right, then holds the name', async () => {
    const d = await add('www.nakshi-shop.com');
    dns.set(d.domain, { txt: [tokenOf(d)] });
    const half = await check(d.id);
    expect(half).toMatchObject({ status: 'pending', dns: { ownership: true, routing: false } });
    expect(half.dns!.problems).toEqual(['The CNAME record is not there yet.']);

    pointSubdomain(d);
    const verified = await check(d.id);
    expect(verified).toMatchObject({
      status: 'review',
      dns: { ownership: true, routing: true },
      nextCheckAt: null,
    });
    // Still not served until a super-admin approves.
    await shop('www.nakshi-shop.com').expect(404);
    // Nobody else can add it now.
    const taken = await t
      .as(other.token)
      .post(domainsUrl(otherStore, otherOrg))
      .send({ domain: 'www.nakshi-shop.com' })
      .expect(409);
    expect(taken.body.code).toBe('domain_taken');
  });

  it('lets only the business whose code is in DNS claim a name', async () => {
    const mine = await add('shop.contested.com');
    const theirs = await add('shop.contested.com', other, otherOrg, otherStore);
    expect(tokenOf(mine)).not.toBe(tokenOf(theirs));
    pointSubdomain(mine);
    expect((await check(theirs.id, other, otherOrg, otherStore)).dns!.problems).toEqual([
      'The TXT record has a different code. Copy the value shown here exactly.',
    ]);
    expect((await check(mine.id)).status).toBe('review');
    // Even with its own code added too, the name is already held.
    pointSubdomain(mine, [tokenOf(theirs)]);
    const blocked = await check(theirs.id, other, otherOrg, otherStore);
    expect(blocked.status).toBe('pending');
    expect(blocked.dns!.problems).toEqual(['Another store on Sellora has connected this domain.']);
  });

  it('is approved by a super-admin, then serves the store and becomes its main address', async () => {
    const d = await add('www.nakshi-shop.com');
    pointSubdomain(d);
    await check(d.id);

    const queue = await P().get('/v1/platform/store-domains?status=review').expect(200);
    expect(queue.body).toMatchObject({ total: 1, review: 1 });
    expect(queue.body.items[0]).toMatchObject({
      domain: 'www.nakshi-shop.com',
      store: { id: storeId, name: 'Nakshi Ghor' },
      org: { id: orgId, name: 'Nakshi Ghor' },
    });
    const detail = await P().get(`/v1/platform/stores/${storeId}`).expect(200);
    expect(detail.body.domains).toEqual([expect.objectContaining({ status: 'review' })]);

    const approved = await P().post(`/v1/platform/store-domains/${d.id}/approve`).expect(200);
    expect(approved.body).toMatchObject({ status: 'active', primary: true });
    expect((await t.outbox(owner.email))[0]).toMatchObject({
      category: 'store.domain_connected',
      subject: expect.stringContaining('www.nakshi-shop.com'),
    });
    await P().post(`/v1/platform/store-domains/${d.id}/approve`).expect(409);

    expect(await storeDto()).toMatchObject({
      url: 'https://www.nakshi-shop.com',
      selloraUrl: `https://${handle}.shops.test`,
      primaryDomain: 'www.nakshi-shop.com',
    });
    // Both addresses find the store; links point at the main one.
    for (const host of ['www.nakshi-shop.com', 'WWW.NAKSHI-SHOP.COM.', `${handle}.shops.test`]) {
      const res = await shop(host).expect(200);
      expect(res.body).toMatchObject({ id: storeId, url: 'https://www.nakshi-shop.com' });
    }
    await shop('nakshi-shop.com').expect(404);
    await t.http().get('/v1/public/store-domains/check?domain=www.nakshi-shop.com').expect(200);
    await t.http().get('/v1/public/store-domains/check?domain=nakshi-shop.com').expect(404);
  });

  it('connects at once with automatic approval', async () => {
    await setSettings({ autoApproveDomains: true });
    const d = await add('www.nakshi-shop.com');
    pointSubdomain(d);
    expect(await check(d.id)).toMatchObject({ status: 'active', primary: true });
    expect((await t.outbox(owner.email))[0]!.category).toBe('store.domain_connected');
  });

  it('connects an apex domain only with A records that are all the storefront', async () => {
    const d = await add('nakshi-shop.com');
    expect(d.apex).toBe(true);
    expect(d.records.map((r) => `${r.type} ${r.value}`)).toEqual([
      `TXT ${tokenOf(d)}`,
      'A 203.0.113.10',
      'AAAA 2001:db8::10',
    ]);
    dns.set(d.domain, { txt: [tokenOf(d)], addresses: ['203.0.113.10', '198.51.100.7'] });
    const stray = await check(d.id);
    expect(stray).toMatchObject({ status: 'pending', dns: { routing: false } });
    expect(stray.dns!.problems).toEqual([
      'The domain also points to 198.51.100.7. Remove that record.',
    ]);
    dns.set(d.domain, { txt: [tokenOf(d)], addresses: ['203.0.113.10'] });
    expect((await check(d.id)).status).toBe('review');
  });

  it('never marks a domain wrong when DNS does not answer', async () => {
    const d = await add('www.nakshi-shop.com');
    pointSubdomain(d);
    dns.unreachable = true;
    const res = await check(d.id);
    expect(res.status).toBe('pending');
    expect(res.dns!.problems).toEqual([
      'Your domain’s DNS servers did not answer. We will try again.',
    ]);
  });

  it('lets the business choose the main address, and falls back when a domain goes', async () => {
    await setSettings({ autoApproveDomains: true });
    const www = await add('www.nakshi-shop.com');
    pointSubdomain(www);
    await check(www.id);
    const shopSub = await add('shop.nakshi-shop.com');
    pointSubdomain(shopSub);
    expect(await check(shopSub.id)).toMatchObject({ status: 'active', primary: false });
    const pending = await add('buy.nakshi-shop.com');

    const primary = `/v1/orgs/${orgId}/stores/${storeId}/primary-domain`;
    const notActive = await O().put(primary).send({ domainId: pending.id }).expect(409);
    expect(notActive.body.code).toBe('domain_not_active');
    expect((await O().put(primary).send({ domainId: shopSub.id }).expect(200)).body).toMatchObject({
      url: 'https://shop.nakshi-shop.com',
      primaryDomain: 'shop.nakshi-shop.com',
    });
    expect((await O().put(primary).send({ domainId: null }).expect(200)).body).toMatchObject({
      url: `https://${handle}.shops.test`,
      primaryDomain: null,
    });
    await O().put(primary).send({ domainId: shopSub.id }).expect(200);

    // A fourth domain is one too many for one store.
    const fourth = await O().post(domainsUrl()).send({ domain: 'www.fourth.com' }).expect(409);
    expect(fourth.body.code).toBe('too_many_domains');

    await O().delete(`${domainsUrl()}/${shopSub.id}`).expect(204);
    expect((await storeDto()).url).toBe(`https://${handle}.shops.test`);
    await shop('shop.nakshi-shop.com').expect(404);
    await shop('www.nakshi-shop.com').expect(200);
  });

  it('can be refused or disconnected by a super-admin, with a reason the owner reads', async () => {
    await setSettings({ autoApproveDomains: true });
    const d = await add('www.nakshi-shop.com');
    pointSubdomain(d);
    await check(d.id);
    await P().post(`/v1/platform/store-domains/${d.id}/reject`).send({ reason: 'no' }).expect(422);
    const res = await P()
      .post(`/v1/platform/store-domains/${d.id}/reject`)
      .send({ reason: 'This domain copies a well-known brand.' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'rejected',
      primary: false,
      review: { reason: 'This domain copies a well-known brand.' },
    });
    expect((await t.outbox(owner.email))[0]).toMatchObject({
      category: 'store.domain_rejected',
      text: expect.stringContaining('This domain copies a well-known brand.'),
    });
    expect((await storeDto()).primaryDomain).toBeNull();
    await shop('www.nakshi-shop.com').expect(404);
    await t.http().get('/v1/public/store-domains/check?domain=www.nakshi-shop.com').expect(404);
    // The name is free again for whoever proves it.
    const theirs = await add('www.nakshi-shop.com', other, otherOrg, otherStore);
    expect(theirs.status).toBe('pending');
  });

  it('checks due domains in the background and warns when a connected one breaks', async () => {
    await setSettings({ autoApproveDomains: true });
    const active = await add('www.nakshi-shop.com');
    pointSubdomain(active);
    await check(active.id);
    const pending = await add('shop.nakshi-shop.com');
    pointSubdomain(pending);
    dns.set(active.domain, { txt: [tokenOf(active)], cname: ['elsewhere.example.net'] });

    const svc = t.app.get(StoreDomainsService);
    const before = dns.lookups;
    expect(await svc.runDueChecks(new Date(Date.now() + 10 * 60_000))).toEqual({ checked: 1 });
    expect(dns.lookups).toBe(before + 1);
    expect(await svc.runDueChecks(new Date(Date.now() + 2 * 86_400_000))).toEqual({
      checked: 2,
    });
    const list = (await O().get(domainsUrl()).expect(200)).body.items as DomainDto[];
    const byName = new Map(list.map((d) => [d.domain, d]));
    expect(byName.get('shop.nakshi-shop.com')!.status).toBe('active');
    // Still connected (shoppers may reach it through caches), with what changed.
    expect(byName.get('www.nakshi-shop.com')).toMatchObject({
      status: 'active',
      dns: { routing: false },
    });
    expect(byName.get('www.nakshi-shop.com')!.dns!.problems).toEqual([
      `The CNAME record points to elsewhere.example.net, not ${TARGET}.`,
    ]);
  });

  it('holds the plan limit and rate-limits "Check now"', async () => {
    await P()
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ note: 'domain test', limits: { customDomains: 1 } })
      .expect(200);
    const d = await add('www.nakshi-shop.com');
    const over = await O().post(domainsUrl()).send({ domain: 'www.second.com' }).expect(402);
    expect(over.body.code).toBe('plan_limit_reached');
    await P()
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ note: 'domain test', limits: { customDomains: null } })
      .expect(200);
    for (let i = 0; i < 6; i += 1) await check(d.id);
    await O().post(`${domainsUrl()}/${d.id}/check`).expect(429);
  });

  it('keeps other businesses and staff without store rights out', async () => {
    const d = await add('www.nakshi-shop.com');
    await t.as(other.token).get(domainsUrl(storeId, otherOrg)).expect(404);
    await t
      .as(other.token)
      .post(`${domainsUrl(storeId, otherOrg)}/${d.id}/check`)
      .expect(404);
    // Another business's id answers as if it did not exist.
    await t.as(other.token).get(domainsUrl()).expect(404);
    const agent = await t.addMember(owner, orgId, 'sales_agent');
    await t.as(agent.token).post(domainsUrl()).send({ domain: 'www.agent.com' }).expect(403);
    await t.as(owner.token).get('/v1/platform/store-domains').expect(401);
  });

  it('removes a store’s domains with the store', async () => {
    const spare = (
      await O().post(`/v1/orgs/${orgId}/stores`).send({ name: 'Spare shop' }).expect(201)
    ).body as { id: string };
    await add('www.spare-shop.com', owner, orgId, spare.id);
    await O().delete(`/v1/orgs/${orgId}/stores/${spare.id}`).expect(204);
    expect(
      await t.db.collection('store_domains').countDocuments({ domain: 'www.spare-shop.com' }),
    ).toBe(0);
  });
});
