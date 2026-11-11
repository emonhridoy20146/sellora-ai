import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adQueue, drainAdEvents } from '../helpers/ad-events.js';
import { FakeAdPlatforms } from '../helpers/fake-ad-platforms.js';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ProductDto {
  id: string;
  variants: { id: string; priceMinor: number }[];
}

interface Destination {
  id: string;
  platform: string;
  name: string;
  publicId: string;
  hasSecret: boolean;
  secretHint: string | null;
  testCode: string | null;
  enabled: boolean;
  purchaseWhen: string;
  chatOrders: boolean;
  lastCheck: { state: string; summary: string };
  lastError: { message: string } | null;
  week?: { sent: number; failed: number };
}

interface Placed {
  orderNumber: string;
  totalMinor: number;
  receipt: string;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
type Obj = Record<string, unknown>;

describe('ad tracking with the business’s own pixels and tags (ADR 0030)', () => {
  let t: TestApp;
  const fake = new FakeAdPlatforms();
  let owner: Session;
  let other: Session;
  let orgId: string;
  let otherOrgId: string;
  let platform: string;
  let key: string;
  let storeId: string;
  let panjabi: ProductDto;
  const host = 'kumartuli-crafts.shops.test';
  let ip = 10;
  const ids: Record<string, string> = {};

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const at = (path: string) => url(`/ad-tracking${path}`);
  const shop = (method: 'get' | 'post', path: string, from = '203.0.113.200', preview?: string) => {
    const req = t
      .http()
      [method](`/v1/storefront${path}`)
      .set('x-storefront-key', key)
      .set('x-store-host', host)
      .set('x-shopper-ip', from)
      .set('x-shopper-agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile');
    return preview ? req.set('x-store-preview', preview) : req;
  };
  const line = () => ({ productId: panjabi.id, variantId: panjabi.variants[0]!.id, quantity: 1 });
  const browser = {
    url: `https://${host}/products/cotton-panjabi`,
    fbp: 'fb.1.1700000000000.1234567890',
    ttp: 'ttp-0123456789abcdef',
    visitorId: 'visitor-0001',
  };
  const shopper = () => {
    ip += 1;
    return { ip: `203.0.113.${ip}`, phone: `0171${String(1_000_000 + ip).slice(-7)}` };
  };
  const checkout = async (tracking: Obj | undefined, idem = `idem-${Date.now()}-${ip}-ab`) => {
    const who = shopper();
    const res = await shop('post', '/checkout', who.ip)
      .set('idempotency-key', idem)
      .send({
        items: [line()],
        customer: { name: 'Rahima Akter', phone: who.phone },
        address: { line1: 'House 12, Road 5', city: 'Rajshahi' },
        zoneId: 'outside',
        attribution: { utmSource: 'facebook', fbclid: 'IwAR0clickid12345' },
        ...(tracking ? { tracking } : {}),
      })
      .expect(201);
    return { placed: res.body as Placed, phone: who.phone };
  };
  const orderByNumber = async (number: string) => {
    const list = await O()
      .get(url(`/orders?q=${encodeURIComponent(number)}`))
      .expect(200);
    return (list.body.items as { id: string; number: string; customerId?: string }[]).find(
      (o) => o.number === number,
    )!;
  };
  const add = async (body: Obj, expect = 201) =>
    (await O().post(at('/destinations')).send(body).expect(expect)).body as Destination & {
      code?: string;
      errors?: { path: string }[];
    };
  const overview = async () =>
    (await O().get(at('')).expect(200)).body as {
      destinations: Destination[];
      settings: { consent: string };
      sites: { stores: { id: string }[] };
    };
  const tracking = async (preview?: string) =>
    (await shop('get', '/resolve', '203.0.113.200', preview).expect(200)).body.tracking as {
      consent: string;
      meta: { pixelId: string; purchase: boolean }[];
      tiktok: { pixelCode: string; purchase: boolean }[];
      ga4: { measurementId: string }[];
      googleAds: { conversionId: string; purchaseLabel: string | null; purchase: boolean }[];
    } | null;
  const status = (orderId: string, s: string) =>
    O()
      .post(url(`/orders/${orderId}/status`))
      .send({ status: s })
      .expect(200);

  beforeAll(async () => {
    t = await TestApp.create({}, { adFetch: fake.fetch });
    key = t.env.STOREFRONT_API_KEY!;
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Kumartuli Crafts', category: 'fashion' })).id;
    other = await t.registerUser({ name: 'Someone else' });
    otherOrgId = (await t.createOrg(other, { name: 'Other Shop', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(
      [
        'Store',
        'Product',
        'Customer',
        'Order',
        'AdDestination',
        'AdTrackingSettings',
        'AdOrderContext',
        'AdEventLog',
      ].map((m) => t.db.model(m).init()),
    );
    panjabi = (
      await O()
        .post(url('/products'))
        .send({ name: 'Cotton Panjabi', variants: [{ priceMinor: 150_000, stock: 50 }] })
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
    storeId = (
      (await O().post(url('/stores')).send({ name: 'Kumartuli Crafts' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await O()
      .patch(url(`/stores/${storeId}`))
      .send({ contact: { phone: '01712345678' } })
      .expect(200);
    await O()
      .post(url(`/stores/${storeId}/submit`))
      .expect(200);
    await t.as(platform).post(`/v1/platform/stores/${storeId}/approve`).send({}).expect(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('starts with nothing: the store loads no tags', async () => {
    const o = await overview();
    expect(o.destinations).toEqual([]);
    expect(o.settings.consent).toBe('off');
    expect(o.sites.stores.map((s) => s.id)).toEqual([storeId]);
    expect(await tracking()).toEqual({
      consent: 'off',
      meta: [],
      tiktok: [],
      ga4: [],
      googleAds: [],
    });
  });

  it('checks a Meta pixel and token before saving, and never shows the token again', async () => {
    const wrong = await add(
      { platform: 'meta', publicId: fake.meta.pixelId, secret: 'test-wrong-token-not-real' },
      422,
    );
    expect(wrong.code).toBe('tracking_check_failed');
    const notAPixel = await add({ platform: 'meta', publicId: 'abc123' }, 422);
    expect(notAPixel.errors?.[0]?.path).toBe('publicId');

    const meta = await add({
      platform: 'meta',
      publicId: fake.meta.pixelId,
      secret: fake.meta.token,
    });
    expect(meta).toMatchObject({
      platform: 'meta',
      hasSecret: true,
      secretHint: '…0001',
      enabled: true,
      purchaseWhen: 'placed',
      lastCheck: { state: 'ok' },
    });
    expect(meta.lastCheck.summary).toContain(fake.meta.pixelName);
    ids.meta = meta.id;
    expect(JSON.stringify(await overview())).not.toContain(fake.meta.token);
    const raw = await t.db.collection('addestinations').find({}).toArray();
    expect(JSON.stringify(raw)).not.toContain(fake.meta.token);

    const twice = await add({ platform: 'meta', publicId: fake.meta.pixelId }, 409);
    expect(twice.code).toBe('tracking_id_exists');
  });

  it('holds each platform’s rules, then lists the public ids for the store (no keys)', async () => {
    const early = await add(
      { platform: 'tiktok', publicId: fake.tiktok.pixelCode, purchaseWhen: 'delivered' },
      422,
    );
    expect(early.errors?.[0]?.path).toBe('purchaseWhen');
    const chat = await add(
      {
        platform: 'tiktok',
        publicId: fake.tiktok.pixelCode,
        secret: fake.tiktok.token,
        chatOrders: true,
      },
      422,
    );
    expect(chat.errors?.[0]?.path).toBe('chatOrders');
    const noLabel = await add({ platform: 'google_ads', publicId: 'AW-123456789' }, 422);
    expect(noLabel.errors?.[0]?.path).toBe('conversionLabel');

    const tiktok = await add({
      platform: 'tiktok',
      publicId: fake.tiktok.pixelCode,
      secret: fake.tiktok.token,
      testCode: fake.tiktok.testCode,
    });
    expect(tiktok.lastCheck.state).toBe('unchecked');
    ids.tiktok = tiktok.id;
    const ga4 = await add({
      platform: 'ga4',
      publicId: fake.ga4.measurementId,
      secret: fake.ga4.secret,
      purchaseWhen: 'delivered',
    });
    ids.ga4 = ga4.id;
    const ads = await add({
      platform: 'google_ads',
      publicId: 'AW-123456789',
      conversionLabel: 'AbC-D_efG123',
      secret: 'ignored-for-google-ads',
    });
    expect(ads.hasSecret).toBe(false);
    ids.ads = ads.id;

    const tags = await tracking();
    expect(tags).toEqual({
      consent: 'off',
      meta: [{ pixelId: fake.meta.pixelId, purchase: true }],
      tiktok: [{ pixelCode: fake.tiktok.pixelCode, purchase: true }],
      ga4: [{ measurementId: fake.ga4.measurementId }],
      googleAds: [{ conversionId: 'AW-123456789', purchaseLabel: 'AbC-D_efG123', purchase: true }],
    });
    const resolved = JSON.stringify((await shop('get', '/resolve').expect(200)).body);
    for (const secret of [fake.meta.token, fake.tiktok.token, fake.ga4.secret])
      expect(resolved).not.toContain(secret);
  });

  it('copies a product view to Meta and TikTok with the browser’s event id, priced from the catalog', async () => {
    fake.reset();
    const res = await shop('post', '/ad-events', '203.0.113.50')
      .send({
        event: 'ViewContent',
        eventId: 'ev-view-0001',
        items: [line()],
        ...browser,
        fbclid: 'IwAR0clickid12345',
      })
      .expect(200);
    expect(res.body).toEqual({ queued: 2 });
    // The browser cannot name a price: the body is checked strictly.
    await shop('post', '/ad-events')
      .send({ event: 'ViewContent', eventId: 'ev-view-0002', items: [line()], value: 1 })
      .expect(422);
    const unknown = await shop('post', '/ad-events')
      .send({
        event: 'AddToCart',
        eventId: 'ev-cart-0003',
        items: [{ productId: '64b000000000000000000001', quantity: 1 }],
      })
      .expect(200);
    expect(unknown.body).toEqual({ queued: 0 });

    const sent = await drainAdEvents(t);
    expect(sent.map((s) => s.result)).toEqual(['sent', 'sent']);
    const [m] = fake.events('meta') as Obj[];
    expect(m).toMatchObject({
      event_name: 'ViewContent',
      event_id: 'ev-view-0001',
      action_source: 'website',
      event_source_url: browser.url,
      user_data: {
        client_ip_address: '203.0.113.50',
        client_user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile',
        fbp: browser.fbp,
        external_id: [sha('visitor:visitor-0001')],
      },
      custom_data: { currency: 'BDT', value: 1500, content_ids: [panjabi.id] },
    });
    expect(String((m!.user_data as Obj).fbc)).toMatch(/^fb\.1\.\d{13}\.IwAR0clickid12345$/);
    const [k] = fake.events('tiktok') as Obj[];
    expect(k).toMatchObject({
      event: 'ViewContent',
      event_id: 'ev-view-0001',
      user: { ttp: browser.ttp, ip: '203.0.113.50' },
      page: { url: browser.url },
      properties: { currency: 'BDT', value: 1500 },
    });
    expect(fake.of('tiktok')[0]!.headers['access-token']).toBe(fake.tiktok.token);
    expect(fake.events('ga4')).toEqual([]);
  });

  it('sends the purchase once, from the order, with hashed details; the receipt has the same event id', async () => {
    fake.reset();
    const { placed, phone } = await checkout({
      ...browser,
      url: `https://${host}/checkout`,
      ga: 'GA1.1.111222333.1700000000',
      gaSession: 'GS2.1.s1700000123$o1$g1$t1700000200$j0$l0$h0',
      consent: true,
    });
    const order = await orderByNumber(placed.orderNumber);
    const sent = await drainAdEvents(t);
    expect(sent.map((s) => s.result).sort()).toEqual(['sent', 'sent']);
    const e164 = `+880${phone.slice(1)}`;
    const [m] = fake.events('meta') as Obj[];
    expect(m).toMatchObject({
      event_name: 'Purchase',
      event_id: `purchase.${order.id}`,
      action_source: 'website',
      event_source_url: `https://${host}/checkout`,
      user_data: {
        ph: [sha(e164.slice(1))],
        fn: [sha('rahima')],
        ln: [sha('akter')],
        ct: [sha('rajshahi')],
        country: [sha('bd')],
        fbp: browser.fbp,
        client_ip_address: `203.0.113.${ip}`,
      },
      custom_data: { value: placed.totalMinor / 100, order_id: placed.orderNumber, num_items: 1 },
    });
    expect(JSON.stringify(m)).not.toContain(phone.slice(-8));
    const [k] = fake.events('tiktok') as Obj[];
    expect(k).toMatchObject({
      event: 'Purchase',
      event_id: `purchase.${order.id}`,
      user: { phone: sha(e164) },
      properties: { order_id: placed.orderNumber },
    });
    // GA4 counts this business's purchases on delivery; nothing yet.
    expect(fake.events('ga4')).toEqual([]);

    const receipt = await shop(
      'get',
      `/orders/receipt?receipt=${encodeURIComponent(placed.receipt)}`,
    ).expect(200);
    expect(receipt.body.tracking.purchase).toMatchObject({
      eventId: `purchase.${order.id}`,
      orderNumber: placed.orderNumber,
      valueMinor: placed.totalMinor,
      hashedPhone: sha(e164),
      hashedEmail: null,
    });
    expect(JSON.stringify(receipt.body.tracking)).not.toContain(phone.slice(-8));

    // Queued again (a retried trigger), it is not sent again.
    await adQueue(t).add('send', {
      orgId,
      destinationId: ids.meta!,
      order: { orderId: order.id, name: 'Purchase', time: Math.floor(Date.now() / 1000) },
    });
    expect((await drainAdEvents(t)).map((s) => s.result)).toEqual(['skipped']);
    ids.order = order.id;
    ids.orderNumber = placed.orderNumber;
  });

  it('counts on delivery where asked: GA4 gets the purchase when delivered and a refund on return', async () => {
    fake.reset();
    await status(ids.order!, 'confirmed');
    await status(ids.order!, 'shipped');
    await status(ids.order!, 'delivered');
    expect((await drainAdEvents(t)).map((s) => s.result)).toEqual(['sent']);
    const call = fake.of('ga4')[0]!;
    expect(call.path).toBe('/mp/collect');
    expect(call.query).toMatchObject({
      measurement_id: fake.ga4.measurementId,
      api_secret: fake.ga4.secret,
    });
    expect(call.body).toMatchObject({
      client_id: '111222333.1700000000',
      consent: { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' },
      events: [
        {
          name: 'purchase',
          params: {
            transaction_id: ids.orderNumber,
            currency: 'BDT',
            session_id: '1700000123',
            items: [{ item_id: panjabi.id, quantity: 1, price: 1500 }],
          },
        },
      ],
    });
    expect((call.body!.user_data as Obj).sha256_phone_number).toHaveLength(1);
    expect(fake.events('meta')).toEqual([]);

    await status(ids.order!, 'returned');
    expect((await drainAdEvents(t)).map((s) => s.result)).toEqual(['sent']);
    expect(fake.events('ga4').map((e) => (e as Obj).name)).toEqual(['purchase', 'refund']);
    expect((fake.events('ga4')[1] as { params: Obj }).params.transaction_id).toBe(ids.orderNumber);
  });

  it('asks first when the business wants: without a yes nothing is sent', async () => {
    fake.reset();
    expect((await O().patch(at('/settings')).send({ consent: 'ask' }).expect(200)).body).toEqual({
      consent: 'ask',
    });
    expect((await tracking())?.consent).toBe('ask');
    const no = await shop('post', '/ad-events')
      .send({ event: 'AddToCart', eventId: 'ev-cart-0010', items: [line()], consent: false })
      .expect(200);
    expect(no.body).toEqual({ queued: 0 });
    const silent = await shop('post', '/ad-events')
      .send({ event: 'AddToCart', eventId: 'ev-cart-0011', items: [line()] })
      .expect(200);
    expect(silent.body).toEqual({ queued: 0 });
    const { placed } = await checkout({ ...browser, consent: false });
    expect(await drainAdEvents(t)).toEqual([]);
    const order = await orderByNumber(placed.orderNumber);
    const ctx = await t.db
      .collection('adordercontexts')
      .findOne({ orderId: { $exists: true }, consent: false });
    expect(String(ctx?.orderId)).toBe(order.id);

    const yes = await shop('post', '/ad-events')
      .send({ event: 'AddToCart', eventId: 'ev-cart-0012', items: [line()], consent: true })
      .expect(200);
    expect(yes.body).toEqual({ queued: 2 });
    await drainAdEvents(t);
    await O().patch(at('/settings')).send({ consent: 'off' }).expect(200);
  });

  it('sends orders added by hand to Meta when the business asks for it', async () => {
    fake.reset();
    await O()
      .patch(at(`/destinations/${ids.meta}`))
      .send({ chatOrders: true })
      .expect(200);
    const manual = await O()
      .post(url('/orders'))
      .send({
        customer: { name: 'Karim Hossain', phone: '01912345678', email: 'Karim@Example.com' },
        shippingAddress: { line1: 'House 7', city: 'Khulna' },
        items: [line()],
      })
      .expect(201);
    expect((await drainAdEvents(t)).map((s) => s.result)).toEqual(['sent']);
    const [m] = fake.events('meta') as Obj[];
    expect(m).toMatchObject({
      event_name: 'Purchase',
      event_id: `purchase.${manual.body.id as string}`,
      action_source: 'other',
      user_data: { em: [sha('karim@example.com')], ph: [sha('8801912345678')] },
    });
    expect((m!.user_data as Obj).client_user_agent).toBeUndefined();
    expect(fake.events('tiktok')).toEqual([]);
    await O()
      .patch(at(`/destinations/${ids.meta}`))
      .send({ chatOrders: false })
      .expect(200);
  });

  it('sends a test event with the test code and says what the platform answered', async () => {
    fake.reset();
    const needsCode = await O()
      .post(at(`/destinations/${ids.meta}/test`))
      .expect(422);
    expect(needsCode.body.errors[0].path).toBe('testCode');
    await O()
      .patch(at(`/destinations/${ids.meta}`))
      .send({ testCode: fake.meta.testCode })
      .expect(200);
    const meta = await O()
      .post(at(`/destinations/${ids.meta}/test`))
      .expect(200);
    expect(meta.body).toMatchObject({ ok: true });
    expect(meta.body.message).toContain('Test events');
    expect(fake.of('meta').at(-1)!.body?.test_event_code).toBe(fake.meta.testCode);

    const tiktok = await O()
      .post(at(`/destinations/${ids.tiktok}/test`))
      .expect(200);
    expect(tiktok.body.ok).toBe(true);
    expect(fake.of('tiktok').at(-1)!.body?.test_event_code).toBe(fake.tiktok.testCode);

    const ga4 = await O()
      .post(at(`/destinations/${ids.ga4}/test`))
      .expect(200);
    expect(ga4.body.ok).toBe(true);
    expect(fake.of('ga4').map((c) => c.path)).toEqual(['/debug/mp/collect', '/mp/collect']);
    expect(fake.events('ga4')[0]).toMatchObject({
      name: 'sellora_test',
      params: { debug_mode: true },
    });

    const ads = await O()
      .post(at(`/destinations/${ids.ads}/test`))
      .expect(422);
    expect(ads.body.code).toBe('tracking_test_unavailable');

    const log = await O().get(at('/events?limit=10')).expect(200);
    expect(
      (log.body.items as { source: string; status: string }[]).filter((i) => i.source === 'test'),
    ).toHaveLength(3);
    // Sent from the real queue, a test event would not need the worker: it is answered at once.
    expect(await adQueue(t).getJobs(['waiting'])).toEqual([]);
  });

  it('logs a refusal on the tracking id, and leaves a fault for another try', async () => {
    fake.reset();
    await O()
      .patch(at(`/destinations/${ids.tiktok}`))
      .send({ secret: 'test-wrong-tiktok-token-not-real' })
      .expect(200);
    await shop('post', '/ad-events')
      .send({ event: 'InitiateCheckout', eventId: 'ev-check-0020', items: [line()] })
      .expect(200);
    const results = await drainAdEvents(t);
    expect(results.map((r) => r.result).sort()).toEqual(['failed', 'sent']);
    const tiktok = (await overview()).destinations.find((d) => d.id === ids.tiktok)!;
    expect(tiktok.lastError?.message).toContain('Access token is invalid');
    expect(tiktok.week?.failed).toBe(1);

    fake.failNextMeta = true;
    await shop('post', '/ad-events')
      .send({ event: 'InitiateCheckout', eventId: 'ev-check-0021', items: [line()] })
      .expect(200);
    const first = await drainAdEvents(t, { final: false });
    expect(first.find((r) => r.job.destinationId === ids.meta)?.result).toMatch(/^threw/);
    await O()
      .patch(at(`/destinations/${ids.tiktok}`))
      .send({ secret: fake.tiktok.token })
      .expect(200);
  });

  it('switched off, limited to other pages, or previewed: nothing loads', async () => {
    await O()
      .patch(at(`/destinations/${ids.meta}`))
      .send({ enabled: false })
      .expect(200);
    expect((await tracking())?.meta).toEqual([]);
    const ev = await shop('post', '/ad-events')
      .send({ event: 'ViewContent', eventId: 'ev-view-0030', items: [line()] })
      .expect(200);
    expect(ev.body).toEqual({ queued: 1 });
    await drainAdEvents(t);

    const none = await O()
      .patch(at(`/destinations/${ids.tiktok}`))
      .send({ everywhere: false })
      .expect(422);
    expect(none.body.errors[0].path).toBe('everywhere');
    const foreignStore = (
      await t
        .as(other.token)
        .post(`/v1/orgs/${otherOrgId}/stores`)
        .send({ name: 'Other Shop' })
        .expect(201)
    ).body.id as string;
    await O()
      .patch(at(`/destinations/${ids.tiktok}`))
      .send({ everywhere: false, storeIds: [foreignStore] })
      .expect(422);
    await O()
      .patch(at(`/destinations/${ids.tiktok}`))
      .send({ everywhere: false, landingPageIds: [], storeIds: [storeId] })
      .expect(200);
    expect((await tracking())?.tiktok).toHaveLength(1);

    const link = await O()
      .post(url(`/stores/${storeId}/preview-link`))
      .expect(200);
    const token = new URL(link.body.url as string).searchParams.get('token')!;
    const previewed = (await shop('get', '/resolve', '203.0.113.200', token).expect(200)).body;
    if (previewed.state !== 'open') expect(previewed.tracking).toBeNull();

    await O()
      .delete(at(`/destinations/${ids.ads}`))
      .expect(204);
    expect((await tracking())?.googleAds).toEqual([]);
  });

  it('keeps each business’s ids and log to itself', async () => {
    const theirs = await t.as(other.token).get(`/v1/orgs/${otherOrgId}/ad-tracking`).expect(200);
    expect(theirs.body.destinations).toEqual([]);
    await t
      .as(other.token)
      .patch(`/v1/orgs/${otherOrgId}/ad-tracking/destinations/${ids.tiktok}`)
      .send({ enabled: false })
      .expect(404);
    await t
      .as(other.token)
      .post(`/v1/orgs/${otherOrgId}/ad-tracking/destinations/${ids.tiktok}/test`)
      .expect(404);
    const log = await t
      .as(other.token)
      .get(`/v1/orgs/${otherOrgId}/ad-tracking/events`)
      .expect(200);
    expect(log.body.items).toEqual([]);
    // Another business's account is told nothing about this one.
    await t.as(other.token).get(`/v1/orgs/${orgId}/ad-tracking`).expect(404);
  });
});
