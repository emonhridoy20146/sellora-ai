import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Section {
  id: string;
  type: string;
  enabled: boolean;
  hideOn: string;
  [k: string]: unknown;
}

interface Content {
  sections: Section[];
  offer: {
    productId: string | null;
    packages: {
      id: string;
      label: string;
      quantity: number;
      priceMinor: number | null;
      badge: string;
    }[];
    addOn: { productId: string; variantId: string; priceMinor: number; label: string } | null;
    noteField: boolean;
  };
  seo: { title: string; description: string; image: unknown; index: boolean };
  settings: { stickyButton: boolean; stickyLabel: string };
}

interface PageDto {
  id: string;
  name: string;
  slug: string;
  url: string;
  status: string;
  revision: number;
  hasUnpublishedChanges: boolean;
  slugLocked: boolean;
  productId: string | null;
  submission: { status: string; revision: number; reason: string | null; flags: unknown[] } | null;
  published: { version: number; revision: number; autoApproved: boolean } | null;
  paused: boolean;
  takedown: { reason: string } | null;
  last30Days?: { visitors: number; orders: number; revenueMinor: number };
  draft: Content;
}

interface ProductDto {
  id: string;
  variants: { id: string; priceMinor: number; stock: number }[];
}

describe('landing pages', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let platform: string;
  let key: string;
  let storeId: string;
  let gel: ProductDto;
  let soap: ProductDto;
  let page: PageDto;

  const handle = 'aloe-bazar';
  const host = `${handle}.shops.test`;
  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const lp = (path = '') => url(`/landing-pages${path}`);

  /** A request as the storefront app makes it. */
  const shop = (method: 'get' | 'post', path: string, h = host, preview?: string) => {
    const req = t
      .http()
      [method](`/v1/storefront/landing-pages${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', h)
      .set('x-shopper-ip', '203.0.113.9');
    return preview ? req.set('x-store-preview', preview) : req;
  };

  const getPage = async (id = page.id) =>
    (
      await O()
        .get(lp(`/${id}`))
        .expect(200)
    ).body as PageDto;

  const save = async (content: Content, revision: number, id = page.id) =>
    (
      await O()
        .put(lp(`/${id}/draft`))
        .send({ content, revision })
        .expect(200)
    ).body as PageDto;

  const setSettings = (stores: Record<string, unknown>) =>
    P().patch('/v1/platform/settings').send({ stores }).expect(200);

  const setOverrides = (body: Record<string, unknown>) =>
    P()
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ note: 'landing test', ...body })
      .expect(200);

  const uploadImage = async (): Promise<string> => {
    const started = (
      await O()
        .post(url('/files/uploads'))
        .send({
          purpose: 'store_asset',
          filename: 'review.png',
          contentType: 'image/png',
          size: PNG.length,
        })
        .expect(201)
    ).body as { file: { id: string }; upload: { url: string; headers: Record<string, string> } };
    const target = new URL(started.upload.url);
    await t
      .http()
      .put(target.pathname + target.search)
      .set('content-type', started.upload.headers['content-type']!)
      .send(PNG)
      .expect(204);
    await O()
      .post(url(`/files/${started.file.id}/complete`))
      .expect(200);
    return started.file.id;
  };

  const orderBody = (extra: Record<string, unknown> = {}) => ({
    packageId: 'pkg002',
    variantId: gel.variants[0]!.id,
    addOn: true,
    customer: { name: 'Nasrin Sultana', phone: '01811223344' },
    address: { line1: 'Flat 3B, Road 11', area: 'Banani', city: 'Dhaka' },
    zoneId: 'dhaka',
    note: 'Please call first',
    attribution: { utmSource: 'facebook', utmCampaign: 'eid-aloe', fbclid: 'IwAR0abc', gclid: '' },
    ...extra,
  });
  const order = (body: Record<string, unknown>, idem?: string, h = host) => {
    const req = shop('post', `/${page.slug}/orders`, h);
    return (idem ? req.set('idempotency-key', idem) : req).send(body);
  };

  beforeAll(async () => {
    t = await TestApp.create({ API_PUBLIC_URL: 'http://api.test' });
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Aloe Bazar', category: 'beauty' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      [
        'Store',
        'Product',
        'Customer',
        'Order',
        'StoredFile',
        'LandingPage',
        'LandingPageVersion',
        'LandingPageStat',
      ].map((m) => t.db.model(m).init()),
    );
    // A store that is still a draft: landing pages do not need the store to be open.
    storeId = (
      (await O().post(url('/stores')).send({ name: 'Aloe Bazar', handle }).expect(201)).body as {
        id: string;
      }
    ).id;
    await O()
      .patch(url(`/stores/${storeId}`))
      .send({ contact: { phone: '01712345678', whatsapp: '01712345678' } })
      .expect(200);
    gel = (
      await O()
        .post(url('/products'))
        .send({
          name: 'Aloe Vera Gel',
          description: 'Cools and soothes the skin after the sun.',
          options: [{ name: 'Size', values: ['100ml', '200ml'] }],
          variants: [
            { optionValues: ['100ml'], priceMinor: 45_000, stock: 10 },
            { optionValues: ['200ml'], priceMinor: 80_000, stock: 1 },
          ],
        })
        .expect(201)
    ).body as ProductDto;
    soap = (
      await O()
        .post(url('/products'))
        .send({ name: 'Neem Soap', variants: [{ priceMinor: 15_000, stock: 5 }] })
        .expect(201)
    ).body as ProductDto;
    await O()
      .patch(url('/shop-settings'))
      .send({
        deliveryZones: [
          { id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 },
          { id: 'outside', name: 'Outside Dhaka', chargeMinor: 12_000 },
        ],
        defaultZoneId: 'dhaka',
      })
      .expect(200);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('building a page', () => {
    it('lists templates and checks addresses', async () => {
      const templates = await O().get(lp('/templates')).expect(200);
      expect(templates.body.items.map((x: { key: string }) => x.key)).toEqual([
        'full_offer',
        'problem_solution',
        'quick_order',
      ]);
      const check = async (slug: string) =>
        (
          await O()
            .get(lp(`/slug-check?storeId=${storeId}&slug=${slug}`))
            .expect(200)
        ).body as {
          available: boolean;
          reason: string | null;
          url?: string;
        };
      expect(await check('checkout')).toMatchObject({ available: false });
      expect(await check('x')).toMatchObject({ available: false });
      expect(await check('aloe-offer')).toMatchObject({
        available: true,
        url: `https://${host}/aloe-offer`,
      });
    });

    it('creates a draft from a template, filled with the product', async () => {
      const res = await O()
        .post(lp())
        .send({ storeId, name: 'Aloe Eid offer', productId: gel.id, template: 'full_offer' })
        .expect(201);
      page = res.body as PageDto;
      expect(page).toMatchObject({
        name: 'Aloe Eid offer',
        slug: 'aloe-eid-offer',
        url: `https://${host}/aloe-eid-offer`,
        status: 'draft',
        revision: 1,
        hasUnpublishedChanges: true,
        slugLocked: false,
        productId: gel.id,
        submission: null,
        published: null,
      });
      expect(page.draft.sections.filter((s) => s.type === 'order_form')).toHaveLength(1);
      expect(JSON.stringify(page.draft)).toContain('Aloe Vera Gel');

      const taken = await O()
        .post(lp())
        .send({
          storeId,
          name: 'Copy',
          slug: 'aloe-eid-offer',
          productId: gel.id,
          template: 'quick_order',
        })
        .expect(409);
      expect(taken.body.code).toBe('slug_taken');
      await O()
        .post(lp())
        .send({ storeId, name: 'Bad', slug: 'cart', productId: gel.id, template: 'quick_order' })
        .expect(422);
      await O()
        .post(lp())
        .send({ storeId, name: 'Bad', productId: '0'.repeat(24), template: 'quick_order' })
        .expect(422);

      const list = await O().get(lp()).expect(200);
      expect(list.body).toMatchObject({ used: 1, limit: null });
      expect(list.body.items[0]).toMatchObject({
        id: page.id,
        status: 'draft',
        last30Days: { visitors: 0, orders: 0, revenueMinor: 0 },
      });
      expect(list.body.items[0].draft).toBeUndefined();
    });

    it('saves the draft: packages, an add-on, a picture; refuses stale saves and bad references', async () => {
      const image = await uploadImage();
      const content: Content = {
        ...page.draft,
        sections: [
          ...page.draft.sections,
          {
            id: 'vid001',
            type: 'video',
            enabled: true,
            hideOn: 'none',
            title: 'See it work',
            url: 'https://youtu.be/dQw4w9WgXcQ',
          },
          {
            id: 'rev001',
            type: 'reviews',
            enabled: true,
            hideOn: 'none',
            title: 'Customers say',
            items: [
              {
                name: 'Mina',
                text: 'Works well',
                rating: 5,
                image: { fileId: image, url: '', alt: 'Chat' },
              },
            ],
          },
        ],
        offer: {
          ...page.draft.offer,
          packages: [
            { id: 'pkg001', label: '1 jar', quantity: 1, priceMinor: null, badge: '' },
            {
              id: 'pkg002',
              label: '2 jars: save 100',
              quantity: 2,
              priceMinor: 80_000,
              badge: 'Best value',
            },
          ],
          addOn: {
            productId: soap.id,
            variantId: soap.variants[0]!.id,
            priceMinor: 9_900,
            label: 'Add a neem soap for 99',
          },
        },
      };
      const stale = await O()
        .put(lp(`/${page.id}/draft`))
        .send({ content, revision: 7 })
        .expect(409);
      expect(stale.body.code).toBe('page_changed');
      const badRef = await O()
        .put(lp(`/${page.id}/draft`))
        .send({
          content: {
            ...content,
            offer: {
              ...content.offer,
              addOn: { ...content.offer.addOn!, variantId: '1'.repeat(24) },
            },
          },
          revision: 1,
        })
        .expect(422);
      expect(badRef.body.errors[0].path).toBe('content.offer.addOn.variantId');
      const html = await O()
        .put(lp(`/${page.id}/draft`))
        .send({
          content: { ...content, sections: [{ ...content.sections[0], html: '<b>x</b>' }] },
          revision: 1,
        })
        .expect(422);
      expect(html.body.code).toBe('validation_failed');

      page = await save(content, 1);
      expect(page.revision).toBe(2);
      const reviews = page.draft.sections.find((s) => s.id === 'rev001') as unknown as {
        items: { image: { url: string } }[];
      };
      expect(reviews.items[0]!.image.url).toMatch(/^http/);
    });

    it('is not shown to shoppers before it is published, except through a preview link', async () => {
      await shop('get', `/${page.slug}`).expect(404);
      const link = await O()
        .post(lp(`/${page.id}/preview`))
        .send({})
        .expect(200);
      expect(link.body.url).toContain(`https://${host}/${page.slug}?preview=`);
      const token = new URL(link.body.url).searchParams.get('preview')!;
      const view = await shop('get', `/${page.slug}`, host, token).expect(200);
      expect(view.body).toMatchObject({
        state: 'preview',
        page: { id: page.id, slug: page.slug },
        store: {
          name: 'Aloe Bazar',
          open: false,
          currency: 'BDT',
          contact: { phone: '01712345678' },
        },
        seo: { index: false },
        product: { id: gel.id, name: 'Aloe Vera Gel' },
        addOn: { label: 'Add a neem soap for 99', priceMinor: 9_900, regularPriceMinor: 15_000 },
        zones: [
          { id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 },
          { id: 'outside', name: 'Outside Dhaka', chargeMinor: 12_000 },
        ],
        defaultZoneId: 'dhaka',
      });
      expect(view.body.packages).toHaveLength(2);
      expect(view.body.sections.find((s: Section) => s.id === 'vid001').embed).toEqual({
        provider: 'youtube',
        id: 'dQw4w9WgXcQ',
      });
      expect(view.body.product.variants[1]).toMatchObject({ maxQuantity: 1, available: true });
      expect(view.body.product.variants[0].costMinor).toBeUndefined();
      // A preview never takes orders and never counts visits.
      await order(orderBody(), 'idem-preview-001').expect(404);
      // A token for another page does not open this one.
      await shop('get', '/no-such-page', host, token).expect(404);
    });
  });

  describe('review and publishing', () => {
    it('sends a snapshot for review; the reviewer approves that snapshot, not later edits', async () => {
      const sent = await O()
        .post(lp(`/${page.id}/submit`))
        .expect(200);
      expect(sent.body).toMatchObject({
        status: 'in_review',
        submission: { status: 'pending', revision: 2 },
      });
      expect(
        (
          await O()
            .post(lp(`/${page.id}/submit`))
            .expect(409)
        ).body.code,
      ).toBe('already_in_review');

      // The business keeps editing while it waits.
      const edited = await save(
        {
          ...page.draft,
          sections: page.draft.sections.map((s) =>
            s.type === 'hero' ? { ...s, heading: 'Edited after sending' } : s,
          ),
        },
        2,
      );
      expect(edited).toMatchObject({ status: 'in_review', revision: 3 });

      const queue = await P().get('/v1/platform/landing-pages?status=pending').expect(200);
      expect(queue.body.pending).toBe(1);
      expect(queue.body.items[0]).toMatchObject({
        id: page.id,
        status: 'in_review',
        org: { id: orgId, name: 'Aloe Bazar' },
        store: { handle },
      });
      const detail = await P().get(`/v1/platform/landing-pages/${page.id}`).expect(200);
      expect(detail.body.preview.url).toContain(`/${page.slug}?preview=`);
      expect(detail.body.org).toMatchObject({ id: orgId, currency: 'BDT' });
      expect(detail.body.products.map((p: { role: string }) => p.role).sort()).toEqual([
        'add_on',
        'main',
      ]);
      expect(JSON.stringify(detail.body.submissionContent)).not.toContain('Edited after sending');

      const stale = await P()
        .post(`/v1/platform/landing-pages/${page.id}/approve`)
        .send({ revision: 3 })
        .expect(409);
      expect(stale.body.code).toBe('submission_changed');
      const approved = await P()
        .post(`/v1/platform/landing-pages/${page.id}/approve`)
        .send({ revision: 2 })
        .expect(200);
      expect(approved.body).toMatchObject({
        status: 'live',
        published: { version: 1, revision: 2, autoApproved: false },
        hasUnpublishedChanges: true,
        slugLocked: true,
      });
      const mail = (await t.outbox(owner.email)).find(
        (m) => m.category === 'landing_page.approved',
      );
      expect(mail?.text).toContain(`https://${host}/${page.slug}`);

      const view = await shop('get', `/${page.slug}`).expect(200);
      expect(view.body.state).toBe('live');
      expect(view.body.seo.index).toBe(true);
      expect(JSON.stringify(view.body.sections)).not.toContain('Edited after sending');
      const sitemap = await shop('get', '').expect(200);
      expect(sitemap.body.items.map((i: { slug: string }) => i.slug)).toEqual([page.slug]);
    });

    it('keeps the address of a published page', async () => {
      const res = await O()
        .patch(lp(`/${page.id}`))
        .send({ slug: 'new-address' })
        .expect(409);
      expect(res.body.code).toBe('slug_locked');
      const renamed = await O()
        .patch(lp(`/${page.id}`))
        .send({ name: 'Aloe Eid offer 2026' })
        .expect(200);
      expect(renamed.body).toMatchObject({ name: 'Aloe Eid offer 2026', slug: 'aloe-eid-offer' });
      page = await getPage();
    });
  });

  describe('orders from the page', () => {
    let receipt: string;
    let number: string;

    it('places a pending order priced on the server, with the page and the ad it came from', async () => {
      await order(orderBody()).expect(400);
      // The browser cannot set prices: unknown fields are refused.
      await order({ ...orderBody(), priceMinor: 1 }, 'idem-lp-0000').expect(422);
      const first = await order(orderBody(), 'idem-lp-0001').expect(201);
      // 2 jars for 800 + soap for 99 + delivery 60 = 959.
      expect(first.body).toMatchObject({ totalMinor: 95_900, currency: 'BDT', duplicate: false });
      receipt = first.body.receipt;
      number = first.body.orderNumber;
      const again = await order(orderBody(), 'idem-lp-0001').expect(201);
      expect(again.body.orderNumber).toBe(number);

      const placed = (
        await O()
          .get(url(`/orders?landingPageId=${page.id}`))
          .expect(200)
      ).body.items as Record<string, unknown>[];
      expect(placed).toHaveLength(1);
      const full = (
        await O()
          .get(url(`/orders/${placed[0]!.id as string}`))
          .expect(200)
      ).body;
      expect(full).toMatchObject({
        number,
        status: 'pending',
        source: 'landing_page',
        landingPage: { id: page.id, name: 'Aloe Eid offer 2026', slug: 'aloe-eid-offer' },
        attribution: { utmSource: 'facebook', utmCampaign: 'eid-aloe', fbclid: 'IwAR0abc' },
        subtotalMinor: 105_000,
        discountMinor: 15_100,
        deliveryChargeMinor: 6_000,
        totalMinor: 95_900,
        customerNote: 'Package: 2 jars: save 100\nPlease call first',
      });
      expect(full.attribution.gclid).toBeUndefined();
      expect(full.items).toEqual([
        expect.objectContaining({ name: 'Aloe Vera Gel', quantity: 2, unitPriceMinor: 45_000 }),
        expect.objectContaining({ name: 'Neem Soap', quantity: 1, unitPriceMinor: 15_000 }),
      ]);
    });

    it('gives the same phone its first receipt again instead of a second order', async () => {
      const second = await order(orderBody({ addOn: false }), 'idem-lp-0002').expect(201);
      expect(second.body).toMatchObject({ orderNumber: number, duplicate: true });
      expect(
        (
          await O()
            .get(url(`/orders?landingPageId=${page.id}`))
            .expect(200)
        ).body.items,
      ).toHaveLength(1);
    });

    it('refuses what cannot be sold, and bots', async () => {
      const phone = (n: number) => ({ customer: { name: 'Karim', phone: `0171000000${n}` } });
      const big = await order(
        orderBody({ ...phone(1), variantId: gel.variants[1]!.id }),
        'idem-lp-0003',
      ).expect(409);
      expect(big.body).toMatchObject({ code: 'not_enough_stock', left: 1 });
      const noPkg = await order(orderBody({ ...phone(2), packageId: null }), 'idem-lp-0004').expect(
        422,
      );
      expect(noPkg.body.errors[0].path).toBe('packageId');
      const noZone = await order(orderBody({ ...phone(3), zoneId: null }), 'idem-lp-0005').expect(
        422,
      );
      expect(noZone.body.errors[0].path).toBe('zoneId');
      const wrongVariant = await order(
        orderBody({ ...phone(4), variantId: soap.variants[0]!.id }),
        'idem-lp-0006',
      ).expect(422);
      expect(wrongVariant.body.errors[0].path).toBe('variantId');
      const bot = await order(
        orderBody({ ...phone(5), website: 'http://spam' }),
        'idem-lp-0007',
      ).expect(422);
      expect(bot.body.code).toBe('order_not_accepted');
    });

    it('shows the receipt only with its signed link', async () => {
      const res = await shop(
        'get',
        `/${page.slug}/receipt?receipt=${encodeURIComponent(receipt)}`,
      ).expect(200);
      expect(res.body).toMatchObject({
        order: { number, totalMinor: 95_900, customer: { phone: '**********3344' } },
        page: { slug: page.slug },
        store: { name: 'Aloe Bazar' },
      });
      const tampered = `${receipt.slice(0, -2)}${receipt.endsWith('A') ? 'B' : 'A'}A`;
      await shop('get', `/${page.slug}/receipt?receipt=${encodeURIComponent(tampered)}`).expect(
        404,
      );
    });

    it('counts visitors once per browser and day, and the numbers add up', async () => {
      const visit = (visitorId: string) =>
        shop('post', `/${page.slug}/visit`).send({ visitorId }).expect(200);
      expect((await visit('visitor-aaaa-0001')).body.counted).toBe(true);
      expect((await visit('visitor-aaaa-0001')).body.counted).toBe(false);
      expect((await visit('visitor-bbbb-0002')).body.counted).toBe(true);
      await shop('post', `/${page.slug}/visit`).send({ visitorId: '<script>' }).expect(422);

      const stats = await O()
        .get(lp(`/${page.id}/stats?days=7`))
        .expect(200);
      expect(stats.body.days).toHaveLength(7);
      expect(stats.body).toMatchObject({
        total: { visitors: 2, orders: 1, revenueMinor: 95_900 },
        conversionRate: 0.5,
        currency: 'BDT',
      });
      const list = await O().get(lp()).expect(200);
      expect(list.body.items[0].last30Days).toEqual({
        visitors: 2,
        orders: 1,
        revenueMinor: 95_900,
      });
    });

    it('stops taking orders while paused', async () => {
      expect(
        (
          await O()
            .post(lp(`/${page.id}/pause`))
            .expect(200)
        ).body.status,
      ).toBe('paused');
      const view = await shop('get', `/${page.slug}`).expect(200);
      expect(view.body.state).toBe('paused');
      expect(view.body.sections).toBeUndefined();
      const res = await order(
        orderBody({ customer: { name: 'Late', phone: '01799887766' } }),
        'idem-lp-0008',
      ).expect(409);
      expect(res.body.code).toBe('offer_not_available');
      expect(
        (
          await shop('post', `/${page.slug}/visit`)
            .send({ visitorId: 'visitor-cccc-0003' })
            .expect(200)
        ).body.counted,
      ).toBe(false);
      expect((await shop('get', '').expect(200)).body.items).toEqual([]);
      await O()
        .post(lp(`/${page.id}/pause`))
        .expect(409);
      expect(
        (
          await O()
            .post(lp(`/${page.id}/resume`))
            .expect(200)
        ).body.status,
      ).toBe('live');
    });
  });

  describe('changes after going live', () => {
    it('asks for changes with a reason while the approved version stays live', async () => {
      page = await getPage();
      await O()
        .post(lp(`/${page.id}/submit`))
        .expect(200);
      const rejected = await P()
        .post(`/v1/platform/landing-pages/${page.id}/reject`)
        .send({ revision: page.revision, reason: 'Do not promise a cure in the heading.' })
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'live',
        submission: { status: 'rejected', reason: 'Do not promise a cure in the heading.' },
      });
      const mail = (await t.outbox(owner.email)).find(
        (m) => m.category === 'landing_page.rejected',
      );
      expect(mail?.text).toContain('Do not promise a cure in the heading.');
      expect(mail?.text).toContain(`/app/${orgId}/landing-pages/${page.id}`);
      expect(mail?.text).toContain('stays live');
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('live');
    });

    it('publishes at once with automatic approval, unless the word check finds something', async () => {
      await setSettings({ autoApproveLandingPages: true });
      page = await getPage();
      const auto = await O()
        .post(lp(`/${page.id}/submit`))
        .expect(200);
      expect(auto.body).toMatchObject({
        status: 'live',
        published: { version: 2, revision: page.revision, autoApproved: true },
        hasUnpublishedChanges: false,
        submission: null,
      });
      expect(
        (
          await O()
            .post(lp(`/${page.id}/submit`))
            .expect(409)
        ).body.code,
      ).toBe('nothing_to_publish');
      const view = await shop('get', `/${page.slug}`).expect(200);
      expect(JSON.stringify(view.body.sections)).toContain('Edited after sending');

      const flagged = await save(
        {
          ...page.draft,
          sections: page.draft.sections.map((s) =>
            s.type === 'hero' ? { ...s, heading: 'Better than any master copy' } : s,
          ),
        },
        page.revision,
      );
      const sent = await O()
        .post(lp(`/${flagged.id}/submit`))
        .expect(200);
      expect(sent.body.status).toBe('live');
      expect(sent.body.submission).toMatchObject({ status: 'pending' });
      expect(sent.body.submission.flags[0]).toMatchObject({
        label: 'Section 1 (hero)',
        term: 'master copy',
      });
      await O()
        .post(lp(`/${page.id}/withdraw`))
        .expect(200);
      await setSettings({ autoApproveLandingPages: false });
    });

    it('keeps published versions and copies one back into the draft', async () => {
      const versions = await O()
        .get(lp(`/${page.id}/versions`))
        .expect(200);
      expect(versions.body.items).toEqual([
        expect.objectContaining({ version: 2, live: true, autoApproved: true }),
        expect.objectContaining({ version: 1, live: false, autoApproved: false }),
      ]);
      const before = await getPage();
      const restored = await O()
        .post(lp(`/${page.id}/versions/1/restore`))
        .expect(200);
      expect(restored.body.revision).toBe(before.revision + 1);
      expect(JSON.stringify(restored.body.draft)).not.toContain('Edited after sending');
      expect(restored.body.hasUnpublishedChanges).toBe(true);
      await O()
        .post(lp(`/${page.id}/versions/9/restore`))
        .expect(404);
    });

    it('is taken down by Sellora with a reason, and comes back when the takedown is lifted', async () => {
      const down = await P()
        .post(`/v1/platform/landing-pages/${page.id}/takedown`)
        .send({ reason: 'Medical claims are not allowed.' })
        .expect(200);
      expect(down.body.status).toBe('taken_down');
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('unavailable');
      const res = await order(
        orderBody({ customer: { name: 'After', phone: '01788776655' } }),
        'idem-lp-0009',
      ).expect(409);
      expect(res.body.code).toBe('offer_not_available');
      expect(
        (
          await O()
            .delete(lp(`/${page.id}`))
            .expect(409)
        ).body.code,
      ).toBe('page_taken_down');
      expect(
        (await t.outbox(owner.email)).some((m) => m.category === 'landing_page.taken_down'),
      ).toBe(true);
      // Automatic approval never brings back a page Sellora took down.
      await setSettings({ autoApproveLandingPages: true });
      const sent = await O()
        .post(lp(`/${page.id}/submit`))
        .expect(200);
      expect(sent.body).toMatchObject({ status: 'taken_down', submission: { status: 'pending' } });
      await setSettings({ autoApproveLandingPages: false });
      const taken = await P().get('/v1/platform/landing-pages?status=taken_down').expect(200);
      expect(taken.body.items.map((i: { id: string }) => i.id)).toEqual([page.id]);

      await P().post(`/v1/platform/landing-pages/${page.id}/reinstate`).expect(200);
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('live');
      await P().post(`/v1/platform/landing-pages/${page.id}/reinstate`).expect(409);
      await O()
        .post(lp(`/${page.id}/withdraw`))
        .expect(200);
    });
  });

  describe('copies, limits and isolation', () => {
    it('duplicates a page as a new draft and deletes it', async () => {
      const copy = await O()
        .post(lp(`/${page.id}/duplicate`))
        .send({})
        .expect(201);
      expect(copy.body).toMatchObject({
        name: 'Aloe Eid offer 2026 (copy)',
        slug: 'aloe-eid-offer-copy',
        status: 'draft',
        published: null,
      });
      await shop('get', `/${copy.body.slug as string}`).expect(404);
      await O()
        .delete(lp(`/${copy.body.id as string}`))
        .expect(204);
      await O()
        .get(lp(`/${copy.body.id as string}`))
        .expect(404);
    });

    it('holds the plan limit and closes pages when the plan drops landing pages', async () => {
      await setOverrides({ limits: { landingPages: 1 } });
      const res = await O()
        .post(lp())
        .send({ storeId, name: 'One too many', productId: gel.id, template: 'quick_order' })
        .expect(402);
      expect(res.body.code).toBe('plan_limit_reached');
      await setOverrides({ limits: {}, removeModules: ['landing_pages'] });
      await O().get(lp()).expect(402);
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('unavailable');
      await setOverrides({ limits: {}, removeModules: [] });
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('live');
    });

    it('closes pages of a suspended store', async () => {
      await P()
        .post(`/v1/platform/stores/${storeId}/suspend`)
        .send({ reason: 'Checking documents.' })
        .expect(200);
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('unavailable');
      const res = await O()
        .post(lp(`/${page.id}/submit`))
        .expect(409);
      expect(res.body.code).toBe('store_suspended');
      await P().post(`/v1/platform/stores/${storeId}/reinstate`).expect(200);
      expect((await shop('get', `/${page.slug}`).expect(200)).body.state).toBe('live');
    });

    it("never shows one business's page through another's store or account", async () => {
      const other = await t.registerUser({ name: 'Other Owner' });
      const otherOrg = (await t.createOrg(other, { name: 'Gadget Hut', category: 'electronics' }))
        .id;
      const theirStore = (
        await t
          .as(other.token)
          .post(`/v1/orgs/${otherOrg}/stores`)
          .send({ name: 'Gadget Hut', handle: 'gadget-hut' })
          .expect(201)
      ).body as { id: string };
      await t.as(other.token).get(`/v1/orgs/${otherOrg}/landing-pages/${page.id}`).expect(404);
      await t.as(other.token).get(`/v1/orgs/${orgId}/landing-pages/${page.id}`).expect(404);
      // Another store's address does not show this page, even with the same slug.
      await shop('get', `/${page.slug}`, 'gadget-hut.shops.test').expect(404);
      await order(
        orderBody({ customer: { name: 'Xavier', phone: '01755554444' } }),
        'idem-lp-0010',
        'gadget-hut.shops.test',
      ).expect(404);
      // Their page cannot sell this business's product.
      const theirs = await t
        .as(other.token)
        .post(`/v1/orgs/${otherOrg}/landing-pages`)
        .send({ storeId: theirStore.id, name: 'Steal', productId: gel.id, template: 'quick_order' })
        .expect(422);
      expect(theirs.body.errors[0].path).toBe('productId');
      // Nor be made on this business's store.
      const crossStore = await t
        .as(other.token)
        .post(`/v1/orgs/${otherOrg}/landing-pages`)
        .send({ storeId, name: 'Steal', productId: gel.id, template: 'quick_order' })
        .expect(422);
      expect(crossStore.body.errors[0].path).toBe('storeId');
    });

    it('only answers the storefront app', async () => {
      await t
        .http()
        .get(`/v1/storefront/landing-pages/${page.slug}`)
        .set('x-store-host', host)
        .expect(401);
      await t
        .http()
        .get(`/v1/storefront/landing-pages/${page.slug}`)
        .set('x-storefront-key', key)
        .expect(400);
    });
  });
});
