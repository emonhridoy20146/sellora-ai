import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STRONG_PASSWORD, TestApp, uniqueEmail, type Session } from '../helpers/test-app.js';

describe('businesses, staff and roles', () => {
  let t: TestApp;
  let owner: Session;
  let org: { id: string; slug: string };

  beforeAll(async () => {
    t = await TestApp.create();
    owner = await t.registerUser({ name: 'Owner' });
    org = await t.createOrg(owner, { name: 'Dhaka Fashion House', category: 'fashion' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('business lifecycle', () => {
    it('creates a business with BD defaults and makes the creator owner', async () => {
      const res = await t.as(owner.token).get(`/v1/orgs/${org.id}`).expect(200);
      expect(res.body).toMatchObject({
        name: 'Dhaka Fashion House',
        slug: 'dhaka-fashion-house',
        country: 'BD',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        status: 'active',
        role: { key: 'owner', name: 'Owner' },
      });
      expect(res.body.permissions).toContain('billing.manage');
      const list = await t.as(owner.token).get('/v1/orgs').expect(200);
      expect(list.body.map((o: { id: string }) => o.id)).toContain(org.id);
      const me = await t.as(owner.token).get('/v1/auth/me').expect(200);
      expect(me.body.organizations[0].id).toBe(org.id);
    });

    it('generates a unique slug, and rejects taken or reserved custom slugs', async () => {
      const again = await t.createOrg(owner, { name: 'Dhaka Fashion House' });
      expect(again.slug).not.toBe('dhaka-fashion-house');
      expect(again.slug).toMatch(/^dhaka-fashion-house-\d{3}$/);
      const taken = await t
        .as(owner.token)
        .post('/v1/orgs')
        .send({ name: 'X', slug: 'dhaka-fashion-house' })
        .expect(409);
      expect(taken.body.code).toBe('slug_unavailable');
      await t.as(owner.token).post('/v1/orgs').send({ name: 'X', slug: 'admin' }).expect(409);
      await t.as(owner.token).post('/v1/orgs').send({ name: 'X', currency: 'XYZ' }).expect(422);
    });

    it('updates settings and records it in the audit log', async () => {
      const res = await t
        .as(owner.token)
        .patch(`/v1/orgs/${org.id}`)
        .send({
          legalName: 'DFH Ltd',
          orderNumberPrefix: 'dfh',
          contact: { phone: '01711-223344', website: 'https://dfh.example' },
        })
        .expect(200);
      expect(res.body.legalName).toBe('DFH Ltd');
      expect(res.body.settings.orderNumberPrefix).toBe('DFH');
      expect(res.body.contact.phone).toBe('+8801711223344');
      const audit = await t
        .as(owner.token)
        .get(`/v1/orgs/${org.id}/audit-events?action=org.`)
        .expect(200);
      expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
        expect.arrayContaining(['org.updated', 'org.created']),
      );
      await t.as(owner.token).patch(`/v1/orgs/${org.id}`).send({ status: 'closed' }).expect(422);
    });
  });

  describe('invitations', () => {
    it('invites staff by email, who accept with the matching account', async () => {
      const agent = await t.registerUser({ name: 'Agent' });
      await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/invitations`)
        .send({ email: agent.email, roleKey: 'sales_agent' })
        .expect(201);
      const dup = await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/invitations`)
        .send({ email: agent.email, roleKey: 'viewer' })
        .expect(409);
      expect(dup.body.code).toBe('already_invited');
      const token = await t.lastTokenFromMail(agent.email, 'org.invitation');

      const preview = await t.http().get(`/v1/invitations/${token}`).expect(200);
      expect(preview.body).toMatchObject({
        orgName: 'Dhaka Fashion House',
        roleName: 'Sales agent',
        status: 'pending',
      });
      expect(preview.body.email).not.toBe(agent.email);

      const stranger = await t.registerUser();
      const mismatch = await t
        .as(stranger.token)
        .post('/v1/invitations/accept')
        .send({ token })
        .expect(403);
      expect(mismatch.body.code).toBe('invitation_email_mismatch');

      await t.as(agent.token).post('/v1/invitations/accept').send({ token }).expect(200);
      await t.as(agent.token).post('/v1/invitations/accept').send({ token }).expect(404);
      const members = await t.as(owner.token).get(`/v1/orgs/${org.id}/members`).expect(200);
      expect(members.body.find((m: { email: string }) => m.email === agent.email).role.key).toBe(
        'sales_agent',
      );

      const again = await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/invitations`)
        .send({ email: agent.email, roleKey: 'viewer' })
        .expect(409);
      expect(again.body.code).toBe('already_member');
    });

    it('lets an unregistered invitee sign up later and verifies their email on accept', async () => {
      const email = uniqueEmail('newstaff');
      await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/invitations`)
        .send({ email, roleKey: 'fulfillment' })
        .expect(201);
      const token = await t.lastTokenFromMail(email, 'org.invitation');
      const newbie = await t.registerUser({ email, verify: false });
      await t.as(newbie.token).post('/v1/invitations/accept').send({ token }).expect(200);
      const me = await t.as(newbie.token).get('/v1/auth/me').expect(200);
      expect(me.body.user.emailVerified).toBe(true);
      expect(me.body.organizations[0].role.key).toBe('fulfillment');
    });

    it('revokes pending invitations and refuses unverified inviters', async () => {
      const email = uniqueEmail('revoked');
      const inv = await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/invitations`)
        .send({ email, roleKey: 'viewer' })
        .expect(201);
      await t.as(owner.token).delete(`/v1/orgs/${org.id}/invitations/${inv.body.id}`).expect(204);
      const token = await t.lastTokenFromMail(email, 'org.invitation');
      const invitee = await t.registerUser({ email });
      await t.as(invitee.token).post('/v1/invitations/accept').send({ token }).expect(404);

      const unverified = await t.registerUser({ verify: false });
      const ownOrg = await t.createOrg(unverified);
      const res = await t
        .as(unverified.token)
        .post(`/v1/orgs/${ownOrg.id}/invitations`)
        .send({ email: uniqueEmail(), roleKey: 'viewer' })
        .expect(403);
      expect(res.body.code).toBe('email_unverified');
    });
  });

  describe('permissions and anti-escalation', () => {
    let admin: Session;
    let hr: Session;
    let agent: Session;
    let viewer: Session;

    beforeAll(async () => {
      admin = await t.addMember(owner, org.id, 'admin');
      agent = await t.addMember(owner, org.id, 'sales_agent');
      viewer = await t.addMember(owner, org.id, 'viewer');
      await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/roles`)
        .send({ name: 'HR', permissions: ['org.view', 'org.members.view', 'org.members.manage'] })
        .expect(201);
      hr = await t.addMember(owner, org.id, 'custom-hr');
    });

    async function memberId(email: string): Promise<string> {
      const res = await t.as(owner.token).get(`/v1/orgs/${org.id}/members`).expect(200);
      return res.body.find((m: { email: string }) => m.email === email).id as string;
    }

    it('enforces route permissions per role', async () => {
      const denied = await t
        .as(viewer.token)
        .patch(`/v1/orgs/${org.id}`)
        .send({ name: 'Hacked' })
        .expect(403);
      expect(denied.body).toMatchObject({
        code: 'missing_permission',
        required: ['org.settings.manage'],
      });
      await t.as(agent.token).get(`/v1/orgs/${org.id}/members`).expect(403);
      await t.as(agent.token).get(`/v1/orgs/${org.id}/audit-events`).expect(403);
      await t.as(viewer.token).get(`/v1/orgs/${org.id}/members`).expect(200);
      await t
        .as(admin.token)
        .patch(`/v1/orgs/${org.id}`)
        .send({ name: 'Dhaka Fashion House' })
        .expect(200);
    });

    it('stops people from granting or using access they do not have', async () => {
      const agentId = await memberId(agent.email);
      const adminId = await memberId(admin.email);
      const ownerId = await memberId(owner.email);

      let res = await t
        .as(hr.token)
        .patch(`/v1/orgs/${org.id}/members/${agentId}/role`)
        .send({ roleKey: 'admin' })
        .expect(403);
      expect(res.body.code).toBe('permission_escalation');
      res = await t
        .as(hr.token)
        .patch(`/v1/orgs/${org.id}/members/${adminId}/role`)
        .send({ roleKey: 'custom-hr' })
        .expect(403);
      expect(res.body.code).toBe('permission_escalation');
      await t.as(hr.token).delete(`/v1/orgs/${org.id}/members/${adminId}`).expect(403);
      res = await t
        .as(hr.token)
        .post(`/v1/orgs/${org.id}/invitations`)
        .send({ email: uniqueEmail(), roleKey: 'manager' })
        .expect(403);
      expect(res.body.code).toBe('permission_escalation');
      await t
        .as(hr.token)
        .post(`/v1/orgs/${org.id}/roles`)
        .send({ name: 'Sneaky', permissions: ['billing.manage'] })
        .expect(403);

      res = await t
        .as(admin.token)
        .patch(`/v1/orgs/${org.id}/members/${ownerId}/role`)
        .send({ roleKey: 'viewer' })
        .expect(403);
      expect(res.body.code).toBe('owner_protected');
      res = await t
        .as(admin.token)
        .patch(`/v1/orgs/${org.id}/members/${agentId}/role`)
        .send({ roleKey: 'owner' })
        .expect(403);
      expect(res.body.code).toBe('owner_protected');
      res = await t
        .as(admin.token)
        .patch(`/v1/orgs/${org.id}/members/${adminId}/role`)
        .send({ roleKey: 'viewer' })
        .expect(403);
      expect(res.body.code).toBe('self_change');
      await t.as(admin.token).delete(`/v1/orgs/${org.id}/members/${ownerId}`).expect(403);

      // The agent has access HR lacks (catalog, orders), so HR cannot touch them...
      res = await t
        .as(hr.token)
        .patch(`/v1/orgs/${org.id}/members/${agentId}/status`)
        .send({ status: 'suspended' })
        .expect(403);
      expect(res.body.code).toBe('permission_escalation');
      // ...until the owner narrows the agent's role to something within HR's own access.
      await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/roles`)
        .send({ name: 'Basic', permissions: ['org.view'] })
        .expect(201);
      await t
        .as(owner.token)
        .patch(`/v1/orgs/${org.id}/members/${agentId}/role`)
        .send({ roleKey: 'custom-basic' })
        .expect(204);
      await t
        .as(hr.token)
        .patch(`/v1/orgs/${org.id}/members/${agentId}/status`)
        .send({ status: 'suspended' })
        .expect(204);
      await t.as(agent.token).get(`/v1/orgs/${org.id}`).expect(404);
      await t
        .as(hr.token)
        .patch(`/v1/orgs/${org.id}/members/${agentId}/status`)
        .send({ status: 'active' })
        .expect(204);
      await t.as(agent.token).get(`/v1/orgs/${org.id}`).expect(200);
      await t.as(agent.token).get(`/v1/orgs/${org.id}/audit-events`).expect(403);
    });

    it('applies role changes immediately (no stale permission cache)', async () => {
      const viewerId = await memberId(viewer.email);
      await t.as(viewer.token).patch(`/v1/orgs/${org.id}`).send({ name: 'Nope' }).expect(403);
      await t
        .as(owner.token)
        .patch(`/v1/orgs/${org.id}/members/${viewerId}/role`)
        .send({ roleKey: 'admin' })
        .expect(204);
      await t
        .as(viewer.token)
        .patch(`/v1/orgs/${org.id}`)
        .send({ name: 'Dhaka Fashion House' })
        .expect(200);
      await t
        .as(owner.token)
        .patch(`/v1/orgs/${org.id}/members/${viewerId}/role`)
        .send({ roleKey: 'viewer' })
        .expect(204);
      await t.as(viewer.token).patch(`/v1/orgs/${org.id}`).send({ name: 'Nope' }).expect(403);
    });

    it('suspends and removes members, who then lose access', async () => {
      const victim = await t.addMember(owner, org.id, 'viewer');
      const id = await memberId(victim.email);
      await t
        .as(owner.token)
        .patch(`/v1/orgs/${org.id}/members/${id}/status`)
        .send({ status: 'suspended' })
        .expect(204);
      await t.as(victim.token).get(`/v1/orgs/${org.id}`).expect(404);
      await t
        .as(owner.token)
        .patch(`/v1/orgs/${org.id}/members/${id}/status`)
        .send({ status: 'active' })
        .expect(204);
      await t.as(victim.token).get(`/v1/orgs/${org.id}`).expect(200);
      await t.as(owner.token).delete(`/v1/orgs/${org.id}/members/${id}`).expect(204);
      await t.as(victim.token).get(`/v1/orgs/${org.id}`).expect(404);
    });

    it('keeps custom roles consistent', async () => {
      const roles = await t.as(owner.token).get(`/v1/orgs/${org.id}/roles`).expect(200);
      expect(roles.body.find((r: { key: string }) => r.key === 'owner').system).toBe(true);
      await t
        .as(owner.token)
        .patch(`/v1/orgs/${org.id}/roles/admin`)
        .send({ name: 'Renamed' })
        .expect(403);
      await t.as(owner.token).delete(`/v1/orgs/${org.id}/roles/custom-hr`).expect(409);
      await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/roles`)
        .send({ name: 'Bad', permissions: ['root.everything'] })
        .expect(422);
      const temp = await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/roles`)
        .send({ name: 'Temp', permissions: ['catalog.view'] })
        .expect(201);
      await t.as(owner.token).delete(`/v1/orgs/${org.id}/roles/${temp.body.key}`).expect(204);
    });

    it('transfers ownership with password confirmation', async () => {
      const adminId = await memberId(admin.email);
      await t
        .as(admin.token)
        .post(`/v1/orgs/${org.id}/transfer-ownership`)
        .send({ memberId: adminId, password: STRONG_PASSWORD })
        .expect(403);
      await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/transfer-ownership`)
        .send({ memberId: adminId, password: 'wrong password' })
        .expect(403);
      await t.as(owner.token).post(`/v1/orgs/${org.id}/leave`).expect(403);
      await t
        .as(owner.token)
        .post(`/v1/orgs/${org.id}/transfer-ownership`)
        .send({ memberId: adminId, password: STRONG_PASSWORD })
        .expect(204);
      const newOwnerView = await t.as(admin.token).get(`/v1/orgs/${org.id}`).expect(200);
      expect(newOwnerView.body.role.key).toBe('owner');
      const oldOwnerView = await t.as(owner.token).get(`/v1/orgs/${org.id}`).expect(200);
      expect(oldOwnerView.body.role.key).toBe('admin');
      await t.as(owner.token).post(`/v1/orgs/${org.id}/leave`).expect(204);
      await t.as(owner.token).get(`/v1/orgs/${org.id}`).expect(404);
    });
  });
});
