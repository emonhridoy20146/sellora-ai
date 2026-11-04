import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TotpService } from '../../src/modules/auth/core/totp.service.js';
import { OrgsService } from '../../src/modules/orgs/orgs.service.js';
import { PlatformAdminsService } from '../../src/modules/platform/platform-admins.service.js';
import { STRONG_PASSWORD, TestApp, uniqueEmail, type Session } from '../helpers/test-app.js';

describe('super-admin platform', () => {
  let t: TestApp;
  let owner: { token: string; secret: string; email: string; password: string };

  beforeAll(async () => {
    t = await TestApp.create();
    owner = await t.platformOwner();
  });
  afterAll(async () => {
    await t.close();
  });

  async function createAdmin(role: string, by = owner.token) {
    const email = uniqueEmail(role);
    await t
      .as(by)
      .post('/v1/platform/admins')
      .send({ email, name: `${role} admin`, role })
      .expect(201);
    const token = await t.lastTokenFromMail(email, 'platform.setup');
    return t.completePlatformAccount(email, 'a long platform passphrase', token);
  }

  describe('sign-in', () => {
    it('can only bootstrap once', async () => {
      await expect(
        t.app.get(PlatformAdminsService).bootstrapOwner(uniqueEmail(), 'Second'),
      ).rejects.toThrow(/already has accounts/);
    });

    it('requires two-factor on every sign-in and issues strict cookies', async () => {
      const login = await t
        .http()
        .post('/v1/platform/auth/login')
        .send({ email: owner.email, password: owner.password })
        .expect(200);
      expect(login.body).toEqual({ status: 'mfa_required', mfaToken: expect.any(String) });
      expect(login.headers['set-cookie']).toBeUndefined();
      await t
        .http()
        .post('/v1/platform/auth/login/mfa')
        .send({ mfaToken: login.body.mfaToken, code: '123456' })
        .expect(401);
      const ok = await t
        .http()
        .post('/v1/platform/auth/login/mfa')
        .send({ mfaToken: login.body.mfaToken, code: await t.nextTotp(owner.secret) })
        .expect(200);
      const cookies = ok.headers['set-cookie'] as unknown as string[];
      const access = cookies.find((c) => c.startsWith('slp_at='))!;
      expect(access).toContain('Path=/v1/platform');
      expect(access).toContain('SameSite=Strict');
      expect(access).toContain('HttpOnly');
      expect(ok.body.user).toMatchObject({ email: owner.email, role: 'owner', mfaEnabled: true });
      expect(ok.body.user.permissions).toContain('platform.admins.manage');
    });

    it('rejects wrong passwords without revealing whether the account exists', async () => {
      const a = await t
        .http()
        .post('/v1/platform/auth/login')
        .send({ email: owner.email, password: 'wrong password' })
        .expect(401);
      const b = await t
        .http()
        .post('/v1/platform/auth/login')
        .send({ email: uniqueEmail(), password: 'wrong password' })
        .expect(401);
      expect(a.body.detail).toBe(b.body.detail);
    });

    it('does not let merchant accounts sign in to the platform', async () => {
      const merchant = await t.registerUser();
      await t
        .http()
        .post('/v1/platform/auth/login')
        .send({ email: merchant.email, password: STRONG_PASSWORD })
        .expect(401);
    });
  });

  describe('system admins', () => {
    it('lets the owner create admins with roles, each limited to their permissions', async () => {
      const support = await createAdmin('support');
      await t.as(support.token).get('/v1/platform/tenants').expect(200);
      await t.as(support.token).get('/v1/platform/admins').expect(403);
      await t
        .as(support.token)
        .patch('/v1/platform/settings')
        .send({ signupEnabled: false })
        .expect(403);
      const finance = await createAdmin('finance');
      await t.as(finance.token).get('/v1/platform/users').expect(200);
      await t
        .as(finance.token)
        .patch(`/v1/platform/users/${new Types.ObjectId().toHexString()}/status`)
        .send({ status: 'locked', reason: 'test' })
        .expect(403);
      const ro = await createAdmin('readonly');
      await t.as(ro.token).get('/v1/platform/overview').expect(200);
      await t
        .as(ro.token)
        .post('/v1/platform/admins')
        .send({ email: uniqueEmail(), name: 'x', role: 'readonly' })
        .expect(403);
    });

    it('enforces rank: admins manage only lower roles and the last owner is protected', async () => {
      const admin = await createAdmin('admin');
      const res = await t
        .as(admin.token)
        .post('/v1/platform/admins')
        .send({ email: uniqueEmail(), name: 'Owner 2', role: 'owner' })
        .expect(403);
      expect(res.body.code).toBe('rank_too_low');
      await t
        .as(admin.token)
        .post('/v1/platform/admins')
        .send({ email: uniqueEmail(), name: 'Peer', role: 'admin' })
        .expect(403);
      await t
        .as(admin.token)
        .post('/v1/platform/admins')
        .send({ email: uniqueEmail(), name: 'Helper', role: 'support' })
        .expect(201);

      const list = await t.as(owner.token).get('/v1/platform/admins').expect(200);
      const ownerRow = list.body.find((a: { email: string }) => a.email === owner.email);
      const adminRow = list.body.find((a: { email: string }) => a.email === admin.email);
      await t
        .as(admin.token)
        .patch(`/v1/platform/admins/${ownerRow.id}/status`)
        .send({ status: 'disabled' })
        .expect(403);
      const self = await t
        .as(owner.token)
        .patch(`/v1/platform/admins/${ownerRow.id}/role`)
        .send({ role: 'readonly' })
        .expect(403);
      expect(self.body.code).toBe('self_change');

      // Promote the admin to owner, then try to demote the original owner: allowed, since another owner remains.
      await t
        .as(owner.token)
        .patch(`/v1/platform/admins/${adminRow.id}/role`)
        .send({ role: 'owner' })
        .expect(200);
      // Role changes end the changed admin's sessions immediately.
      await t.as(admin.token).get('/v1/platform/auth/me').expect(401);
      const relogged = await t.platformLogin(admin.email, admin.password, admin.secret);
      const meNow = await t.as(relogged).get('/v1/platform/auth/me').expect(200);
      expect(meNow.body.role).toBe('owner');
      await t
        .as(relogged)
        .patch(`/v1/platform/admins/${adminRow.id}/role`)
        .send({ role: 'admin' })
        .expect(403);
      await t
        .as(owner.token)
        .patch(`/v1/platform/admins/${adminRow.id}/role`)
        .send({ role: 'admin' })
        .expect(200);
      const last = await t.as(relogged).get('/v1/platform/auth/me');
      expect(last.status).toBe(401);
    });

    it('disables admins and ends their sessions', async () => {
      const support = await createAdmin('support');
      const list = await t.as(owner.token).get('/v1/platform/admins').expect(200);
      const row = list.body.find((a: { email: string }) => a.email === support.email);
      await t
        .as(owner.token)
        .patch(`/v1/platform/admins/${row.id}/status`)
        .send({ status: 'disabled' })
        .expect(200);
      await t.as(support.token).get('/v1/platform/tenants').expect(401);
      await t
        .http()
        .post('/v1/platform/auth/login')
        .send({ email: support.email, password: support.password })
        .expect(401);
    });
  });

  describe('tenant and user control', () => {
    let merchant: Session;
    let org: { id: string };

    beforeAll(async () => {
      merchant = await t.registerUser({ name: 'Karim' });
      org = await t.createOrg(merchant, { name: 'Karim Electronics' });
    });

    it('lists and searches businesses with owners and member counts', async () => {
      const res = await t.as(owner.token).get('/v1/platform/tenants?q=karim').expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0]).toMatchObject({
        name: 'Karim Electronics',
        memberCount: 1,
        owner: { email: merchant.email },
      });
      const detail = await t.as(owner.token).get(`/v1/platform/tenants/${org.id}`).expect(200);
      expect(detail.body.members[0]).toMatchObject({ email: merchant.email, roleKey: 'owner' });
      const overview = await t.as(owner.token).get('/v1/platform/overview').expect(200);
      expect(overview.body.tenants).toBeGreaterThanOrEqual(1);
    });

    it('suspends a business: staff are blocked until it is reactivated', async () => {
      await t
        .as(owner.token)
        .patch(`/v1/platform/tenants/${org.id}/status`)
        .send({ status: 'suspended', reason: 'Payment overdue' })
        .expect(200);
      const blocked = await t.as(merchant.token).get(`/v1/orgs/${org.id}`).expect(403);
      expect(blocked.body.code).toBe('org_suspended');
      await t
        .as(owner.token)
        .patch(`/v1/platform/tenants/${org.id}/status`)
        .send({ status: 'active', reason: 'Paid' })
        .expect(200);
      await t.as(merchant.token).get(`/v1/orgs/${org.id}`).expect(200);
      const audit = await t
        .as(owner.token)
        .get(`/v1/platform/audit-events?orgId=${org.id}&action=org.status`)
        .expect(200);
      expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual([
        'org.status.active',
        'org.status.suspended',
      ]);
    });

    it('runs time-limited demo businesses that expire', async () => {
      await t
        .as(owner.token)
        .patch(`/v1/platform/tenants/${org.id}/demo`)
        .send({ hours: 48 })
        .expect(200);
      await t.as(merchant.token).get(`/v1/orgs/${org.id}`).expect(200);
      await t.db
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(org.id) },
          { $set: { demoExpiresAt: new Date(Date.now() - 1000) } },
        );
      await t
        .as(owner.token)
        .patch(`/v1/platform/tenants/${org.id}/demo`)
        .send({ hours: null })
        .expect(200);
      await t.as(merchant.token).get(`/v1/orgs/${org.id}`).expect(200);

      await t
        .as(owner.token)
        .patch(`/v1/platform/tenants/${org.id}/demo`)
        .send({ hours: 1 })
        .expect(200);
      await t.db
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(org.id) },
          { $set: { demoExpiresAt: new Date(Date.now() - 1000) } },
        );
      await t.redis.incr(`access-ver:${org.id}`);
      const expired = await t.as(merchant.token).get(`/v1/orgs/${org.id}`).expect(403);
      expect(expired.body.code).toBe('demo_expired');
      const orgs = t.app.get(OrgsService);
      const due = await orgs.findExpiredDemos();
      expect(due.map((o) => o._id.toHexString())).toContain(org.id);
      await t
        .as(owner.token)
        .patch(`/v1/platform/tenants/${org.id}/demo`)
        .send({ hours: null })
        .expect(200);
    });

    it('locks, unlocks and signs out merchant users', async () => {
      const user = await t.registerUser();
      await t
        .as(owner.token)
        .patch(`/v1/platform/users/${user.userId}/status`)
        .send({ status: 'locked', reason: 'Fraud review' })
        .expect(200);
      await t.as(user.token).get('/v1/auth/me').expect(401);
      const login = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: user.email, password: STRONG_PASSWORD })
        .expect(403);
      expect(login.body.code).toBe('account_locked');
      await t
        .as(owner.token)
        .patch(`/v1/platform/users/${user.userId}/status`)
        .send({ status: 'active', reason: 'Cleared' })
        .expect(200);
      const again = await t.login(user.email);
      const out = await t
        .as(owner.token)
        .post(`/v1/platform/users/${user.userId}/force-logout`)
        .expect(200);
      expect(out.body.revoked).toBe(1);
      await t.as(again.token).get('/v1/auth/me').expect(401);
    });

    it('resets a merchant’s two-factor after support verification', async () => {
      const user = await t.registerUser();
      const totp = t.app.get(TotpService);
      const setup = await t.as(user.token).post('/v1/auth/mfa/totp/setup').expect(200);
      await t
        .as(user.token)
        .post('/v1/auth/mfa/totp/enable')
        .send({ code: await totp.currentCode(setup.body.secret) })
        .expect(200);
      await t
        .as(owner.token)
        .post(`/v1/platform/users/${user.userId}/reset-mfa`)
        .send({ reason: 'Lost phone, ID verified' })
        .expect(204);
      const login = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: user.email, password: STRONG_PASSWORD })
        .expect(200);
      expect(login.body.status).toBe('ok');
    });
  });

  describe('platform settings', () => {
    it('turns sign-up and the free trial on and off', async () => {
      const updated = await t
        .as(owner.token)
        .patch('/v1/platform/settings')
        .send({ signupEnabled: false, trial: { days: 7 } })
        .expect(200);
      expect(updated.body).toMatchObject({
        signupEnabled: false,
        trial: { enabled: true, days: 7 },
      });
      const status = await t.http().get('/v1/public/platform-status').expect(200);
      expect(status.body.signupEnabled).toBe(false);
      const res = await t
        .http()
        .post('/v1/auth/signup')
        .send({ name: 'Late', email: uniqueEmail(), password: STRONG_PASSWORD, acceptTerms: true })
        .expect(403);
      expect(res.body.code).toBe('signup_disabled');
      await t
        .as(owner.token)
        .patch('/v1/platform/settings')
        .send({ signupEnabled: true, trial: { enabled: false } })
        .expect(200);
      await t
        .as(owner.token)
        .patch('/v1/platform/settings')
        .send({ trial: { days: 365 } })
        .expect(422);
    });
  });

  describe('tamper-evident audit log', () => {
    it('verifies hash chains and detects edited events', async () => {
      const merchant = await t.registerUser();
      const org = await t.createOrg(merchant);
      await t
        .as(merchant.token)
        .patch(`/v1/orgs/${org.id}`)
        .send({ legalName: 'Chain Test Ltd' })
        .expect(200);
      const okOrg = await t
        .as(owner.token)
        .get(`/v1/platform/audit-events/verify/${org.id}`)
        .expect(200);
      expect(okOrg.body).toMatchObject({ ok: true });
      expect(okOrg.body.checked).toBeGreaterThanOrEqual(2);
      const okPlatform = await t
        .as(owner.token)
        .get('/v1/platform/audit-events/verify/platform')
        .expect(200);
      expect(okPlatform.body.ok).toBe(true);

      await t.db
        .collection('audit_events')
        .updateOne({ scope: org.id, seq: 1 }, { $set: { 'metadata.slug': 'forged' } });
      const broken = await t
        .as(owner.token)
        .get(`/v1/platform/audit-events/verify/${org.id}`)
        .expect(200);
      expect(broken.body).toMatchObject({ ok: false, brokenAt: 1, reason: 'hash_mismatch' });

      await t.db.collection('audit_events').deleteOne({ scope: org.id, seq: 2 });
      const gap = await t
        .as(owner.token)
        .get(`/v1/platform/audit-events/verify/${org.id}`)
        .expect(200);
      expect(gap.body.ok).toBe(false);
    });

    it('never stores secrets in audit metadata', async () => {
      const events = await t.db.collection('audit_events').find({}).toArray();
      const text = JSON.stringify(events);
      expect(text).not.toContain(STRONG_PASSWORD);
      expect(text).not.toContain(owner.password);
    });
  });
});
