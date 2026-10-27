import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { UnscopedQueryError } from '../../src/common/errors/app-error.js';
import { CrossTenantAccessError } from '../../src/infra/database/tenant-guard.plugin.js';
import { MissingTenantScopeError } from '../../src/infra/database/tenant-scoped.repository.js';
import { MembershipRepository } from '../../src/modules/orgs/repositories.js';
import { fillParams, listRoutes } from '../helpers/routes.js';
import { TestApp, type Session } from '../helpers/test-app.js';

describe('tenant isolation and route security', () => {
  let t: TestApp;
  let alice: Session;
  let bob: Session;
  let orgA: { id: string };
  let orgB: { id: string };
  let platformToken: string;

  beforeAll(async () => {
    t = await TestApp.create();
    alice = await t.registerUser({ name: 'Alice' });
    bob = await t.registerUser({ name: 'Bob' });
    orgA = await t.createOrg(alice, { name: 'Alice Fashion' });
    orgB = await t.createOrg(bob, { name: 'Bob Gadgets' });
    platformToken = (await t.platformOwner()).token;
  });
  afterAll(async () => {
    await t.close();
  });

  it('every route with :orgId is tenant scoped', () => {
    const offenders = listRoutes(t.app).filter(
      (r) => r.path.includes(':orgId') && r.realm === 'merchant' && !r.orgScoped,
    );
    expect(offenders).toEqual([]);
  });

  it('every non-public route rejects anonymous requests', async () => {
    const routes = listRoutes(t.app).filter((r) => !r.isPublic);
    expect(routes.length).toBeGreaterThan(40);
    for (const r of routes) {
      const res = await t.http()[r.method](fillParams(r.path)).send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
    }
  });

  it('platform routes reject merchant tokens and merchant routes reject platform tokens', async () => {
    for (const r of listRoutes(t.app).filter((x) => !x.isPublic)) {
      const token = r.realm === 'platform' ? alice.token : platformToken;
      const res = await t
        .as(token)
        [r.method](fillParams(r.path, { orgId: orgA.id }))
        .send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
    }
  });

  it('a member of one business gets 404 on every route of another business', async () => {
    const scoped = listRoutes(t.app).filter((r) => r.orgScoped);
    expect(scoped.length).toBeGreaterThan(10);
    for (const r of scoped) {
      const res = await t
        .as(bob.token)
        [r.method](fillParams(r.path, { orgId: orgA.id }))
        .send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(404);
      expect(res.body.code).toBe('organization_not_found');
    }
    // Same answer for an id that does not exist, so ids cannot be probed.
    const missing = await t
      .as(bob.token)
      .get(`/v1/orgs/${new Types.ObjectId().toHexString()}`)
      .expect(404);
    expect(missing.body.code).toBe('organization_not_found');
    await t.as(bob.token).get('/v1/orgs/not-an-id').expect(404);
  });

  it('ids from another tenant are invisible inside your own tenant', async () => {
    const aliceMembers = await t.as(alice.token).get(`/v1/orgs/${orgA.id}/members`).expect(200);
    const aliceMemberId = aliceMembers.body[0].id as string;
    await t
      .as(bob.token)
      .patch(`/v1/orgs/${orgB.id}/members/${aliceMemberId}/role`)
      .send({ roleKey: 'viewer' })
      .expect(404);
    await t.as(bob.token).delete(`/v1/orgs/${orgB.id}/members/${aliceMemberId}`).expect(404);
    const invite = await t
      .as(alice.token)
      .post(`/v1/orgs/${orgA.id}/invitations`)
      .send({ email: 'someone@example.com', roleKey: 'viewer' })
      .expect(201);
    await t.as(bob.token).delete(`/v1/orgs/${orgB.id}/invitations/${invite.body.id}`).expect(404);
    const still = await t.as(alice.token).get(`/v1/orgs/${orgA.id}/invitations`).expect(200);
    expect(still.body[0].status).toBe('pending');
  });

  it('audit logs only show the tenant’s own events', async () => {
    const res = await t.as(bob.token).get(`/v1/orgs/${orgB.id}/audit-events`).expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const orgIds = new Set(
      await t.db.collection('audit_events').distinct('orgId', {
        _id: { $in: res.body.items.map((i: { id: string }) => new Types.ObjectId(i.id)) },
      }),
    );
    expect([...orgIds].map(String)).toEqual([orgB.id]);
  });

  describe('data layer guard', () => {
    it('refuses repository use outside a tenant scope', async () => {
      const repo = t.app.get(MembershipRepository);
      await expect(repo.find({})).rejects.toBeInstanceOf(MissingTenantScopeError);
    });

    it('refuses unscoped and cross-tenant queries on tenant collections, even through the raw model', async () => {
      const model = t.db.model('Membership');
      await expect(model.find({}).exec()).rejects.toBeInstanceOf(UnscopedQueryError);
      await expect(model.countDocuments({ roleKey: 'owner' }).exec()).rejects.toBeInstanceOf(
        UnscopedQueryError,
      );
      await expect(
        model.updateMany({}, { $set: { roleKey: 'admin' } }).exec(),
      ).rejects.toBeInstanceOf(UnscopedQueryError);
      await expect(
        model.deleteMany({ orgId: { $ne: new Types.ObjectId(orgA.id) } }).exec(),
      ).rejects.toBeInstanceOf(UnscopedQueryError);
      await expect(model.aggregate([{ $group: { _id: '$orgId' } }]).exec()).rejects.toBeInstanceOf(
        UnscopedQueryError,
      );
      await expect(model.estimatedDocumentCount().exec()).rejects.toBeInstanceOf(
        UnscopedQueryError,
      );

      await RequestContext.run({ requestId: 't', actor: { type: 'system', id: 't' } }, () =>
        RequestContext.withTenant(orgB.id, async () => {
          await expect(
            model.find({ orgId: new Types.ObjectId(orgA.id) }).exec(),
          ).rejects.toBeInstanceOf(CrossTenantAccessError);
          await expect(
            model.aggregate([{ $match: { orgId: new Types.ObjectId(orgA.id) } }]).exec(),
          ).rejects.toBeInstanceOf(CrossTenantAccessError);
          await expect(
            model
              .updateOne(
                { orgId: new Types.ObjectId(orgB.id) },
                { $set: { orgId: new Types.ObjectId(orgA.id) } },
              )
              .exec(),
          ).rejects.toBeInstanceOf(CrossTenantAccessError);
          await expect(
            model.insertMany([
              {
                orgId: new Types.ObjectId(orgA.id),
                userId: new Types.ObjectId(),
                roleKey: 'viewer',
              },
            ]),
          ).rejects.toBeInstanceOf(CrossTenantAccessError);
          await expect(
            model.bulkWrite([
              {
                updateOne: {
                  filter: { orgId: new Types.ObjectId(orgA.id) },
                  update: { $set: { roleKey: 'x' } },
                },
              },
            ]),
          ).rejects.toBeInstanceOf(CrossTenantAccessError);
          const own = await model
            .find({ orgId: new Types.ObjectId(orgB.id) })
            .lean()
            .exec();
          expect(own).toHaveLength(1);
        }),
      );
    });

    it('repositories pin every query to the current tenant', async () => {
      const repo = t.app.get(MembershipRepository);
      const fromB = await RequestContext.run(
        { requestId: 't', actor: { type: 'system', id: 't' } },
        () =>
          RequestContext.withTenant(orgB.id, () =>
            repo.find({ orgId: new Types.ObjectId(orgA.id) }),
          ),
      );
      expect(fromB.every((m) => m.orgId.toHexString() === orgB.id)).toBe(true);
    });
  });
});
