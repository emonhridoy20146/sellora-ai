import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LandingPagesService } from '../../src/modules/landing-pages/landing-pages.service.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface Section {
  id: string;
  type: string;
  [k: string]: unknown;
}

interface Content {
  sections: Section[];
  offer: { productId: string | null; packages: unknown[]; addOn: unknown; noteField: boolean };
  [k: string]: unknown;
}

interface PageDto {
  id: string;
  slug: string;
  status: string;
  revision: number;
  hasUnpublishedChanges: boolean;
  submission: { status: string; purpose: string; publishAt: string | null } | null;
  scheduled: { revision: number; publishAt: string; autoApproved: boolean } | null;
  pauseAt: string | null;
  abTest: { id: string; splitB: number } | null;
  published: { version: number; revision: number } | null;
  paused: boolean;
  draft: Content;
}

interface AbTestDto {
  id: string;
  status: string;
  settings: { splitB: number; autoWinner: boolean; minVisitors: number; maxDays: number };
  a: { version: number };
  b: { revision: number };
  counts: Record<
    'a' | 'b',
    { visitors: number; buyers: number; orders: number; revenueMinor: number }
  >;
  result: { leader: string | null; confidence: number | null; enoughVisitors: boolean };
  endsBy: string | null;
  endReason: string | null;
  winner: string | null;
  publishedVersion: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Scheduled publishing, offer ends and A/B tests on landing pages (ADR 0031). */
describe('landing pages: scheduling and A/B tests', () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let orgId: string;
  let otherOrgId: string;
  let platform: string;
  let key: string;
  let variantId: string;
  let page: PageDto;
  let sweep: LandingPagesService['sweep'];

  const handle = 'mehedi-corner';
  const host = `${handle}.shops.test`;
  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const lp = (path = '') => `/v1/orgs/${orgId}/landing-pages${path}`;

  const shop = (method: 'get' | 'post', path: string, ab?: string, preview?: string) => {
    let req = t
      .http()
      [method](`/v1/storefront/landing-pages${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', '203.0.113.20');
    if (ab) req = req.set('x-shopper-ab', ab);
    if (preview) req = req.set('x-store-preview', preview);
    return req;
  };
  const shownHeading = async (ab?: string, preview?: string) => {
    const view = await shop('get', `/${page.slug}`, ab, preview).expect(200);
    const hero = (view.body.sections as Section[]).find((s) => s.type === 'hero');
    return { state: view.body.state as string, heading: (hero?.heading as string) ?? null };
  };

  const getPage = async () =>
    (
      await O()
        .get(lp(`/${page.id}`))
        .expect(200)
    ).body as PageDto;
  /** Saves the draft with a new headline. */
  const edit = async (heading: string) => {
    const now = await getPage();
    const content = {
      ...now.draft,
      sections: now.draft.sections.map((s) => (s.type === 'hero' ? { ...s, heading } : s)),
    };
    page = (
      await O()
        .put(lp(`/${page.id}/draft`))
        .send({ content, revision: now.revision })
        .expect(200)
    ).body as PageDto;
    return page;
  };
  const submit = (body: Record<string, unknown> = {}) =>
    O()
      .post(lp(`/${page.id}/submit`))
      .send(body);
  const setAuto = (on: boolean) =>
    P()
      .patch('/v1/platform/settings')
      .send({ stores: { autoApproveLandingPages: on } })
      .expect(200);
  const abTests = async () =>
    (
      await O()
        .get(lp(`/${page.id}/ab-tests`))
        .expect(200)
    ).body as {
      items: AbTestDto[];
      running: string | null;
    };
  const visitor = (n: number) => `ab-visitor-${n.toString().padStart(6, '0')}`;
  const order = (ab: string, phone: string, idem: string) =>
    shop('post', `/${page.slug}/orders`, ab)
      .set('idempotency-key', idem)
      .send({
        packageId: null,
        variantId,
        quantity: 1,
        customer: { name: 'Sadia Islam', phone },
        address: { line1: 'House 5, Road 2', area: 'Mirpur', city: 'Dhaka' },
        zoneId: 'dhaka',
      });

  beforeAll(async () => {
    t = await TestApp.create({});
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Mehedi Corner', category: 'beauty' })).id;
    other = await t.registerUser({ name: 'Other' });
    otherOrgId = (await t.createOrg(other, { name: 'Other Shop', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      [
        'Store',
        'Product',
        'Customer',
        'Order',
        'LandingPage',
        'LandingPageVersion',
        'LandingAbTest',
      ].map((m) => t.db.model(m).init()),
    );
    const service = t.app.get(LandingPagesService);
    sweep = (now?: Date) => service.sweep(now);
    const storeId = (
      (
        await O()
          .post(`/v1/orgs/${orgId}/stores`)
          .send({ name: 'Mehedi Corner', handle })
          .expect(201)
      ).body as { id: string }
    ).id;
    const product = (
      await O()
        .post(`/v1/orgs/${orgId}/products`)
        .send({ name: 'Henna Cone', variants: [{ priceMinor: 25_000, stock: 500 }] })
        .expect(201)
    ).body as { id: string; variants: { id: string }[] };
    variantId = product.variants[0]!.id;
    await O()
      .patch(`/v1/orgs/${orgId}/shop-settings`)
      .send({
        deliveryZones: [{ id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 }],
        defaultZoneId: 'dhaka',
      })
      .expect(200);
    page = (
      await O()
        .post(lp())
        .send({ storeId, name: 'Henna offer', productId: product.id, template: 'quick_order' })
        .expect(201)
    ).body as PageDto;
    // A short page of the business's own words: the hero and the order form.
    const content = {
      ...page.draft,
      sections: page.draft.sections.filter((s) => s.type === 'hero' || s.type === 'order_form'),
      offer: { ...page.draft.offer, packages: [], addOn: null },
    };
    page = (
      await O()
        .put(lp(`/${page.id}/draft`))
        .send({ content, revision: 1 })
        .expect(200)
    ).body as PageDto;
    await edit('Headline one');
    await setAuto(true);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('scheduled publishing', () => {
    it('refuses times too soon or too far away', async () => {
      const soon = await submit({ publishAt: new Date(Date.now() + 20_000).toISOString() }).expect(
        422,
      );
      expect(soon.body.errors[0]).toMatchObject({ path: 'publishAt' });
      const far = await submit({ publishAt: new Date(Date.now() + 91 * DAY).toISOString() }).expect(
        422,
      );
      expect(far.body.errors[0].message).toContain('90 days');
      // A/B tests cannot be sent on a page that is not live yet.
      const test = await submit({ purpose: 'ab_test' }).expect(409);
      expect(test.body.code).toBe('page_not_live');
    });

    it('keeps an approved version until its time, shows it in a preview, then publishes it', async () => {
      const at = new Date(Date.now() + 2 * HOUR);
      page = (await submit({ publishAt: at.toISOString() }).expect(200)).body as PageDto;
      expect(page).toMatchObject({
        status: 'scheduled',
        submission: null,
        published: null,
        scheduled: { revision: page.revision, publishAt: at.toISOString(), autoApproved: true },
      });
      // Shoppers do not see a page that was never published.
      await shop('get', `/${page.slug}`).expect(404);
      const link = await O()
        .post(lp(`/${page.id}/preview`))
        .send({ kind: 'scheduled' })
        .expect(200);
      const token = new URL(link.body.url).searchParams.get('preview')!;
      expect(await shownHeading(undefined, token)).toEqual({
        state: 'preview',
        heading: 'Headline one',
      });

      const later = new Date(Date.now() + 3 * HOUR);
      page = (
        await O()
          .patch(lp(`/${page.id}/scheduled`))
          .send({ publishAt: later.toISOString() })
          .expect(200)
      ).body as PageDto;
      expect(page.scheduled!.publishAt).toBe(later.toISOString());

      expect(await sweep(new Date(Date.now() + 2.5 * HOUR))).toMatchObject({ published: 0 });
      expect((await getPage()).status).toBe('scheduled');
      expect(await sweep(new Date(Date.now() + 3.5 * HOUR))).toMatchObject({ published: 1 });
      page = await getPage();
      expect(page).toMatchObject({ status: 'live', scheduled: null, published: { version: 1 } });
      expect(await shownHeading()).toEqual({ state: 'live', heading: 'Headline one' });
      // Running again publishes nothing twice.
      expect(await sweep(new Date(Date.now() + 4 * HOUR))).toMatchObject({ published: 0 });
    });

    it('replaces, publishes now, or cancels a scheduled version while the live one stays', async () => {
      await edit('Headline two');
      await submit({ publishAt: new Date(Date.now() + DAY).toISOString() }).expect(200);
      await edit('Headline three');
      page = (await submit({ publishAt: new Date(Date.now() + 2 * DAY).toISOString() }).expect(200))
        .body as PageDto;
      // One scheduled version at a time: the newer one replaced the first.
      expect(page.scheduled!.revision).toBe(page.revision);
      // The draft is on its way, so it is not reported as unpublished changes.
      expect(page.hasUnpublishedChanges).toBe(false);
      expect(await shownHeading()).toMatchObject({ heading: 'Headline one' });

      page = (
        await O()
          .post(lp(`/${page.id}/scheduled/publish-now`))
          .expect(200)
      ).body as PageDto;
      expect(page).toMatchObject({ scheduled: null, published: { version: 2 } });
      expect(await shownHeading()).toMatchObject({ heading: 'Headline three' });

      await edit('Headline four');
      await submit({ publishAt: new Date(Date.now() + DAY).toISOString() }).expect(200);
      page = (
        await O()
          .delete(lp(`/${page.id}/scheduled`))
          .expect(200)
      ).body as PageDto;
      expect(page.scheduled).toBeNull();
      expect(
        (
          await O()
            .delete(lp(`/${page.id}/scheduled`))
            .expect(409)
        ).body.code,
      ).toBe('nothing_scheduled');
      expect(await shownHeading()).toMatchObject({ heading: 'Headline three' });
    });

    it('lets the reviewer approve a version for later, and tells the business when it goes live', async () => {
      await setAuto(false);
      const at = new Date(Date.now() + 5 * HOUR);
      page = (await submit({ publishAt: at.toISOString() }).expect(200)).body as PageDto;
      expect(page.submission).toMatchObject({
        status: 'pending',
        purpose: 'publish',
        publishAt: at.toISOString(),
      });
      const approved = await P()
        .post(`/v1/platform/landing-pages/${page.id}/approve`)
        .send({ revision: page.revision })
        .expect(200);
      expect(approved.body).toMatchObject({
        status: 'live',
        scheduled: { publishAt: at.toISOString(), autoApproved: false },
      });
      const mails = (await t.outbox(owner.email)).filter(
        (m) => m.category === 'landing_page.approved',
      );
      expect(mails.at(-1)?.text).toContain('goes live by itself');
      await O()
        .delete(lp(`/${page.id}/scheduled`))
        .expect(200);
      await setAuto(true);
    });

    it("keeps another business out of a page's schedule", async () => {
      const as = t.as(other.token);
      const path = `/v1/orgs/${otherOrgId}/landing-pages/${page.id}`;
      await as.delete(`${path}/scheduled`).expect(404);
      await as.put(`${path}/offer-end`).send({ pauseAt: null }).expect(404);
      await as.get(`${path}/ab-tests`).expect(404);
      await as.post(`${path}/ab-tests/end`).send({ keep: 'a' }).expect(404);
      // Nor through this business's address: a business one is not part of does not exist.
      await as.get(lp(`/${page.id}/ab-tests`)).expect(404);
    });
  });

  describe('offer end', () => {
    it('pauses the live page when the offer ends', async () => {
      const bad = await O()
        .put(lp(`/${page.id}/offer-end`))
        .send({ pauseAt: new Date(Date.now() - HOUR).toISOString() })
        .expect(422);
      expect(bad.body.errors[0].path).toBe('pauseAt');
      const at = new Date(Date.now() + 6 * HOUR);
      page = (
        await O()
          .put(lp(`/${page.id}/offer-end`))
          .send({ pauseAt: at.toISOString() })
          .expect(200)
      ).body as PageDto;
      expect(page.pauseAt).toBe(at.toISOString());
      expect(await sweep(new Date(Date.now() + 5 * HOUR))).toMatchObject({ paused: 0 });
      expect(await sweep(new Date(Date.now() + 7 * HOUR))).toMatchObject({ paused: 1 });
      page = await getPage();
      expect(page).toMatchObject({ paused: true, pauseAt: null, status: 'paused' });
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('paused');
      await O()
        .post(lp(`/${page.id}/resume`))
        .expect(200);

      await O()
        .put(lp(`/${page.id}/offer-end`))
        .send({ pauseAt: at.toISOString() })
        .expect(200);
      page = (
        await O()
          .put(lp(`/${page.id}/offer-end`))
          .send({ pauseAt: null })
          .expect(200)
      ).body as PageDto;
      expect(page.pauseAt).toBeNull();
      expect(await sweep(new Date(Date.now() + 7 * HOUR))).toMatchObject({ paused: 0 });
    });
  });

  describe('A/B tests', () => {
    it('starts a test with a new version next to the live one', async () => {
      await edit('Headline B');
      const bad = await submit({ purpose: 'ab_test', abTest: { splitB: 99 } }).expect(422);
      expect(bad.body.code).toBe('validation_failed');
      const timed = await submit({
        purpose: 'ab_test',
        publishAt: new Date(Date.now() + DAY).toISOString(),
      }).expect(422);
      expect(timed.body.errors[0].path).toBe('publishAt');
      page = (await submit({ purpose: 'ab_test', abTest: { autoWinner: false } }).expect(200))
        .body as PageDto;
      expect(page).toMatchObject({
        status: 'live',
        published: { version: 2 },
        abTest: { splitB: 50 },
        hasUnpublishedChanges: false,
      });
      const list = await abTests();
      expect(list.running).toBe(page.abTest!.id);
      expect(list.items[0]).toMatchObject({
        status: 'running',
        settings: { splitB: 50, autoWinner: false, minVisitors: 300, maxDays: 14 },
        a: { version: 2 },
        b: { revision: page.revision },
        endsBy: null,
      });
      // Nothing else is published, tested or scheduled while it runs.
      await edit('Headline C');
      expect((await getPage()).hasUnpublishedChanges).toBe(true);
      expect((await submit().expect(409)).body.code).toBe('ab_test_running');
      expect((await submit({ purpose: 'ab_test' }).expect(409)).body.code).toBe('ab_test_running');
      expect(
        (await submit({ publishAt: new Date(Date.now() + DAY).toISOString() }).expect(409)).body
          .code,
      ).toBe('ab_test_running');
      // The preview shows version B.
      const link = await O()
        .post(lp(`/${page.id}/preview`))
        .send({ kind: 'ab_test' })
        .expect(200);
      const token = new URL(link.body.url).searchParams.get('preview')!;
      expect((await shownHeading(undefined, token)).heading).toBe('Headline B');
    });

    it('shows each browser the same version, about half of them B, and counts each visitor once', async () => {
      const seen: Record<string, 'a' | 'b'> = {};
      for (let i = 0; i < 40; i++) {
        const { state, heading } = await shownHeading(visitor(i));
        expect(state).toBe('live');
        expect(['Headline three', 'Headline B']).toContain(heading);
        seen[visitor(i)] = heading === 'Headline B' ? 'b' : 'a';
        // The same browser sees the same version again.
        expect((await shownHeading(visitor(i))).heading).toBe(heading);
      }
      const bCount = Object.values(seen).filter((v) => v === 'b').length;
      expect(bCount).toBeGreaterThan(8);
      expect(bCount).toBeLessThan(32);
      // Without an A/B id (or with a malformed one) the live version is shown.
      expect((await shownHeading()).heading).toBe('Headline three');
      expect((await shownHeading('bad id!')).heading).toBe('Headline three');

      for (const v of Object.keys(seen)) {
        await shop('post', `/${page.slug}/visit`, v).send({ visitorId: v }).expect(200);
        await shop('post', `/${page.slug}/visit`, v).send({ visitorId: v }).expect(200);
      }
      const { items } = await abTests();
      expect(items[0]!.counts.a.visitors).toBe(40 - bCount);
      expect(items[0]!.counts.b.visitors).toBe(bCount);

      // An order counts for the version the shopper saw: orders, revenue, and buyers once.
      const bVisitor = Object.keys(seen).find((v) => seen[v] === 'b')!;
      const aVisitor = Object.keys(seen).find((v) => seen[v] === 'a')!;
      const first = await order(bVisitor, '01911000001', 'idem-ab-000001').expect(201);
      await order(bVisitor, '01911000002', 'idem-ab-000002').expect(201);
      await order(aVisitor, '01911000003', 'idem-ab-000003').expect(201);
      // A visitor the visit beacon never reached is counted when they order.
      const unseen = visitor(999);
      const unseenVariant = (await shownHeading(unseen)).heading === 'Headline B' ? 'b' : 'a';
      await order(unseen, '01911000004', 'idem-ab-000004').expect(201);

      const after = (await abTests()).items[0]!;
      const extraB = unseenVariant === 'b' ? 1 : 0;
      expect(after.counts.b).toMatchObject({
        visitors: bCount + extraB,
        buyers: 1 + extraB,
        orders: 2 + extraB,
      });
      expect(after.counts.a).toMatchObject({
        visitors: 40 - bCount + (1 - extraB),
        buyers: 1 + (1 - extraB),
        orders: 1 + (1 - extraB),
      });
      expect(after.counts.b.revenueMinor).toBe((2 + extraB) * first.body.totalMinor);

      const orders = await O().get(`/v1/orgs/${orgId}/orders?landingPageId=${page.id}`).expect(200);
      const placed = (
        orders.body.items as {
          number: string;
          landingPage: { abTestId: string; variant: string };
        }[]
      ).find((o) => o.number === first.body.orderNumber);
      expect(placed?.landingPage).toMatchObject({ abTestId: page.abTest!.id, variant: 'b' });
    });

    it('ends when the business chooses B, which goes live as a new version', async () => {
      const testId = page.abTest!.id;
      page = (
        await O()
          .post(lp(`/${page.id}/ab-tests/end`))
          .send({ keep: 'b' })
          .expect(200)
      ).body as PageDto;
      expect(page).toMatchObject({ abTest: null, published: { version: 3 } });
      expect((await shownHeading(visitor(1))).heading).toBe('Headline B');
      const { items, running } = await abTests();
      expect(running).toBeNull();
      expect(items[0]).toMatchObject({
        id: testId,
        status: 'ended',
        endReason: 'chosen',
        winner: 'b',
        publishedVersion: 3,
      });
      expect(
        (
          await O()
            .post(lp(`/${page.id}/ab-tests/end`))
            .send({ keep: 'a' })
            .expect(409)
        ).body.code,
      ).toBe('no_ab_test');
    });

    it('makes a clear winner live by itself, and keeps A when there is none after its days', async () => {
      const tests = t.db.collection('landing_ab_tests');
      await edit('Headline D');
      page = (await submit({ purpose: 'ab_test' }).expect(200)).body as PageDto;
      const first = page.abTest!.id;
      expect((await abTests()).items[0]!.endsBy).not.toBeNull();
      expect(await sweep()).toMatchObject({ tests: 0 });
      // 3% against 5% of 1,000 visitors each: about 97.7% sure B is better.
      await tests.updateOne(
        { _id: new (await import('mongoose')).Types.ObjectId(first) },
        {
          $set: {
            counts: {
              a: { visitors: 1_000, buyers: 30, orders: 30, revenueMinor: 900_000 },
              b: { visitors: 1_000, buyers: 50, orders: 52, revenueMinor: 1_500_000 },
            },
          },
        },
      );
      expect((await abTests()).items[0]!.result).toMatchObject({
        leader: 'b',
        enoughVisitors: true,
      });
      expect(await sweep()).toMatchObject({ tests: 1 });
      page = await getPage();
      expect(page).toMatchObject({ abTest: null, published: { version: 4 } });
      expect((await shownHeading()).heading).toBe('Headline D');
      expect((await abTests()).items[0]).toMatchObject({
        endReason: 'auto_winner',
        winner: 'b',
        publishedVersion: 4,
      });

      await edit('Headline E');
      page = (await submit({ purpose: 'ab_test', abTest: { maxDays: 7 } }).expect(200))
        .body as PageDto;
      expect(await sweep(new Date(Date.now() + 6 * DAY))).toMatchObject({ tests: 0 });
      expect(await sweep(new Date(Date.now() + 7 * DAY + HOUR))).toMatchObject({ tests: 1 });
      page = await getPage();
      expect(page).toMatchObject({ abTest: null, published: { version: 4 } });
      expect((await shownHeading(visitor(2))).heading).toBe('Headline D');
      expect((await abTests()).items[0]).toMatchObject({
        endReason: 'no_clear_winner',
        winner: 'a',
        publishedVersion: null,
      });
    });

    it('ends without a winner when Sellora takes the page down', async () => {
      page = (await submit({ purpose: 'ab_test' }).expect(200)).body as PageDto;
      expect(page.abTest).not.toBeNull();
      const down = await P()
        .post(`/v1/platform/landing-pages/${page.id}/takedown`)
        .send({ reason: 'Checking the claims on this page.' })
        .expect(200);
      expect(down.body).toMatchObject({ status: 'taken_down', abTest: null });
      expect((await abTests()).items[0]).toMatchObject({
        status: 'ended',
        endReason: 'taken_down',
        winner: null,
      });
      expect((await shop('get', `/${page.slug}`, visitor(1)).expect(200)).body.state).toBe(
        'unavailable',
      );
      await P().post(`/v1/platform/landing-pages/${page.id}/reinstate`).expect(200);
      expect((await shownHeading(visitor(1))).heading).toBe('Headline D');
    });
  });
});
