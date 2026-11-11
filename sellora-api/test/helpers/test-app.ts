import { rm } from 'node:fs/promises';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import type { Env } from '../../src/config/env.js';
import { TotpService } from '../../src/modules/auth/core/totp.service.js';
import {
  GATEWAY_FETCH,
  type GatewayFetch,
} from '../../src/modules/billing/payments/gateway.types.js';
import { PlatformAdminsService } from '../../src/modules/platform/platform-admins.service.js';
import { AI_FETCH } from '../../src/modules/ai/provider/ai-provider.js';
import { META_FETCH } from '../../src/modules/meta/meta-graph.js';
import { COURIER_FETCH } from '../../src/modules/couriers/courier.types.js';
import { SMS_FETCH } from '../../src/modules/sms/sms.types.js';
import { DNS_LOOKUP, type DnsLookup } from '../../src/modules/stores/dns-lookup.js';
import { GOOGLE_FETCH } from '../../src/modules/backups/google-drive.js';
import { TELEGRAM_FETCH } from '../../src/infra/telegram/telegram.client.js';
import { AD_FETCH } from '../../src/modules/ad-tracking/ad-tracking.types.js';
import { REDIS } from '../../src/infra/redis/redis.module.js';
import type { Redis } from 'ioredis';
import { testEnv } from './env.js';

