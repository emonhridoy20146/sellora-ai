import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

interface ThemeDto {
  announcement: string;
  palette: { primary: string; accent: string };
  sections: { id: string; type: string; enabled: boolean; [k: string]: unknown }[];
  [k: string]: unknown;
}

interface StoreDto {
  id: string;
  status: string;
  themeKey: string;
  theme: ThemeDto;
  changeRequest: { askedAt: string; reason: string; changedSince: boolean } | null;
}

interface Changes {
  since: string;
  lastAt: string;
  areas: string[];
  flags: { where: string; label: string; term: string; reason: string }[];
  askedAt: string | null;
  reason: string | null;
  texts: { where: string; label: string; before: string | null; now: string | null }[] | null;
}

describe('review of store changes after approval (ADR 0028)', () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let orgId: string;
  let otherOrgId: string;
  let platform: string;
  let store: StoreDto;

  const O = () => t.as(owner.token);
  const P = () => t.as(platform);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const changes = async (id = store.id) =>
    (await P().get(`/v1/platform/stores/${id}`).expect(200)).body.changes as Changes | null;
  const queue = async () =>
    (await P().get('/v1/platform/stores?changed=true').expect(200)).body as {
      items: { id: string; changes: { areas: string[]; flagCount: number } | null }[];
      changed: number;
    };
  const edit = (body: Record<string, unknown>) =>
    O()
      .patch(url(`/stores/${store.id}`))
      .send(body)
      .expect(200);
  const setPlatformSettings = (stores: Record<string, unknown>) =>
    P().patch('/v1/platform/settings').send({ stores }).expect(200);

  beforeAll(async () => {
    t = await TestApp.create({ API_PUBLIC_URL: 'http://api.test' });
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Kumartuli Crafts', category: 'fashion' })).id;
    other = await t.registerUser({ name: 'Someone else' });
    otherOrgId = (await t.createOrg(other, { name: 'Other Shop', category: 'fashion' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(['Store', 'Product'].map((m) => t.db.model(m).init()));
    await O()
      .post(url('/products'))
      .send({ name: 'Clay pot', variants: [{ priceMinor: 45_000, stock: 10 }] })
      .expect(201);
    store = (await O().post(url('/stores')).send({ name: 'Kumartuli Crafts' }).expect(201))
      .body as StoreDto;
    await edit({
      contact: { phone: '01712345678' },
      pages: { about: 'Handmade clay pots from Kumartuli, Dhaka.' },
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('notes nothing before the store is approved', async () => {
    await edit({ name: 'Kumartuli Crafts BD' });
    expect(await changes()).toBeNull();
    await O()
      .post(url(`/stores/${store.id}/submit`))
      .expect(200);
    await P().post(`/v1/platform/stores/${store.id}/approve`).send({}).expect(200);
    expect(await changes()).toBeNull();
    expect((await queue()).changed).toBe(0);
  });

  it('leaves out edits the reviewer does not need (phone, smallest order)', async () => {
    await edit({ contact: { phone: '01812345678' }, checkout: { minOrderMinor: 50_000 } });
    expect(await changes()).toBeNull();
  });

  it('puts a changed page live at once and in the queue, with the words before and now', async () => {
    const saved = (await edit({
      pages: { about: 'Handmade clay pots. We also sell master copy bags.' },
    })) as { body: StoreDto };
    expect(saved.body.status).toBe('live');
    const c = (await changes())!;
    expect(c.areas).toEqual(['pages']);
    expect(c.flags).toEqual([
      expect.objectContaining({ where: 'page:about', term: 'master copy' }),
    ]);
    expect(c.texts).toEqual([
      {
        where: 'page:about',
        label: 'Page: About us',
        before: 'Handmade clay pots from Kumartuli, Dhaka.',
        now: 'Handmade clay pots. We also sell master copy bags.',
      },
    ]);
    const q = await queue();
    expect(q.changed).toBe(1);
    expect(q.items[0]).toMatchObject({
      id: store.id,
      changes: { areas: ['pages'], flagCount: 1 },
    });
  });

  it('adds later areas to the same entry; a design save counts as design', async () => {
    const theme = { ...store.theme, announcement: 'Free delivery in Dhaka this week' };
    await O()
      .put(url(`/stores/${store.id}/theme`))
      .send({ themeKey: store.themeKey, theme })
      .expect(200);
    const c = (await changes())!;
    expect(c.areas).toEqual(['pages', 'design']);
    expect(c.texts?.map((x) => x.where)).toEqual(['announcement', 'page:about']);
    // Saving the same design again is not a change.
    const before = c.lastAt;
    await O()
      .put(url(`/stores/${store.id}/theme`))
      .send({ themeKey: store.themeKey, theme })
      .expect(200);
    expect((await changes())!.lastAt).toBe(before);
  });

  it('asks for a fix: the store stays open, the owner is told and sees it', async () => {
    await P()
      .post(`/v1/platform/stores/${store.id}/changes/ask`)
      .send({ reason: 'Remove "master copy bags" from the About page.' })
      .expect(200);
    const mine = (
      await O()
        .get(url(`/stores/${store.id}`))
        .expect(200)
    ).body as StoreDto;
    expect(mine.status).toBe('live');
    expect(mine.changeRequest).toMatchObject({
      reason: 'Remove "master copy bags" from the About page.',
      changedSince: false,
    });
    const mail = (await t.outbox(owner.email)).find((m) => m.category === 'store.changes_asked');
    expect(mail?.text).toContain('Remove "master copy bags" from the About page.');
    expect(mail?.text).toContain(`/app/${orgId}/store/${store.id}`);

    // The fix clears the warning; the entry stays for the reviewer to accept.
    await edit({ pages: { about: 'Handmade clay pots from Kumartuli, Dhaka.' } });
    const c = (await changes())!;
    expect(c.flags).toEqual([]);
    expect(c.texts?.map((x) => x.where)).toEqual(['announcement']);
    const after = (
      await O()
        .get(url(`/stores/${store.id}`))
        .expect(200)
    ).body as StoreDto;
    expect(after.changeRequest?.changedSince).toBe(true);
  });

  it('accepts only the version the reviewer saw, then compares with it', async () => {
    const seen = (await changes())!;
    await edit({ seo: { title: 'Clay pots from Kumartuli' } });
    await P()
      .post(`/v1/platform/stores/${store.id}/changes/accept`)
      .send({ lastChangeAt: seen.lastAt })
      .expect(409);
    const latest = (await changes())!;
    expect(latest.areas).toEqual(['pages', 'design', 'seo']);
    const res = await P()
      .post(`/v1/platform/stores/${store.id}/changes/accept`)
      .send({ lastChangeAt: latest.lastAt })
      .expect(200);
    expect(res.body.changes).toBeNull();
    expect(
      (
        await O()
          .get(url(`/stores/${store.id}`))
          .expect(200)
      ).body.changeRequest,
    ).toBeNull();
    expect((await queue()).changed).toBe(0);
    await P()
      .post(`/v1/platform/stores/${store.id}/changes/accept`)
      .send({ lastChangeAt: latest.lastAt })
      .expect(409);

    await edit({ seo: { title: 'Kumartuli clay pots' } });
    expect((await changes())!.texts).toEqual([
      {
        where: 'seo',
        label: 'Search title and description',
        before: 'Clay pots from Kumartuli',
        now: 'Kumartuli clay pots',
      },
    ]);
    const lastChangeAt = (await changes())!.lastAt;
    await P()
      .post(`/v1/platform/stores/${store.id}/changes/accept`)
      .send({ lastChangeAt })
      .expect(200);
  });

  it('checks products saved later; only a flagged one puts the store in the queue', async () => {
    await O()
      .post(url('/products'))
      .send({ name: 'Terracotta plate', variants: [{ priceMinor: 30_000, stock: 4 }] })
      .expect(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(await changes()).toBeNull();

    const flagged = (
      await O()
        .post(url('/products'))
        .send({ name: 'Replica clay idol', variants: [{ priceMinor: 90_000, stock: 1 }] })
        .expect(201)
    ).body as { id: string };
    await vi.waitFor(
      async () => {
        const c = await changes();
        expect(c?.areas).toEqual(['products']);
        expect(c?.flags).toEqual([
          expect.objectContaining({ where: `product:${flagged.id}`, term: 'replica' }),
        ]);
      },
      { timeout: 5_000, interval: 100 },
    );
    // Renamed: its warning goes; the entry stays until the reviewer accepts.
    await O()
      .patch(url(`/products/${flagged.id}`))
      .send({ name: 'Clay idol' })
      .expect(200);
    await vi.waitFor(
      async () => {
        expect((await changes())?.flags).toEqual([]);
      },
      { timeout: 5_000, interval: 100 },
    );
    const lastChangeAt = (await changes())!.lastAt;
    await P()
      .post(`/v1/platform/stores/${store.id}/changes/accept`)
      .send({ lastChangeAt })
      .expect(200);
  });

  it('with automatic approval, accepts clean changes and queues flagged ones', async () => {
    await setPlatformSettings({ autoApprove: true });
    try {
      await edit({ checkout: { note: 'We call before sending every order.' } });
      expect(await changes()).toBeNull();
      await edit({ checkout: { note: 'Cash only. Ask about our betting tips.' } });
      const c = (await changes())!;
      expect(c.areas).toEqual(['checkout']);
      expect(c.flags[0]).toMatchObject({ where: 'checkout', term: 'betting' });
      expect(c.texts).toEqual([
        {
          where: 'checkout',
          label: 'Checkout note',
          before: 'We call before sending every order.',
          now: 'Cash only. Ask about our betting tips.',
        },
      ]);
    } finally {
      await setPlatformSettings({ autoApprove: false });
    }
  });

  it('keeps it to the platform: businesses cannot accept or see the queue', async () => {
    await t
      .as(owner.token)
      .post(`/v1/platform/stores/${store.id}/changes/accept`)
      .send({ lastChangeAt: new Date().toISOString() })
      .expect((r) => expect([401, 403]).toContain(r.status));
    await t.as(other.token).get(`/v1/orgs/${otherOrgId}/stores/${store.id}`).expect(404);
    await P()
      .post(`/v1/platform/stores/${store.id}/changes/ask`)
      .send({ reason: 'no' })
      .expect(422);
  });

  it('approving a store again starts from a clean slate', async () => {
    expect(await changes()).not.toBeNull();
    const s = (await O().post(url('/stores')).send({ name: 'Second Shop' }).expect(201))
      .body as StoreDto;
    await O()
      .patch(url(`/stores/${s.id}`))
      .send({ contact: { phone: '01912345678' } })
      .expect(200);
    await O()
      .post(url(`/stores/${s.id}/submit`))
      .expect(200);
    await P().post(`/v1/platform/stores/${s.id}/approve`).send({}).expect(200);
    expect(await changes(s.id)).toBeNull();
    // One store in the queue (the first); the new one has nothing to look at.
    expect((await queue()).items.map((i) => i.id)).toEqual([store.id]);
  });
});
