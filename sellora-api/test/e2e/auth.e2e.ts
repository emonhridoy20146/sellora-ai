import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TotpService } from '../../src/modules/auth/core/totp.service.js';
import { STRONG_PASSWORD, TestApp, uniqueEmail } from '../helpers/test-app.js';

describe('merchant authentication', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await TestApp.create();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('sign-up and email verification', () => {
    it('creates an account, emails a verification link and verifies it once', async () => {
      const email = uniqueEmail();
      await t
        .http()
        .post('/v1/auth/signup')
        .send({ name: 'Rahim', email, password: STRONG_PASSWORD, acceptTerms: true, locale: 'bn' })
        .expect(202);
      const session = await t.login(email);
      const before = await t.as(session.token).get('/v1/auth/me').expect(200);
      expect(before.body.user).toMatchObject({
        email,
        name: 'Rahim',
        emailVerified: false,
        locale: 'bn',
      });
      expect(before.body.user).not.toHaveProperty('passwordHash');

      const mail = (await t.outbox(email)).find((m) => m.category === 'auth.verify');
      expect(mail?.subject).toBe('আপনার ইমেইল যাচাই করুন');
      const token = await t.lastTokenFromMail(email, 'auth.verify');
      await t.http().post('/v1/auth/verify-email').send({ token }).expect(200);
      await t.http().post('/v1/auth/verify-email').send({ token }).expect(400);
      const after = await t.as(session.token).get('/v1/auth/me').expect(200);
      expect(after.body.user.emailVerified).toBe(true);
    });

    it('answers identically for an existing email and warns the owner instead', async () => {
      const s = await t.registerUser();
      const res = await t
        .http()
        .post('/v1/auth/signup')
        .send({
          name: 'Intruder',
          email: s.email,
          password: 'another strong pass',
          acceptTerms: true,
        })
        .expect(202);
      expect(res.body.message).toContain('If this email can be used');
      const mails = await t.outbox(s.email);
      expect(mails.some((m) => m.category === 'auth.signup_existing')).toBe(true);
      await t.login(s.email); // original password still works
    });

    it('rejects weak passwords and missing terms', async () => {
      const res = await t
        .http()
        .post('/v1/auth/signup')
        .send({ name: 'A', email: uniqueEmail(), password: 'password123', acceptTerms: false })
        .expect(422);
      const paths = res.body.errors.map((e: { path: string }) => e.path);
      expect(paths).toContain('body.password');
      expect(paths).toContain('body.acceptTerms');
    });
  });

  describe('login', () => {
    it('gives the same error for a wrong password and an unknown email', async () => {
      const s = await t.registerUser();
      const wrong = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: s.email, password: 'wrong password!!' })
        .expect(401);
      const unknown = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'wrong password!!' })
        .expect(401);
      expect(wrong.body.code).toBe('invalid_credentials');
      expect(unknown.body.code).toBe('invalid_credentials');
      expect(wrong.body.detail).toBe(unknown.body.detail);
    });

    it('blocks an account after repeated failures, even with the right password', async () => {
      const s = await t.registerUser();
      for (let i = 0; i < 11; i++) {
        await t
          .as(undefined)
          .post('/v1/auth/login')
          .send({ email: s.email, password: `wrong-${i}-password` });
      }
      const res = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: s.email, password: STRONG_PASSWORD });
      expect([403, 429]).toContain(res.status);
      expect(['rate_limited', 'account_locked']).toContain(res.body.code);
    });

    it('rejects tampered and foreign-realm tokens', async () => {
      const s = await t.registerUser();
      const [h, p, sig] = s.token.split('.');
      const tampered = `${h}.${p}.${sig!.slice(0, -4)}AAAA`;
      await t.as(tampered).get('/v1/auth/me').expect(401);
      await t.as('garbage').get('/v1/auth/me').expect(401);
      await t.as(s.token).get('/v1/platform/auth/me').expect(401);
    });
  });

  describe('sessions and refresh tokens', () => {
    it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
      const s = await t.registerUser();
      const r1 = await t
        .as(undefined)
        .post('/v1/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(200);
      expect(r1.body.refreshToken).not.toBe(s.refreshToken);
      await t.as(r1.body.accessToken).get('/v1/auth/me').expect(200);

      // Immediate replay (another tab) is treated as a race, not theft.
      const race = await t
        .as(undefined)
        .post('/v1/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(409);
      expect(race.body.code).toBe('refresh_race');

      // Outside the grace window the same replay revokes the whole session.
      const sid = s.refreshToken.split('.')[0]!;
      await t.db
        .collection('sessions')
        .updateOne(
          { _id: new (await import('mongoose')).Types.ObjectId(sid) },
          { $set: { rotatedAt: new Date(Date.now() - 60_000) } },
        );
      await t
        .as(undefined)
        .post('/v1/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(401);
      const after = await t.as(r1.body.accessToken).get('/v1/auth/me').expect(401);
      expect(after.body.code).toBe('session_revoked');
      await t
        .as(undefined)
        .post('/v1/auth/refresh')
        .send({ refreshToken: r1.body.refreshToken })
        .expect(401);
      const audit = await t.db
        .collection('audit_events')
        .findOne({ action: 'auth.refresh_token_reuse', 'actor.id': s.userId });
      expect(audit?.outcome).toBe('denied');
    });

    it('logs out and lists or revokes individual sessions', async () => {
      const s1 = await t.registerUser();
      const s2 = await t.login(s1.email);
      const list = await t.as(s1.token).get('/v1/auth/sessions').expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
      const other = list.body.find((x: { current: boolean }) => !x.current);
      await t.as(s1.token).delete(`/v1/auth/sessions/${other.id}`).expect(204);
      await t.as(s2.token).get('/v1/auth/me').expect(401);
      await t.as(s1.token).post('/v1/auth/logout').expect(204);
      await t.as(s1.token).get('/v1/auth/me').expect(401);
    });

    it('cannot revoke another user’s session', async () => {
      const a = await t.registerUser();
      const b = await t.registerUser();
      const bSessions = await t.as(b.token).get('/v1/auth/sessions').expect(200);
      await t.as(a.token).delete(`/v1/auth/sessions/${bSessions.body[0].id}`).expect(404);
      await t.as(b.token).get('/v1/auth/me').expect(200);
    });
  });

  describe('password reset and change', () => {
    it('resets the password with a single-use link and signs out everywhere', async () => {
      const s = await t.registerUser();
      await t.http().post('/v1/auth/password/forgot').send({ email: s.email }).expect(202);
      await t.http().post('/v1/auth/password/forgot').send({ email: uniqueEmail() }).expect(202);
      const token = await t.lastTokenFromMail(s.email, 'auth.password_reset');
      await t
        .http()
        .post('/v1/auth/password/reset')
        .send({ token, password: 'a brand new passphrase' })
        .expect(200);
      await t
        .http()
        .post('/v1/auth/password/reset')
        .send({ token, password: 'another new passphrase' })
        .expect(400);
      await t.as(s.token).get('/v1/auth/me').expect(401);
      await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: s.email, password: STRONG_PASSWORD })
        .expect(401);
      await t.login(s.email, 'a brand new passphrase');
    });

    it('changes the password, keeping only the current session', async () => {
      const s = await t.registerUser();
      const other = await t.login(s.email);
      await t
        .as(s.token)
        .post('/v1/auth/password/change')
        .send({ currentPassword: 'wrong', newPassword: 'changed passphrase 1' })
        .expect(403);
      await t
        .as(s.token)
        .post('/v1/auth/password/change')
        .send({ currentPassword: STRONG_PASSWORD, newPassword: 'changed passphrase 1' })
        .expect(204);
      await t.as(s.token).get('/v1/auth/me').expect(200);
      await t.as(other.token).get('/v1/auth/me').expect(401);
    });
  });

  describe('two-factor authentication', () => {
    it('enrols TOTP, requires it at login, blocks code replay and accepts recovery codes once', async () => {
      const s = await t.registerUser();
      const totp = t.app.get(TotpService);
      const setup = await t.as(s.token).post('/v1/auth/mfa/totp/setup').expect(200);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      await t.as(s.token).post('/v1/auth/mfa/totp/enable').send({ code: '000000' }).expect(401);
      const enabled = await t
        .as(s.token)
        .post('/v1/auth/mfa/totp/enable')
        .send({ code: await totp.currentCode(setup.body.secret) })
        .expect(200);
      expect(enabled.body.recoveryCodes).toHaveLength(10);

      const stored = await t.db.collection('users').findOne({ email: s.email });
      expect(stored?.mfa.totpSecretEnc).toMatch(/^v1\.k1\./);
      expect(JSON.stringify(stored)).not.toContain(setup.body.secret);

      const first = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: s.email, password: STRONG_PASSWORD })
        .expect(200);
      expect(first.body).toEqual({ status: 'mfa_required', mfaToken: expect.any(String) });
      const code = await t.nextTotp(setup.body.secret);
      const ok = await t
        .as(undefined)
        .post('/v1/auth/login/mfa')
        .send({ mfaToken: first.body.mfaToken, code })
        .expect(200);
      expect(ok.body.status).toBe('ok');

      const second = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: s.email, password: STRONG_PASSWORD })
        .expect(200);
      const replay = await t
        .as(undefined)
        .post('/v1/auth/login/mfa')
        .send({ mfaToken: second.body.mfaToken, code })
        .expect(401);
      expect(replay.body.code).toBe('invalid_mfa_code');

      const recovery = enabled.body.recoveryCodes[0];
      await t
        .as(undefined)
        .post('/v1/auth/login/mfa')
        .send({ mfaToken: second.body.mfaToken, recoveryCode: recovery.toLowerCase() })
        .expect(200);
      const third = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: s.email, password: STRONG_PASSWORD })
        .expect(200);
      await t
        .as(undefined)
        .post('/v1/auth/login/mfa')
        .send({ mfaToken: third.body.mfaToken, recoveryCode: recovery })
        .expect(401);

      const status = await t.as(ok.body.accessToken).get('/v1/auth/mfa').expect(200);
      expect(status.body).toMatchObject({ enabled: true, recoveryCodesRemaining: 9 });
      // The session that turned MFA on stays signed in.
      await t.as(s.token).get('/v1/auth/me').expect(200);
    });

    it('does not accept an MFA challenge token as an access token', async () => {
      const s = await t.registerUser();
      const totp = t.app.get(TotpService);
      const setup = await t.as(s.token).post('/v1/auth/mfa/totp/setup').expect(200);
      await t
        .as(s.token)
        .post('/v1/auth/mfa/totp/enable')
        .send({ code: await totp.currentCode(setup.body.secret) })
        .expect(200);
      const login = await t
        .as(undefined)
        .post('/v1/auth/login')
        .send({ email: s.email, password: STRONG_PASSWORD })
        .expect(200);
      await t.as(login.body.mfaToken).get('/v1/auth/me').expect(401);
    });
  });

  describe('browser cookie sessions', () => {
    it('sets HttpOnly cookies, requires the CSRF header for changes and checks Origin', async () => {
      const s = await t.registerUser();
      const login = await t
        .http()
        .post('/v1/auth/login')
        .send({ email: s.email, password: STRONG_PASSWORD })
        .expect(200);
      expect(login.body.refreshToken).toBeUndefined();
      const cookies = login.headers['set-cookie'] as unknown as string[];
      const access = cookies.find((c) => c.startsWith('sl_at='))!;
      const refresh = cookies.find((c) => c.startsWith('sl_rt='))!;
      const csrf = cookies.find((c) => c.startsWith('sl_csrf='))!;
      expect(access).toContain('HttpOnly');
      expect(refresh).toContain('HttpOnly');
      expect(refresh).toContain('Path=/v1/auth');
      expect(csrf).not.toContain('HttpOnly');
      const jar = cookies.map((c) => c.split(';')[0]).join('; ');
      const csrfValue = csrf.split(';')[0]!.split('=')[1]!;
      expect(login.body.csrfToken).toBe(csrfValue);

      await t.http().get('/v1/auth/me').set('cookie', jar).expect(200);
      const blocked = await t
        .http()
        .patch('/v1/auth/me')
        .set('cookie', jar)
        .send({ name: 'New' })
        .expect(403);
      expect(blocked.body.code).toBe('csrf_failed');
      await t
        .http()
        .patch('/v1/auth/me')
        .set('cookie', jar)
        .set('x-csrf-token', 'wrong-token-value')
        .send({ name: 'New' })
        .expect(403);
      const evil = await t
        .http()
        .patch('/v1/auth/me')
        .set('cookie', jar)
        .set('origin', 'https://evil.example')
        .set('x-csrf-token', csrfValue)
        .send({ name: 'New' })
        .expect(403);
      expect(evil.body.code).toBe('origin_not_allowed');
      const ok = await t
        .http()
        .patch('/v1/auth/me')
        .set('cookie', jar)
        .set('origin', 'http://localhost:3000')
        .set('x-csrf-token', csrfValue)
        .send({ name: 'New Name' })
        .expect(200);
      expect(ok.body.name).toBe('New Name');

      await t.http().post('/v1/auth/refresh').set('cookie', jar).send({}).expect(403);
      const refreshed = await t
        .http()
        .post('/v1/auth/refresh')
        .set('cookie', jar)
        .set('x-csrf-token', csrfValue)
        .send({})
        .expect(200);
      expect(
        (refreshed.headers['set-cookie'] as unknown as string[]).some((c) =>
          c.startsWith('sl_rt='),
        ),
      ).toBe(true);
    });
  });
});