export interface Session {
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

let emailCounter = 0;
export function uniqueEmail(prefix = 'user'): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}.${Date.now().toString(36)}@example.com`;
}

export const STRONG_PASSWORD = 'correct horse battery staple';

/**
 * Boots the real application (same module graph and middleware as production) against an
 * isolated database and Redis prefix.
 */
export class TestApp {
  private constructor(
    readonly app: NestExpressApplication,
    readonly env: Env,
  ) {}

  static async create(
    overrides: Record<string, string> = {},
    opts: {
      /** Replaces the fetch payment gateways use, so tests can play the gateway's part. */
      gatewayFetch?: GatewayFetch;
      /** Extra controllers mounted behind the real global guard (route-level probes). */
      controllers?: Type[];
      /** Replaces the fetch AI providers use, so tests can play the AI provider's part. */
      aiFetch?: typeof fetch;
      /** Replaces the fetch the Graph API client uses, so tests can play Meta's part. */
      metaFetch?: typeof fetch;
      /** Replaces the fetch courier adapters use, so tests can play the couriers' part. */
      courierFetch?: typeof fetch;
      /** Replaces the fetch SMS providers use, so tests can play the provider's part. */
      smsFetch?: typeof fetch;
      /** Replaces DNS lookups for custom domains, so tests can play the DNS provider's part. */
      dnsLookup?: DnsLookup;
      /** Replaces the fetch the Google Drive client uses, so tests can play Google's part. */
      googleFetch?: typeof fetch;
      /** Replaces the fetch the Telegram client uses, so tests can play Telegram's part. */
      telegramFetch?: typeof fetch;
      /** Replaces the fetch ad platforms are called with, so tests can play their part. */
      adFetch?: typeof fetch;
    } = {},
  ): Promise<TestApp> {
    const env = testEnv(overrides);
    let builder = Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
      controllers: opts.controllers ?? [],
    });
    if (opts.gatewayFetch)
      builder = builder.overrideProvider(GATEWAY_FETCH).useValue(opts.gatewayFetch);
    if (opts.aiFetch) builder = builder.overrideProvider(AI_FETCH).useValue(opts.aiFetch);
    if (opts.metaFetch) builder = builder.overrideProvider(META_FETCH).useValue(opts.metaFetch);
    if (opts.courierFetch)
      builder = builder.overrideProvider(COURIER_FETCH).useValue(opts.courierFetch);
    if (opts.smsFetch) builder = builder.overrideProvider(SMS_FETCH).useValue(opts.smsFetch);
    if (opts.dnsLookup) builder = builder.overrideProvider(DNS_LOOKUP).useValue(opts.dnsLookup);
    if (opts.googleFetch)
      builder = builder.overrideProvider(GOOGLE_FETCH).useValue(opts.googleFetch);
    if (opts.telegramFetch)
      builder = builder.overrideProvider(TELEGRAM_FETCH).useValue(opts.telegramFetch);
    if (opts.adFetch) builder = builder.overrideProvider(AD_FETCH).useValue(opts.adFetch);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
      logger: false,
    });
    configureApp(app);
    await app.init();
    return new TestApp(app, env);
  }

  get db(): Connection {
    return this.app.get<Connection>(getConnectionToken());
  }

  get redis(): Redis {
    return this.app.get<Redis>(REDIS);
  }

  async close(): Promise<void> {
    await this.db.dropDatabase().catch(() => undefined);
    const keys = await this.redis.keys('*').catch(() => [] as string[]);
    const prefix = this.env.REDIS_KEY_PREFIX;
    if (keys.length)
      await this.redis.del(...keys.map((k) => k.slice(prefix.length))).catch(() => undefined);
    await this.app.close();
    if (this.env.STORAGE_DRIVER === 'local')
      await rm(this.env.STORAGE_LOCAL_DIR, { recursive: true, force: true });
  }

  http() {
    return request(this.app.getHttpServer());
  }

  /** Starts listening on a free local port (for Socket.IO clients). Returns the base URL. */
  async listen(): Promise<string> {
    await this.app.listen(0, '127.0.0.1');
    const address = this.app.getHttpServer().address() as { port: number };
    return `http://127.0.0.1:${address.port}`;
  }

  /** Request with a bearer token, as a mobile or API client would send it. */
  as(token: string | undefined) {
    const server = this.app.getHttpServer();
    const build = (method: Method, url: string) => {
      const req = request(server)[method](url).set('x-sellora-client', 'api');
      return token ? req.set('authorization', `Bearer ${token}`) : req;
    };
    return {
      get: (url: string) => build('get', url),
      post: (url: string) => build('post', url),
      patch: (url: string) => build('patch', url),
      put: (url: string) => build('put', url),
      delete: (url: string) => build('delete', url),
    };
  }

  outbox(to: string): Promise<{ category: string; text: string; subject: string }[]> {
    return this.db
      .db!.collection<{ category: string; text: string; subject: string }>('mail_outbox')
      .find({ to })
      .sort({ _id: -1 })
      .toArray();
  }

  async lastTokenFromMail(to: string, category: string): Promise<string> {
    const mails = await this.outbox(to);
    const mail = mails.find((m) => m.category === category);
    if (!mail) throw new Error(`No ${category} mail for ${to}`);
    const match =
      /token=([A-Za-z0-9_%-]+)/.exec(mail.text) ?? /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text);
    if (!match) throw new Error(`No token in ${category} mail`);
    return decodeURIComponent(match[1]!);
  }

  /** Sign up, verify email and sign in. */
  async registerUser(
    opts: { email?: string; name?: string; password?: string; verify?: boolean } = {},
  ): Promise<Session> {
    const email = opts.email ?? uniqueEmail();
    const password = opts.password ?? STRONG_PASSWORD;
    await this.http()
      .post('/v1/auth/signup')
      .send({ name: opts.name ?? 'Test User', email, password, acceptTerms: true })
      .expect(202);
    if (opts.verify !== false) {
      const token = await this.lastTokenFromMail(email, 'auth.verify');
      await this.http().post('/v1/auth/verify-email').send({ token }).expect(200);
    }
    return this.login(email, password);
  }

  async login(email: string, password = STRONG_PASSWORD): Promise<Session> {
    const res = await this.as(undefined)
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(200);
    if (res.body.status !== 'ok') throw new Error(`Login needs ${res.body.status}`);
    return {
      token: res.body.accessToken,
      refreshToken: res.body.refreshToken,
      userId: res.body.user.id,
      email,
    };
  }

  async createOrg(
    session: Session,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; slug: string }> {
    const res = await this.as(session.token)
      .post('/v1/orgs')
      .send({
        name: `Shop ${Math.random().toString(36).slice(2, 7)}`,
        category: 'fashion',
        ...body,
      })
      .expect(201);
    return res.body as { id: string; slug: string };
  }

  /** Invites `email` with `roleKey` and has them accept. Returns their session. */
  async addMember(
    owner: Session,
    orgId: string,
    roleKey: string,
    member?: Session,
  ): Promise<Session> {
    const invitee = member ?? (await this.registerUser());
    await this.as(owner.token)
      .post(`/v1/orgs/${orgId}/invitations`)
      .send({ email: invitee.email, roleKey })
      .expect(201);
    const token = await this.lastTokenFromMail(invitee.email, 'org.invitation');
    await this.as(invitee.token).post('/v1/invitations/accept').send({ token }).expect(200);
    return invitee;
  }

  /**
   * A TOTP code for the next 30 s step. Codes are single-use per step, so right after a
   * code for the current step was used (e.g. at enrolment) this is the one that works.
   */
  async nextTotp(secret: string): Promise<string> {
    return this.app.get(TotpService).currentCode(secret, Math.floor(Date.now() / 1000) + 30);
  }

  /** Creates the first platform owner end to end (setup link, password, MFA enrolment). */
  async platformOwner(
    email = uniqueEmail('owner'),
    password = 'platform owner passphrase 1',
  ): Promise<{ token: string; secret: string; email: string; password: string }> {
    const { setupUrl } = await this.app
      .get(PlatformAdminsService)
      .bootstrapOwner(email, 'Platform Owner');
    const setupToken = decodeURIComponent(new URL(setupUrl).searchParams.get('token')!);
    return this.completePlatformAccount(email, password, setupToken);
  }

  async completePlatformAccount(email: string, password: string, setupLinkToken: string) {
    await this.http()
      .post('/v1/platform/auth/setup')
      .send({ token: setupLinkToken, password })
      .expect(200);
    const login = await this.as(undefined)
      .post('/v1/platform/auth/login')
      .send({ email, password })
      .expect(200);
    if (login.body.status !== 'mfa_setup_required')
      throw new Error(`unexpected ${login.body.status}`);
    const setup = await this.http()
      .post('/v1/platform/auth/mfa/setup')
      .send({ setupToken: login.body.setupToken })
      .expect(200);
    const secret = setup.body.secret as string;
    const activated = await this.as(undefined)
      .post('/v1/platform/auth/mfa/activate')
      .send({
        setupToken: login.body.setupToken,
        code: await this.app.get(TotpService).currentCode(secret),
      })
      .expect(200);
    if (activated.body.user?.mfaEnabled !== true)
      throw new Error('activation response must report two-factor as enabled');
    return { token: activated.body.accessToken as string, secret, email, password };
  }

  async platformLogin(email: string, password: string, secret: string): Promise<string> {
    const login = await this.as(undefined)
      .post('/v1/platform/auth/login')
      .send({ email, password })
      .expect(200);
    const res = await this.as(undefined)
      .post('/v1/platform/auth/login/mfa')
      .send({ mfaToken: login.body.mfaToken, code: await this.nextTotp(secret) })
      .expect(200);
    return res.body.accessToken as string;
  }
}
