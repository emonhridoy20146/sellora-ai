import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==',
  'base64',
);

interface Section {
  id: string;
  type: string;
  enabled: boolean;
  [k: string]: unknown;
}

interface Content {
  sections: Section[];
  offer: {
    productId: string | null;
    packages: { id: string; label: string; [k: string]: unknown }[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface PageDto {
  id: string;
  slug: string;
  revision: number;
  status: string;
  draft: Content;
}

/** The template library, the new sections and the business's own templates (ADR 0031). */
describe('landing pages: templates and new sections', () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let orgId: string;
  let otherOrgId: string;
  let platform: string;
  let key: string;
  let storeId: string;
  let honey: { id: string; variants: { id: string }[] };
  let ghee: { id: string; variants: { id: string }[] };
  let page: PageDto;
  let picture: string;
  let mine: string;

  const handle = 'khati-bazar';
  const host = `${handle}.shops.test`;
  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const lp = (path = '') => url(`/landing-pages${path}`);
  const shop = (method: 'get' | 'post', path: string) =>
    t
      .http()
      [method](`/v1/storefront/landing-pages${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', '203.0.113.30');

  const create = async (body: Record<string, unknown>) =>
    (
      await O()
        .post(lp())
        .send({ storeId, productId: honey.id, ...body })
        .expect(201)
    ).body as PageDto;
  const save = async (p: PageDto, sections: Section[], offer?: Partial<Content['offer']>) =>
    (
      await O()
        .put(lp(`/${p.id}/draft`))
        .send({
          content: { ...p.draft, sections, offer: { ...p.draft.offer, ...offer } },
          revision: p.revision,
        })
        .expect(200)
    ).body as PageDto;

  const uploadImage = async (): Promise<string> => {
    const started = (
      await O()
        .post(url('/files/uploads'))
        .send({
          purpose: 'store_asset',
          filename: 'bsti.png',
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

  beforeAll(async () => {
    t = await TestApp.create({});
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Khati Bazar', category: 'grocery' })).id;
    other = await t.registerUser({ name: 'Other' });
    otherOrgId = (await t.createOrg(other, { name: 'Other Shop', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Store', 'Product', 'Order', 'StoredFile', 'LandingPage', 'LandingTemplate', 'Coupon'].map(
        (m) => t.db.model(m).init(),
      ),
    );
    storeId = (
      (await O().post(url('/stores')).send({ name: 'Khati Bazar', handle }).expect(201)).body as {
        id: string;
      }
    ).id;
    const product = async (name: string) =>
      (
        await O()
          .post(url('/products'))
          .send({
            name,
            description: 'Pure and fresh.',
            variants: [{ priceMinor: 90_000, stock: 50 }],
          })
          .expect(201)
      ).body as { id: string; variants: { id: string }[] };
    honey = await product('Sundarban Honey');
    ghee = await product('Pabna Ghee');
    await O()
      .patch(url('/shop-settings'))
      .send({
        deliveryZones: [{ id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 }],
        defaultZoneId: 'dhaka',
      })
      .expect(200);
    await t
      .as(platform)
      .patch('/v1/platform/settings')
      .send({ stores: { autoApproveLandingPages: true } })
      .expect(200);
    picture = await uploadImage();
  });
  afterAll(async () => {
    await t.close();
  });

  it('offers 30 templates in nine kinds of business', async () => {
    const res = await O().get(lp('/templates')).expect(200);
    expect(res.body.items).toHaveLength(30);
    expect(res.body.categories.map((c: { key: string }) => c.key)).toEqual([
      'general',
      'health',
      'beauty',
      'fashion',
      'gadgets',
      'food',
      'courses',
      'home',
      'kids',
    ]);
    expect(res.body.items.find((i: { key: string }) => i.key === 'organic_produce')).toMatchObject({
      category: 'food',
      name: 'Pure and organic',
    });
    expect(res.body.mine).toEqual({ items: [], limit: 20 });
    expect(res.body.starterTexts).toContain('Write what this ingredient does.');
  });

  it('starts a page from a library template in Bangla, held back until the instructions are replaced', async () => {
    page = await create({ name: 'Honey offer', template: 'organic_produce', language: 'bn' });
    const types = page.draft.sections.map((s) => s.type);
    expect(types).toEqual([
      'hero',
      'image_text',
      'checklist',
      'comparison',
      'certificates',
      'reviews',
      'order_form',
      'faq',
    ]);
    expect(page.draft.sections.find((s) => s.type === 'certificates')!.enabled).toBe(false);
    expect(JSON.stringify(page.draft)).toContain('খাঁটি');
    const early = await O()
      .post(lp(`/${page.id}/submit`))
      .expect(422);
    expect(early.body.code).toBe('page_not_ready');
    expect(early.body.errors.map((e: { message: string }) => e.message)).toEqual(
      expect.arrayContaining(['Add the picture']),
    );
    // Library templates and saved ones are the only choices; one at a time.
    await O()
      .post(lp())
      .send({ storeId, productId: honey.id, name: 'X', template: 'no_such' })
      .expect(422);
    await O()
      .post(lp())
      .send({
        storeId,
        productId: honey.id,
        name: 'X',
        template: 'flash_sale',
        templateId: 'a'.repeat(24),
      })
      .expect(422);
  });

  it('publishes the new sections: a coupon banner needs a real coupon, orders today are real', async () => {
    page = await create({ name: 'Ghee flash sale', template: 'quick_order' });
    const form = page.draft.sections.find((s) => s.type === 'order_form')!;
    const sections: Section[] = [
      {
        id: 'ann001',
        type: 'announcement',
        enabled: true,
        hideOn: 'none',
        text: 'Eid sale today',
        tone: 'urgent',
      },
      {
        id: 'vh0001',
        type: 'video_hero',
        enabled: true,
        hideOn: 'none',
        heading: 'Pure ghee',
        subheading: 'From Pabna',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        buttonLabel: 'Order',
      },
      {
        id: 'ord001',
        type: 'orders_today',
        enabled: true,
        hideOn: 'none',
        text: '{count} people ordered today',
        minCount: 1,
      },
      {
        id: 'pay001',
        type: 'payment_methods',
        enabled: true,
        hideOn: 'none',
        heading: 'Pay as you like',
        text: '',
      },
      {
        id: 'pkg001',
        type: 'packages',
        enabled: true,
        hideOn: 'none',
        heading: 'Choose',
        text: '',
      },
      {
        id: 'cpn001',
        type: 'coupon_banner',
        enabled: true,
        hideOn: 'none',
        heading: 'Save',
        code: 'ghee 10',
        text: '',
      },
      {
        id: 'cert01',
        type: 'certificates',
        enabled: true,
        hideOn: 'none',
        title: 'Approved',
        items: [{ image: { fileId: picture, url: '', alt: 'BSTI' }, caption: 'BSTI' }],
      },
      {
        id: 'loc001',
        type: 'location',
        enabled: true,
        hideOn: 'none',
        heading: 'Our shop',
        address: 'Shop 4, Kawran Bazar',
        hours: '10 am to 8 pm',
        mapUrl: 'https://maps.app.goo.gl/Kawran1',
      },
      { ...form },
    ];
    const bad = await O()
      .put(lp(`/${page.id}/draft`))
      .send({
        content: {
          ...page.draft,
          sections: [{ ...sections[7]!, mapUrl: 'https://evil.example/map' }, form],
        },
        revision: page.revision,
      })
      .expect(422);
    expect(bad.body.errors[0].path).toBe('body.content.sections.0.mapUrl');

    page = await save(page, sections, {
      productId: ghee.id,
      packages: [
        { id: 'p00001', label: '1 jar', quantity: 1, priceMinor: null, badge: '' },
        { id: 'p00002', label: '2 jars', quantity: 2, priceMinor: 170_000, badge: 'Save 10' },
      ],
    });
    expect(page.draft.sections.find((s) => s.id === 'cpn001')!.code).toBe('GHEE10');
    const noCoupon = await O()
      .post(lp(`/${page.id}/submit`))
      .expect(422);
    expect(noCoupon.body.errors).toEqual([
      {
        path: 'content.sections.5.code',
        message: 'No coupon with this code can be used on this page now',
      },
    ]);
    // A coupon that works only on the online store is not enough either.
    await O()
      .post(url('/coupons'))
      .send({ code: 'GHEE10', kind: 'percent', percent: 10, store: true, landing: 'none' })
      .expect(201);
    await O()
      .post(lp(`/${page.id}/submit`))
      .expect(422);
    const coupons = await O().get(url('/coupons')).expect(200);
    const id = coupons.body.items[0].id as string;
    await O()
      .patch(url(`/coupons/${id}`))
      .send({ landing: 'all' })
      .expect(200);
    const live = await O()
      .post(lp(`/${page.id}/submit`))
      .expect(200);
    expect(live.body.status).toBe('live');

    const view = async () =>
      (await shop('get', `/${page.slug}`).expect(200)).body as Record<string, unknown>;
    const before = await view();
    const types = (before.sections as Section[]).map((s) => s.type);
    // No order yet, so "orders today" is not shown.
    expect(types).not.toContain('orders_today');
    expect(types).toContain('certificates');
    expect((before.sections as Section[]).find((s) => s.type === 'video_hero')!.embed).toEqual({
      provider: 'youtube',
      id: 'dQw4w9WgXcQ',
    });
    expect(before.payments).toBeDefined();
    expect(before.packages).toHaveLength(2);

    await shop('post', `/${page.slug}/orders`)
      .set('idempotency-key', 'idem-lib-000001')
      .send({
        packageId: 'p00002',
        variantId: ghee.variants[0]!.id,
        customer: { name: 'Rafiq Ahmed', phone: '01712000111' },
        address: { line1: 'House 2, Road 3', city: 'Dhaka' },
        zoneId: 'dhaka',
        couponCode: 'ghee10',
      })
      .expect(201);
    const after = await view();
    const today = (after.sections as Section[]).find((s) => s.type === 'orders_today');
    expect(today).toMatchObject({ count: 1, text: '{count} people ordered today' });
  });

  it("saves a page as the business's own template and starts another product's page from it", async () => {
    const saved = await O()
      .post(lp(`/${page.id}/save-template`))
      .send({ name: 'Flash sale with banner', description: 'Our Eid layout' })
      .expect(201);
    mine = saved.body.id;
    expect(saved.body).toMatchObject({
      name: 'Flash sale with banner',
      sections: 9,
      packages: 2,
      pictures: 1,
    });
    expect(saved.body.cover).toBeNull();
    const list = await O().get(lp('/templates')).expect(200);
    expect(list.body.mine.items.map((i: { id: string }) => i.id)).toEqual([mine]);

    const copy = await create({ name: 'Honey from my template', templateId: mine });
    expect(copy.draft.offer.productId).toBe(honey.id);
    expect(copy.draft.offer.packages.map((p) => p.label)).toEqual(['1 jar', '2 jars']);
    expect(copy.draft.sections.map((s) => s.type)).toEqual(page.draft.sections.map((s) => s.type));
    const cert = copy.draft.sections.find((s) => s.type === 'certificates') as unknown as {
      items: { image: { url: string } }[];
    };
    expect(cert.items[0]!.image.url).toMatch(/^http/);

    // The picture stays while the template or a page uses it.
    await O()
      .delete(lp(`/${mine}`))
      .expect(404);
    await O()
      .delete(lp(`/templates/${mine}`))
      .expect(204);
    await O()
      .delete(lp(`/templates/${mine}`))
      .expect(404);
    expect(
      (
        await O()
          .get(url(`/files/${picture}`))
          .expect(200)
      ).body.inUse,
    ).toBe(true);
    await O()
      .delete(lp(`/${copy.id}`))
      .expect(204);
    expect(
      (
        await O()
          .get(url(`/files/${picture}`))
          .expect(200)
      ).body.inUse,
    ).toBe(true);
  });

  it('keeps own templates to the business, and at most 20', async () => {
    const saved = await O()
      .post(lp(`/${page.id}/save-template`))
      .send({ name: 'Keep me' })
      .expect(201);
    const as = t.as(other.token);
    await as.delete(`/v1/orgs/${otherOrgId}/landing-pages/templates/${saved.body.id}`).expect(404);
    expect(
      (await as.get(`/v1/orgs/${otherOrgId}/landing-pages/templates`).expect(200)).body.mine.items,
    ).toEqual([]);
    const otherStore = (
      (
        await as
          .post(`/v1/orgs/${otherOrgId}/stores`)
          .send({ name: 'Other', handle: 'other-shop-x' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const otherProduct = (
      await as
        .post(`/v1/orgs/${otherOrgId}/products`)
        .send({ name: 'Shirt', variants: [{ priceMinor: 50_000, stock: 5 }] })
        .expect(201)
    ).body as { id: string };
    const stolen = await as
      .post(`/v1/orgs/${otherOrgId}/landing-pages`)
      .send({
        storeId: otherStore,
        productId: otherProduct.id,
        name: 'Copy',
        templateId: saved.body.id,
      })
      .expect(422);
    expect(stolen.body.errors[0]).toMatchObject({
      path: 'templateId',
      message: 'This template no longer exists',
    });

    for (let i = 2; i <= 20; i++)
      await O()
        .post(lp(`/${page.id}/save-template`))
        .send({ name: `Layout ${i}` })
        .expect(201);
    const full = await O()
      .post(lp(`/${page.id}/save-template`))
      .send({ name: 'One too many' })
      .expect(409);
    expect(full.body.code).toBe('template_limit');
  });
});
