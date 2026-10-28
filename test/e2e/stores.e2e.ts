import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface StoreDto {
  id: string;
  name: string;
  handle: string;
  host: string;
  url: string;
  status: string;
  themeKey: string;
  theme: {
    palette: { primary: string; accent: string };
    logo: { fileId: string; url: string } | null;
    sections: { id: string; type: string; enabled: boolean; [k: string]: unknown }[];
    [k: string]: unknown;
  };
  contact: { phone: string; whatsapp: string };
  pages: Record<string, string>;
  review: { submittedAt: string | null; reason: string | null; autoApproved: boolean };
  handleLocked: boolean;
  liveSince: string | null;
  readiness?: { activeProducts: number; hasContact: boolean; ready: boolean };
}

interface ProductDto {
  id: string;
  slug: string;
  variants: { id: string; stock: number; priceMinor: number }[];
}

describe('online stores', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let platform: string;
  let key: string;

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const P = () => t.as(platform);

  /** A shop request as the storefront app makes it. */
  const shop = (method: 'get' | 'post', path: string, host: string, preview?: string) => {
    const req = t
      .http()
      [method](`/v1/storefront${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', '203.0.113.7');
    return preview ? req.set('x-store-preview', preview) : req;
  };

  const createStore = async (body: Record<string, unknown>, session = owner, org = orgId) =>
    (await t.as(session.token).post(`/v1/orgs/${org}/stores`).send(body).expect(201))
      .body as StoreDto;

  const createProduct = async (body: Record<string, unknown>, session = owner, org = orgId) =>
    (await t.as(session.token).post(`/v1/orgs/${org}/products`).send(body).expect(201))
      .body as ProductDto;

  const setPlatformSettings = (stores: Record<string, unknown>) =>
    P().patch('/v1/platform/settings').send({ stores }).expect(200);

  const setOverrides = (body: Record<string, unknown>, org = orgId) =>
    P()
      .put(`/v1/platform/billing/tenants/${org}/subscription/overrides`)
      .send({ note: 'store test', ...body })
      .expect(200);

  /** Puts a draft (or rejected) store live through the review queue. */
  const openStore = async (storeId: string) => {
    await O()
      .post(url(`/stores/${storeId}/submit`))
      .expect(200);
    await P().post(`/v1/platform/stores/${storeId}/approve`).send({}).expect(200);
  };

  const uploadStoreImage = async (): Promise<string> => {
    const started = (
      await O()
        .post(url('/files/uploads'))
        .send({
          purpose: 'store_asset',
          filename: 'logo.png',
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
    t = await TestApp.create({ API_PUBLIC_URL: 'http://api.test' });
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Dhaka Fashion House', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      ['Store', 'Product', 'Customer', 'Order', 'StoredFile'].map((m) => t.db.model(m).init()),
    );
  });
  afterAll(async () => {
    await t.close();
  });

  describe('setting up a store', () => {
    it('lists themes with the ones that suit the business first', async () => {
      const res = await O().get(url('/stores/themes')).expect(200);
      expect(res.body.items).toHaveLength(6);
      expect(res.body.suggested).toHaveLength(3);
      expect(res.body.suggested[0]).toBe('nakshi');
    });

    it('creates a draft with a starter design, an address from the name and starter pages', async () => {
      const store = await createStore({ name: 'Dhaka Fashion House' });
      expect(store).toMatchObject({
        name: 'Dhaka Fashion House',
        handle: 'dhaka-fashion-house',
        host: 'dhaka-fashion-house.shops.test',
        url: 'https://dhaka-fashion-house.shops.test',
        status: 'draft',
        themeKey: 'nakshi',
        handleLocked: false,
        readiness: { activeProducts: 0, hasContact: false, ready: false },
      });
      expect(store.theme.sections.map((s) => s.type)).toEqual([
        'hero',
        'categories',
        'products',
        'features',
        'products',
      ]);
      expect(store.pages.shipping).toContain('Bangladesh');
      expect(store.pages.about).toBe('');

      // The same name again gets a different address.
      const second = await createStore({ name: 'Dhaka Fashion House', language: 'bn' });
      expect(second.handle).toMatch(/^dhaka-fashion-house-\d{3}$/);
      expect(second.theme.sections[0]!.heading).toContain('স্বাগতম');
      await O()
        .delete(url(`/stores/${second.id}`))
        .expect(204);
    });

    it('checks addresses: format, reserved words, taken by another store', async () => {
      const check = async (handle: string, storeId?: string) =>
        (
          await O()
            .get(
              url(`/stores/handle-check?handle=${handle}${storeId ? `&storeId=${storeId}` : ''}`),
            )
            .expect(200)
        ).body as { available: boolean; problem: string | null };
      expect(await check('ab')).toMatchObject({ available: false, problem: 'format' });
      expect(await check('my--shop')).toMatchObject({ available: false, problem: 'format' });
      expect(await check('-shop')).toMatchObject({ available: false, problem: 'format' });
      expect(await check('admin')).toMatchObject({ available: false, problem: 'reserved' });
      expect(await check('checkout')).toMatchObject({ available: false, problem: 'reserved' });
      expect(await check('Dhaka-Fashion-House')).toMatchObject({
        available: false,
        problem: 'taken',
      });
      const { items } = (await O().get(url('/stores')).expect(200)).body as { items: StoreDto[] };
      expect(await check('dhaka-fashion-house', items[0]!.id)).toMatchObject({ available: true });
      expect(await check('nakshi-ghor')).toMatchObject({ available: true, problem: null });

      const taken = await O()
        .post(url('/stores'))
        .send({ name: 'Copy', handle: 'dhaka-fashion-house' })
        .expect(409);
      expect(taken.body.code).toBe('handle_taken');
      await O().post(url('/stores')).send({ name: 'Bad', handle: 'www' }).expect(422);
    });

    it('will not send a store for review without products and a contact number', async () => {
      const store = await createStore({ name: 'Empty Shop', handle: 'empty-shop' });
      const res = await O()
        .post(url(`/stores/${store.id}/submit`))
        .expect(422);
      expect(res.body.code).toBe('store_not_ready');
      expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual([
        'products',
        'contact.phone',
      ]);
      await O()
        .delete(url(`/stores/${store.id}`))
        .expect(204);
    });

    it('validates the design: theme, categories of product sections, image files', async () => {
      const store = await createStore({ name: 'Design Shop', handle: 'design-shop' });
      const theme = store.theme;
      const products = theme.sections.findIndex((s) => s.type === 'products');
      const withCategory = (categoryId: string | null) => ({
        ...theme,
        sections: theme.sections.map((s, i) =>
          i === products ? { ...s, source: 'category', categoryId } : s,
        ),
      });
      const missing = await O()
        .put(url(`/stores/${store.id}/theme`))
        .send({ themeKey: 'volt', theme: withCategory(null) })
        .expect(422);
      expect(missing.body.errors[0].path).toBe(`theme.sections.${products}.categoryId`);
      const unknown = await O()
        .put(url(`/stores/${store.id}/theme`))
        .send({ themeKey: 'volt', theme: withCategory('0123456789abcdef01234567') })
        .expect(422);
      expect(unknown.body.errors[0].message).toMatch(/no longer exists/);
      await O()
        .put(url(`/stores/${store.id}/theme`))
        .send({
          themeKey: 'volt',
          theme: { ...theme, palette: { primary: 'red', accent: '#000000' } },
        })
        .expect(422);
      await O()
        .put(url(`/stores/${store.id}/theme`))
        .send({ themeKey: 'nope', theme })
        .expect(422);
      const notUploaded = await O()
        .put(url(`/stores/${store.id}/theme`))
        .send({
          themeKey: 'volt',
          theme: { ...theme, logo: { fileId: '0123456789abcdef01234567', url: '' } },
        })
        .expect(422);
      expect(notUploaded.body.errors[0].path).toBe('theme.logo.fileId');
      await O()
        .delete(url(`/stores/${store.id}`))
        .expect(204);
    });

    it('saves the design with uploaded images and removes images it no longer uses', async () => {
      const store = await createStore({ name: 'Image Shop', handle: 'image-shop' });
      const logo = await uploadStoreImage();
      const hero = await uploadStoreImage();
      const sections = store.theme.sections.map((s) =>
        s.type === 'hero' ? { ...s, image: { fileId: hero, url: 'ignored' } } : s,
      );
      const saved = (
        await O()
          .put(url(`/stores/${store.id}/theme`))
          .send({
            themeKey: 'glow',
            theme: {
              ...store.theme,
              palette: { primary: '#AA3366', accent: '#222222' },
              logo: { fileId: logo, url: 'http://evil.example/x.png' },
              announcement: 'Free delivery in Dhaka this week',
              sections,
            },
          })
          .expect(200)
      ).body as StoreDto;
      expect(saved.themeKey).toBe('glow');
      expect(saved.theme.palette.primary).toBe('#aa3366');
      // The address comes from storage, never from the request.
      expect(saved.theme.logo!.url).toBe(`http://api.test/v1/storage/o/${orgId}/store/${logo}.png`);
      const heroSection = saved.theme.sections.find((s) => s.type === 'hero') as unknown as {
        image: { url: string };
      };
      expect(heroSection.image.url).toContain(`/store/${hero}.png`);
      expect(
        (
          (
            await O()
              .get(url(`/files/${logo}`))
              .expect(200)
          ).body as { inUse: boolean }
        ).inUse,
      ).toBe(true);

      // Dropping the logo releases and removes it; the hero image stays.
      await O()
        .put(url(`/stores/${store.id}/theme`))
        .send({ themeKey: 'glow', theme: { ...saved.theme, logo: null } })
        .expect(200);
      await O()
        .get(url(`/files/${logo}`))
        .expect(404);
      await O()
        .get(url(`/files/${hero}`))
        .expect(200);

      // Deleting the store removes its images too.
      await O()
        .delete(url(`/stores/${store.id}`))
        .expect(204);
      await O()
        .get(url(`/files/${hero}`))
        .expect(404);
    });

    it('keeps staff without store permissions out', async () => {
      const agent = await t.addMember(owner, orgId, 'sales_agent');
      await t.as(agent.token).get(url('/stores')).expect(403);
      const viewer = await t.addMember(owner, orgId, 'viewer');
      await t.as(viewer.token).get(url('/stores')).expect(200);
      await t.as(viewer.token).post(url('/stores')).send({ name: 'Nope' }).expect(403);
    });
  });

  describe('review by the super-admin', () => {
    let store: StoreDto;

    beforeAll(async () => {
      const { items } = (await O().get(url('/stores')).expect(200)).body as { items: StoreDto[] };
      store = items.find((s) => s.handle === 'dhaka-fashion-house')!;
      await createProduct({
        name: 'Cotton Panjabi',
        variants: [{ priceMinor: 120_000, stock: 10 }],
      });
      await O()
        .patch(url(`/stores/${store.id}`))
        .send({ contact: { phone: '01712345678' }, pages: { about: 'Handmade in Dhaka.' } })
        .expect(200);
    });

    it('sends a ready store for review, lets the business take it back, and queues it', async () => {
      const sent = (
        await O()
          .post(url(`/stores/${store.id}/submit`))
          .expect(200)
      ).body as StoreDto;
      expect(sent.status).toBe('pending');
      expect(sent.review.submittedAt).not.toBeNull();
      await O()
        .post(url(`/stores/${store.id}/submit`))
        .expect(409);

      expect(
        (
          await O()
            .post(url(`/stores/${store.id}/withdraw`))
            .expect(200)
        ).body.status,
      ).toBe('draft');
      await O()
        .post(url(`/stores/${store.id}/submit`))
        .expect(200);

      const queue = await P().get('/v1/platform/stores?status=pending').expect(200);
      expect(queue.body.pending).toBeGreaterThanOrEqual(1);
      const row = queue.body.items.find((s: { id: string }) => s.id === store.id);
      expect(row).toMatchObject({
        handle: 'dhaka-fashion-house',
        status: 'pending',
        org: { id: orgId, name: 'Dhaka Fashion House' },
        flagCount: 0,
      });

      const detail = await P().get(`/v1/platform/stores/${store.id}`).expect(200);
      expect(detail.body.flags).toEqual([]);
      expect(detail.body.readiness).toMatchObject({ activeProducts: 1, ready: true });
      expect(detail.body.preview.url).toMatch(
        /^https:\/\/dhaka-fashion-house\.shops\.test\/__preview\?token=/,
      );
    });

    it('rejects with a reason the owner is emailed, then approves after a fix', async () => {
      await P().post(`/v1/platform/stores/${store.id}/reject`).send({ reason: 'no' }).expect(422);
      const rejected = await P()
        .post(`/v1/platform/stores/${store.id}/reject`)
        .send({ reason: 'Add your return policy before opening.' })
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'rejected',
        review: { reason: 'Add your return policy before opening.' },
      });
      const mail = (await t.outbox(owner.email)).find((m) => m.category === 'store.rejected');
      expect(mail?.text).toContain('Add your return policy before opening.');
      expect(mail?.text).toContain(`/app/${orgId}/store/${store.id}`);
      await P().post(`/v1/platform/stores/${store.id}/approve`).send({}).expect(409);

      // The handle can still change before the store first opens.
      await O()
        .patch(url(`/stores/${store.id}`))
        .send({ handle: 'dhaka-fashion' })
        .expect(200);
      await O()
        .patch(url(`/stores/${store.id}`))
        .send({ handle: 'dhaka-fashion-house' })
        .expect(200);

      await openStore(store.id);
      const live = (
        await O()
          .get(url(`/stores/${store.id}`))
          .expect(200)
      ).body as StoreDto;
      expect(live).toMatchObject({ status: 'live', handleLocked: true, review: { reason: null } });
      expect(live.liveSince).not.toBeNull();
      const approved = (await t.outbox(owner.email)).find((m) => m.category === 'store.approved');
      expect(approved?.text).toContain('https://dhaka-fashion-house.shops.test');

      const locked = await O()
        .patch(url(`/stores/${store.id}`))
        .send({ handle: 'another-name' })
        .expect(409);
      expect(locked.body.code).toBe('handle_locked');
      // Saving the same handle is not a change.
      await O()
        .patch(url(`/stores/${store.id}`))
        .send({ handle: 'dhaka-fashion-house', name: 'Dhaka Fashion House' })
        .expect(200);
    });

    it('lets the business pause and reopen, and the platform suspend and reinstate', async () => {
      expect(
        (
          await O()
            .post(url(`/stores/${store.id}/pause`))
            .expect(200)
        ).body.status,
      ).toBe('paused');
      expect(
        (await shop('get', '/resolve', 'dhaka-fashion-house.shops.test').expect(200)).body.state,
      ).toBe('paused');
      expect(
        (
          await O()
            .post(url(`/stores/${store.id}/resume`))
            .expect(200)
        ).body.status,
      ).toBe('live');

      await P()
        .post(`/v1/platform/stores/${store.id}/suspend`)
        .send({ reason: 'Report: fake goods' })
        .expect(200);
      const closed = await shop('get', '/resolve', 'dhaka-fashion-house.shops.test').expect(200);
      expect(closed.body).toMatchObject({ state: 'unavailable', theme: null });
      expect(closed.body.contact).toBeUndefined();
      await shop('get', '/home', 'dhaka-fashion-house.shops.test').expect(404);
      const del = await O()
        .delete(url(`/stores/${store.id}`))
        .expect(409);
      expect(del.body.code).toBe('store_suspended');
      await O()
        .post(url(`/stores/${store.id}/resume`))
        .expect(409);
      expect((await t.outbox(owner.email)).some((m) => m.category === 'store.suspended')).toBe(
        true,
      );

      const back = await P().post(`/v1/platform/stores/${store.id}/reinstate`).expect(200);
      expect(back.body.status).toBe('live');
      expect(
        (await shop('get', '/resolve', 'dhaka-fashion-house.shops.test').expect(200)).body.state,
      ).toBe('open');
    });

    it('keeps merchants out of the review routes and staff out of other businesses', async () => {
      await O().get('/v1/platform/stores').expect(401);
      const other = await t.registerUser({ name: 'Other' });
      const otherOrg = (await t.createOrg(other, { name: 'Other Shop' })).id;
      await t.as(other.token).get(`/v1/orgs/${otherOrg}/stores/${store.id}`).expect(404);
      await t
        .as(other.token)
        .get(url(`/stores/${store.id}`))
        .expect(404);
    });

    it('flags risky words for the reviewer and never auto-approves a flagged store', async () => {
      await setPlatformSettings({ autoApprove: true });
      try {
        const flagged = await createStore({ name: 'Night Market', handle: 'night-market' });
        const product = await createProduct({
          name: 'Master copy watch',
          description: 'Rolex replica',
          variants: [{ priceMinor: 300_000, stock: 2 }],
        });
        await O()
          .patch(url(`/stores/${flagged.id}`))
          .send({ contact: { whatsapp: '01812345678' } })
          .expect(200);
        const sent = (
          await O()
            .post(url(`/stores/${flagged.id}/submit`))
            .expect(200)
        ).body as StoreDto;
        expect(sent.status).toBe('pending');
        const detail = await P().get(`/v1/platform/stores/${flagged.id}`).expect(200);
        expect(detail.body.flags).toContainEqual(
          expect.objectContaining({
            where: `product:${product.id}`,
            label: 'Product: Master copy watch',
          }),
        );
        expect(detail.body.flags[0].reason).toMatch(/^Copies of brands/);

        // Without flags, automatic approval opens the store straight away.
        await O()
          .patch(url(`/products/${product.id}`))
          .send({ status: 'archived' })
          .expect(200);
        const recheck = await P().post(`/v1/platform/stores/${flagged.id}/recheck`).expect(200);
        expect(recheck.body.flags).toEqual([]);
        await O()
          .post(url(`/stores/${flagged.id}/withdraw`))
          .expect(200);
        const auto = (
          await O()
            .post(url(`/stores/${flagged.id}/submit`))
            .expect(200)
        ).body as StoreDto;
        expect(auto).toMatchObject({ status: 'live', review: { autoApproved: true } });
        await O()
          .delete(url(`/stores/${flagged.id}`))
          .expect(204);
      } finally {
        await setPlatformSettings({ autoApprove: false });
      }
    });
  });

  describe('shopping', () => {
    const host = 'dhaka-fashion-house.shops.test';
    let panjabi: ProductDto;
    let saree: ProductDto;
    let storeId: string;

    beforeAll(async () => {
      const { items } = (await O().get(url('/stores')).expect(200)).body as { items: StoreDto[] };
      storeId = items.find((s) => s.handle === 'dhaka-fashion-house')!.id;
      const category = (await O().post(url('/categories')).send({ name: 'Sarees' }).expect(201))
        .body as { id: string; slug: string };
      panjabi = (
        (await O().get(url('/products?q=panjabi')).expect(200)).body as { items: ProductDto[] }
      ).items[0]!;
      saree = await createProduct({
        name: 'Silk Saree',
        categoryId: category.id,
        options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
        variants: [
          { optionValues: ['Red'], priceMinor: 300_000, stock: 2 },
          { optionValues: ['Blue'], priceMinor: 320_000, stock: 0 },
        ],
      });
      await createProduct({
        name: 'Old Kurti',
        status: 'archived',
        variants: [{ priceMinor: 50_000, stock: 5 }],
      });
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

    it('only answers the storefront app', async () => {
      await t.http().get('/v1/storefront/resolve').set('x-store-host', host).expect(401);
      await t
        .http()
        .get('/v1/storefront/resolve')
        .set('x-storefront-key', 'x'.repeat(48))
        .set('x-store-host', host)
        .expect(401);
      await t.http().get('/v1/storefront/resolve').set('x-storefront-key', key).expect(400);
      await shop('get', '/resolve', 'nobody.shops.test').expect(404);
      await shop('get', '/resolve', 'shops.test').expect(404);
      await shop('get', '/resolve', 'a.b.shops.test').expect(404);
      await shop('get', '/resolve', 'www.example.com').expect(404);
    });

    it('shows an open store: brand, home sections, categories and products', async () => {
      const store = await shop('get', '/resolve', host.toUpperCase()).expect(200);
      expect(store.body).toMatchObject({
        name: 'Dhaka Fashion House',
        state: 'open',
        currency: 'BDT',
        contact: { phone: '01712345678' },
        pages: ['about', 'shipping', 'returns'],
      });

      const home = await shop('get', '/home', host).expect(200);
      const newest = store.body.theme.sections.find(
        (s: { type: string; source?: string }) => s.type === 'products' && s.source === 'newest',
      );
      const cards = home.body.sections[newest.id] as { name: string; inStock: boolean }[];
      expect(cards.map((c) => c.name)).toEqual(['Silk Saree', 'Cotton Panjabi']);
      expect(home.body.categories).toEqual([
        expect.objectContaining({ name: 'Sarees', productCount: 1 }),
      ]);

      const list = await shop('get', '/products?sort=price_desc&limit=1', host).expect(200);
      expect(list.body).toMatchObject({ total: 2, page: 1, pageCount: 2 });
      expect(list.body.items[0]).toMatchObject({
        name: 'Silk Saree',
        priceMinor: 300_000,
        priceVaries: true,
        inStock: true,
      });
      const bySaree = await shop('get', '/products?category=sarees', host).expect(200);
      expect(bySaree.body.items.map((p: { name: string }) => p.name)).toEqual(['Silk Saree']);
      const search = await shop('get', '/products?q=PANJ', host).expect(200);
      expect(search.body.items.map((p: { name: string }) => p.name)).toEqual(['Cotton Panjabi']);

      const detail = await shop('get', `/products/${saree.slug}`, host).expect(200);
      expect(detail.body.product.variants).toEqual([
        expect.objectContaining({ title: 'Red', available: true, left: 2 }),
        expect.objectContaining({ title: 'Blue', available: false, left: null }),
      ]);
      expect(detail.body.product.variants[0].costMinor).toBeUndefined();
      expect(detail.body.product.category).toEqual({ name: 'Sarees', slug: 'sarees' });
      await shop('get', '/products/old-kurti', host).expect(404);

      expect((await shop('get', '/pages/about', host).expect(200)).body.text).toBe(
        'Handmade in Dhaka.',
      );
      await shop('get', '/pages/privacy', host).expect(404);
      const sitemap = await shop('get', '/sitemap', host).expect(200);
      expect(sitemap.body.products.map((p: { slug: string }) => p.slug).sort()).toEqual(
        ['cotton-panjabi', 'silk-saree'].sort(),
      );
    });

    it('prices a cart and says what cannot be bought', async () => {
      const quote = await shop('post', '/cart', host)
        .send({
          items: [
            { productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 2 },
            { productId: saree.id, variantId: saree.variants[1]!.id, quantity: 1 },
            { productId: saree.id, variantId: saree.variants[0]!.id, quantity: 5 },
          ],
        })
        .expect(200);
      expect(quote.body.lines.map((l: { problem: string | null }) => l.problem)).toEqual([
        null,
        'out_of_stock',
        'not_enough_stock',
      ]);
      expect(quote.body).toMatchObject({
        subtotalMinor: 240_000,
        zoneId: 'dhaka',
        deliveryChargeMinor: 6_000,
        totalMinor: 246_000,
        canCheckout: false,
      });
      const outside = await shop('post', '/cart', host)
        .send({
          items: [{ productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 1 }],
          zoneId: 'outside',
        })
        .expect(200);
      expect(outside.body).toMatchObject({ deliveryChargeMinor: 12_000, canCheckout: true });
    });

    describe('checkout', () => {
      const body = (extra: Record<string, unknown> = {}) => ({
        items: [{ productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 2 }],
        customer: { name: 'Rahima Akter', phone: '01911223344' },
        address: { line1: 'House 7, Road 2', area: 'Mirpur 10', city: 'Dhaka' },
        zoneId: 'dhaka',
        note: 'Call before coming',
        ...extra,
      });
      const checkout = (payload: Record<string, unknown>, idem?: string) => {
        const req = shop('post', '/checkout', host);
        return (idem ? req.set('idempotency-key', idem) : req).send(payload);
      };
      let receipt: string;
      let number: string;

      it('places a pending cash-on-delivery order once, however often it is retried', async () => {
        await checkout(body()).expect(400);
        const first = await checkout(body(), 'idem-key-0001').expect(201);
        expect(first.body).toMatchObject({ totalMinor: 246_000, currency: 'BDT' });
        number = first.body.orderNumber;
        receipt = first.body.receipt;
        const again = await checkout(body(), 'idem-key-0001').expect(201);
        expect(again.body.orderNumber).toBe(number);
        const reused = await checkout(body({ note: 'different' }), 'idem-key-0001').expect(422);
        expect(reused.body.code).toBe('idempotency_key_reused');

        const orders = await O()
          .get(url(`/orders?q=${number}`))
          .expect(200);
        expect(orders.body.items).toHaveLength(1);
        expect(orders.body.items[0]).toMatchObject({
          number,
          status: 'pending',
          source: 'store',
          storeId,
          customer: { name: 'Rahima Akter', phone: '+8801911223344' },
          deliveryZone: { id: 'dhaka', name: 'Inside Dhaka' },
          payment: { method: 'cod', status: 'unpaid' },
          stockCommitted: false,
        });
        // Pending store orders do not take stock until the business confirms them.
        expect(
          (
            await O()
              .get(url(`/products/${panjabi.id}`))
              .expect(200)
          ).body.variants[0].stock,
        ).toBe(10);
        const customers = await O().get(url('/customers?q=Rahima')).expect(200);
        expect(customers.body.items[0].source).toBe('store');
      });

      it('shows the receipt only with its signed link', async () => {
        const res = await shop(
          'get',
          `/orders/receipt?receipt=${encodeURIComponent(receipt)}`,
          host,
        ).expect(200);
        expect(res.body).toMatchObject({
          number,
          status: 'pending',
          totalMinor: 246_000,
          customer: { name: 'Rahima Akter', phone: '**********3344' },
          deliveryZone: 'Inside Dhaka',
        });
        const tampered = `${receipt.slice(0, -2)}${receipt.endsWith('A') ? 'B' : 'A'}A`;
        await shop('get', `/orders/receipt?receipt=${encodeURIComponent(tampered)}`, host).expect(
          404,
        );
      });

      it('tracks an order by number and phone, in any phone format', async () => {
        const res = await shop('post', '/orders/track', host)
          .send({ number: number.toLowerCase(), phone: '+880 1911-223344' })
          .expect(200);
        expect(res.body).toMatchObject({ number, status: 'pending', itemCount: 2, shipment: null });
        await shop('post', '/orders/track', host)
          .send({ number, phone: '01911223345' })
          .expect(404);
        await shop('post', '/orders/track', host).send({ number, phone: 'nonsense' }).expect(404);
      });

      it('refuses changed carts, missing areas, small orders and bots', async () => {
        const changed = await checkout(
          body({ items: [{ productId: saree.id, variantId: saree.variants[1]!.id, quantity: 1 }] }),
          'idem-key-0002',
        ).expect(409);
        expect(changed.body).toMatchObject({ code: 'cart_changed' });
        expect(changed.body.errors[0]).toMatchObject({ path: 'items.0', code: 'out_of_stock' });

        const noZone = await checkout(body({ zoneId: null }), 'idem-key-0003').expect(422);
        expect(noZone.body.errors[0].path).toBe('zoneId');

        await O()
          .patch(url(`/stores/${storeId}`))
          .send({ checkout: { minOrderMinor: 1_000_000 } })
          .expect(200);
        expect((await checkout(body(), 'idem-key-0004').expect(422)).body.code).toBe(
          'below_minimum',
        );
        await O()
          .patch(url(`/stores/${storeId}`))
          .send({ checkout: { minOrderMinor: 0 } })
          .expect(200);

        const bot = await checkout(
          body({ website: 'http://spam.example' }),
          'idem-key-0005',
        ).expect(422);
        expect(bot.body.code).toBe('order_not_accepted');
      });

      it('gives a blocked customer the same answer as anyone the shop cannot serve', async () => {
        const customers = await O().get(url('/customers?q=Rahima')).expect(200);
        await O()
          .patch(url(`/customers/${customers.body.items[0].id}`))
          .send({ blocked: true })
          .expect(200);
        const res = await checkout(body(), 'idem-key-0006').expect(422);
        expect(res.body.code).toBe('order_not_accepted');
        expect(JSON.stringify(res.body)).not.toMatch(/block/i);
      });

      it('limits orders per phone number', async () => {
        const phone = '01555000111';
        for (let i = 0; i < 5; i++)
          await checkout(
            body({ customer: { name: 'Repeat Buyer', phone } }),
            `idem-rate-${i}0000`,
          ).expect(201);
        await checkout(
          body({ customer: { name: 'Repeat Buyer', phone } }),
          'idem-rate-50000',
        ).expect(429);
      });
    });

    it('shows a store before it opens only with a preview link, and never takes orders there', async () => {
      const draft = await createStore({ name: 'Coming Soon', handle: 'coming-soon' });
      const host2 = 'coming-soon.shops.test';
      const closed = await shop('get', '/resolve', host2).expect(200);
      expect(closed.body.state).toBe('coming_soon');
      expect(closed.body.theme.sections).toEqual([]);
      await shop('get', '/products', host2).expect(404);

      const link = await O()
        .post(url(`/stores/${draft.id}/preview-link`))
        .expect(200);
      const token = new URL(link.body.url).searchParams.get('token')!;
      expect((await shop('get', '/resolve', host2, token).expect(200)).body.state).toBe('preview');
      await shop('get', '/products', host2, token).expect(200);
      // A preview token is for one store only.
      expect((await shop('get', '/resolve', host, token).expect(200)).body.state).toBe('open');
      const otherLink = await O()
        .post(url(`/stores/${storeId}/preview-link`))
        .expect(200);
      const otherToken = new URL(otherLink.body.url).searchParams.get('token')!;
      expect((await shop('get', '/resolve', host2, otherToken).expect(200)).body.state).toBe(
        'coming_soon',
      );
      await shop('post', '/checkout', host2, token)
        .set('idempotency-key', 'idem-preview-01')
        .send({
          items: [{ productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 1 }],
          customer: { name: 'Reviewer', phone: '01700000000' },
          address: { line1: 'Somewhere 1' },
          zoneId: 'dhaka',
        })
        .expect(404);
      await O()
        .delete(url(`/stores/${draft.id}`))
        .expect(204);
    });

    it("never shows one business's catalog or orders through another's store", async () => {
      const other = await t.registerUser({ name: 'Other Owner' });
      const otherOrg = (
        await t.createOrg(other, { name: 'Chittagong Gadgets', category: 'electronics' })
      ).id;
      const theirs = await createProduct(
        { name: 'Secret Phone', variants: [{ priceMinor: 900_000, stock: 3 }] },
        other,
        otherOrg,
      );
      const otherStore = await createStore(
        { name: 'Ctg Gadgets', handle: 'ctg-gadgets' },
        other,
        otherOrg,
      );
      expect(otherStore.themeKey).toBe('volt');
      await t
        .as(other.token)
        .patch(`/v1/orgs/${otherOrg}/stores/${otherStore.id}`)
        .send({ contact: { phone: '01600000000' } })
        .expect(200);
      await t
        .as(other.token)
        .post(`/v1/orgs/${otherOrg}/stores/${otherStore.id}/submit`)
        .expect(200);
      await P().post(`/v1/platform/stores/${otherStore.id}/approve`).send({}).expect(200);

      await shop('get', `/products/${theirs.slug}`, host).expect(404);
      const quote = await shop('post', '/cart', host)
        .send({ items: [{ productId: theirs.id, variantId: theirs.variants[0]!.id, quantity: 1 }] })
        .expect(200);
      expect(quote.body.lines[0].problem).toBe('unavailable');
      const order = await checkout2(host, theirs);
      expect(order.status).toBe(409);

      // A receipt link from one store does not open in another.
      const placed = await checkout2('ctg-gadgets.shops.test', theirs);
      expect(placed.status).toBe(201);
      await shop(
        'get',
        `/orders/receipt?receipt=${encodeURIComponent(placed.body.receipt)}`,
        host,
      ).expect(404);
      await shop(
        'get',
        `/orders/receipt?receipt=${encodeURIComponent(placed.body.receipt)}`,
        'ctg-gadgets.shops.test',
      ).expect(200);
      await shop('post', '/orders/track', host)
        .send({ number: placed.body.orderNumber, phone: '01733333333' })
        .expect(404);
    });

    const checkout2 = (h: string, product: ProductDto) =>
      shop('post', '/checkout', h)
        .set('idempotency-key', `idem-x-${h.length}-${Date.now()}`)
        .send({
          items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1 }],
          customer: { name: 'Karim', phone: '01733333333' },
          address: { line1: 'Agrabad 4' },
          zoneId: null,
        });

    it('answers the TLS check only for store addresses', async () => {
      await t
        .http()
        .get('/v1/public/store-domains/check?domain=dhaka-fashion-house.shops.test')
        .expect(200);
      await t.http().get('/v1/public/store-domains/check?domain=nobody.shops.test').expect(404);
      await t.http().get('/v1/public/store-domains/check?domain=shops.test').expect(404);
      await t.http().get('/v1/public/store-domains/check?domain=evil.example.com').expect(404);
    });

    it('closes the store when the plan no longer includes online stores', async () => {
      await setOverrides({ removeModules: ['storefront'] });
      await O().get(url('/stores')).expect(402);
      expect((await shop('get', '/resolve', host).expect(200)).body.state).toBe('unavailable');
      await setOverrides({ removeModules: [] });
      expect((await shop('get', '/resolve', host).expect(200)).body.state).toBe('open');
    });

    it('holds the plan limit on stores', async () => {
      const { items } = (await O().get(url('/stores')).expect(200)).body as { items: StoreDto[] };
      await setOverrides({ limits: { stores: items.length } });
      const res = await O().post(url('/stores')).send({ name: 'One Too Many' }).expect(402);
      expect(res.body.code).toBe('plan_limit_reached');
      await setOverrides({ limits: {} });
    });
  });
});
