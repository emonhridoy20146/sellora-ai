import { createHmac } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../src/common/context/request-context.js';
import { OrgScoped, RequireModule } from '../../src/modules/auth/decorators.js';
import { BillingJobsService } from '../../src/modules/billing/billing-jobs.service.js';
import { CreditsService } from '../../src/modules/billing/credits.service.js';
import { WalletService } from '../../src/modules/billing/wallet.service.js';
import { FakeGateways } from '../helpers/fake-gateways.js';
import { TestApp, type Session } from '../helpers/test-app.js';

@Controller({ path: 'orgs/:orgId/probe', version: '1' })
class ModuleProbeController {
  @Get('ads')
  @OrgScoped()
  @RequireModule('ads')
  ads() {
    return { ok: true };
  }
}

const DAY = 24 * 3600_000;
const COST_KEYS = [
  'cost',
  'costMinor',
  'costUsdMicros',
  'provider',
  'model',
  'usdRate',
  'usdRateScaled',
  'profit',
];

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, acc));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      keysOf(v, acc);
    }
  return acc;
}

describe('billing', () => {
  let app: TestApp;
  let platform: string;
  let platformEmail: string;
  const fake = new FakeGateways();

  beforeAll(async () => {
    app = await TestApp.create(
      {},
      { gatewayFetch: fake.fetch, controllers: [ModuleProbeController] },
    );
    const owner = await app.platformOwner();
    platform = owner.token;
    platformEmail = owner.email;
  });

  afterAll(async () => {
    await app.close();
  });

  const P = () => app.as(platform);
  const inTenant = <T>(orgId: string, fn: () => Promise<T>) => RequestContext.withTenant(orgId, fn);
  const summary = async (s: Session, orgId: string) =>
    (await app.as(s.token).get(`/v1/orgs/${orgId}/billing/summary`).expect(200)).body as {
      subscription: {
        status: string;
        plan: { code: string };
        trialEndsAt: string | null;
        currentPeriodEnd: string | null;
        entitlements: { modules: string[]; paidAccess: boolean; inGracePeriod: boolean };
      };
      wallet: {
        balanceMinor: number;
        heldMinor: number;
        bonusMinor: number;
        availableMinor: number;
        withdrawableMinor: number;
      };
      creditRate: { creditPriceMinor: number; version: number };
      withdrawalsEnabled: boolean;
    };
  const newOrg = async () => {
    const owner = await app.registerUser();
    const org = await app.createOrg(owner);
    return { owner, orgId: org.id };
  };
  const credit = (
    orgId: string,
    amountMinor: number,
    type = 'topup',
    key = `k-${new Types.ObjectId().toHexString()}`,
  ) =>
    P()
      .post(`/v1/platform/billing/tenants/${orgId}/wallet/adjust`)
      .send({ direction: 'credit', type, amountMinor, note: 'bank transfer', idempotencyKey: key });
  const setSettings = (body: Record<string, unknown>) =>
    P().patch('/v1/platform/settings').send(body).expect(200);
  const subDoc = (orgId: string) =>
    app.db.db!.collection('subscriptions').findOne({ orgId: new Types.ObjectId(orgId) });

  describe('catalogue and defaults', () => {
    it('seeds plans, AI models and the credit price list, and keeps one wallet per business', async () => {
      const plans = (await app.http().get('/v1/public/plans?currency=BDT').expect(200)).body as {
        code: string;
        prices: { amountMinor: number }[];
      }[];
      expect(plans.map((p) => p.code)).toEqual([
        'free',
        'inbox',
        'commerce',
        'growth',
        'all-in-one',
      ]);
      expect(plans.find((p) => p.code === 'inbox')!.prices[0]!.amountMinor).toBe(149_900);

      const models = (await P().get('/v1/platform/billing/ai-models').expect(200)).body as {
        model: string;
        purpose: string;
        tier: string;
        isDefaultForTier: boolean;
      }[];
      expect(
        models
          .filter((m) => m.isDefaultForTier)
          .map((m) => `${m.purpose}:${m.tier}:${m.model}`)
          .sort(),
      ).toEqual([
        'chat:advanced:claude-opus-5-5',
        'chat:fast:claude-haiku-5-5',
        'chat:standard:claude-sonnet-5-5',
        // Voice notes (ADR 0025); its tier is not used.
        'transcription:fast:gpt-4o-mini-transcribe',
      ]);

      // Index builds run in the background at boot; wait for them before reading.
      await Promise.all([app.db.model('Wallet').init(), app.db.model('Subscription').init()]);
      const indexes = await app.db.db!.collection('wallets').indexes();
      expect(indexes.find((i) => JSON.stringify(i.key) === '{"orgId":1}')?.unique).toBe(true);
      const subIndexes = await app.db.db!.collection('subscriptions').indexes();
      expect(subIndexes.find((i) => JSON.stringify(i.key) === '{"orgId":1}')?.unique).toBe(true);
    });
  });

  describe('trial, plans and entitlements', () => {
    it('starts every new business on a trial with free AI credits that cannot be withdrawn', async () => {
      const { owner, orgId } = await newOrg();
      const s = await summary(owner, orgId);
      expect(s.subscription.status).toBe('trialing');
      expect(s.subscription.plan.code).toBe('all-in-one');
      expect(Date.parse(s.subscription.trialEndsAt!) - Date.now()).toBeGreaterThan(13.9 * DAY);
      expect(s.subscription.entitlements.modules).toContain('ads');
      expect(s.wallet).toMatchObject({
        balanceMinor: 25_000,
        bonusMinor: 25_000,
        withdrawableMinor: 0,
      });
      expect(s.creditRate.creditPriceMinor).toBe(10);
      expect([...keysOf(s)].filter((k) => COST_KEYS.includes(k))).toEqual([]);
    });

    it('puts new businesses on the free plan when the super-admin turns trials off', async () => {
      await setSettings({ trial: { enabled: false } });
      try {
        const { owner, orgId } = await newOrg();
        const s = await summary(owner, orgId);
        expect(s.subscription).toMatchObject({ status: 'active', plan: { code: 'free' } });
        expect(s.subscription.entitlements.modules).toEqual(['inbox', 'commerce']);
        expect(s.wallet.balanceMinor).toBe(0);
      } finally {
        await setSettings({ trial: { enabled: true } });
      }
    });

    it('answers 402 for a module outside the plan, and honours super-admin overrides', async () => {
      await setSettings({ trial: { enabled: false } });
      const { owner, orgId } = await newOrg();
      await setSettings({ trial: { enabled: true } });
      const res = await app.as(owner.token).get(`/v1/orgs/${orgId}/probe/ads`).expect(402);
      expect(res.body).toMatchObject({
        code: 'module_not_in_plan',
        modules: ['ads'],
        planCode: 'free',
      });

      await P()
        .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
        .send({ addModules: ['ads'], note: 'pilot customer' })
        .expect(200);
      await app.as(owner.token).get(`/v1/orgs/${orgId}/probe/ads`).expect(200);

      const trial = await newOrg();
      await app.as(trial.owner.token).get(`/v1/orgs/${trial.orgId}/probe/ads`).expect(200);
    });

    it('buys a plan from wallet cash (never free credit), issues an invoice and refuses a duplicate', async () => {
      const { owner, orgId } = await newOrg();
      // Only free trial credit in the wallet: plans need cash.
      const poor = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'inbox', interval: 'month' })
        .expect(402);
      expect(poor.body).toMatchObject({
        code: 'insufficient_balance',
        availableMinor: 0,
        requiredMinor: 149_900,
      });

      await credit(orgId, 500_000).expect(200);
      const res = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'inbox', interval: 'month' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'active',
        plan: { code: 'inbox' },
        priceMinor: 149_900,
        autoRenew: true,
      });
      expect(res.body.entitlements.modules).toEqual(['inbox', 'ai_agent', 'analytics']);
      const end = Date.parse(res.body.currentPeriodEnd as string);
      expect(end - Date.now()).toBeGreaterThan(27 * DAY);

      const s = await summary(owner, orgId);
      // 525,000 - 149,900 plan - 25,000 unused trial credit expired + 3,000 included (300 credits)
      expect(s.wallet).toMatchObject({
        balanceMinor: 353_100,
        bonusMinor: 3_000,
        withdrawableMinor: 350_100,
      });

      const invoices = (
        await app.as(owner.token).get(`/v1/orgs/${orgId}/billing/invoices`).expect(200)
      ).body.items as { number: string; totalMinor: number; kind: string }[];
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ kind: 'subscription', totalMinor: 149_900 });
      expect(invoices[0]!.number).toMatch(/^INV-\d{4}-\d{6}$/);

      await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'inbox', interval: 'month' })
        .expect(409);

      // Switching mid-period refunds the unused part of the old plan.
      await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'commerce', interval: 'month' })
        .expect(200);
      const ledger = (
        await app
          .as(owner.token)
          .get(`/v1/orgs/${orgId}/billing/wallet/ledger?type=refund`)
          .expect(200)
      ).body.items as { amountMinor: number }[];
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.amountMinor).toBeGreaterThan(149_000);
      expect(ledger[0]!.amountMinor).toBeLessThanOrEqual(149_900);

      const reconcile = await inTenant(orgId, () => app.app.get(WalletService).reconcile());
      expect(reconcile.ok).toBe(true);
    });

    it('lets a sales agent see nothing of billing and an accountant only read it', async () => {
      const { owner, orgId } = await newOrg();
      const agent = await app.addMember(owner, orgId, 'sales_agent');
      await app.as(agent.token).get(`/v1/orgs/${orgId}/billing/summary`).expect(403);
      const accountant = await app.addMember(owner, orgId, 'accountant');
      await app.as(accountant.token).get(`/v1/orgs/${orgId}/billing/summary`).expect(200);
      await app
        .as(accountant.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'inbox', interval: 'month' })
        .expect(403);
      // Another business's owner cannot even see that it exists.
      const stranger = await newOrg();
      await app.as(stranger.owner.token).get(`/v1/orgs/${orgId}/billing/summary`).expect(404);
    });
  });

  describe('wallet integrity', () => {
    it('applies a platform top-up once per idempotency key', async () => {
      const { owner, orgId } = await newOrg();
      const first = await credit(orgId, 70_000, 'topup', 'bank-ref-0001').expect(200);
      const again = await credit(orgId, 70_000, 'topup', 'bank-ref-0001').expect(200);
      expect(first.body.applied).toBe(true);
      expect(again.body.applied).toBe(false);
      expect((await summary(owner, orgId)).wallet.balanceMinor).toBe(25_000 + 70_000);
    });

    it('never overspends under concurrent debits', async () => {
      await setSettings({ trial: { enabled: false } });
      const { orgId } = await newOrg();
      await setSettings({ trial: { enabled: true } });
      await credit(orgId, 10_000).expect(200);
      const wallet = app.app.get(WalletService);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          inTenant(orgId, () =>
            wallet.debit({
              type: 'ai_usage',
              amountMinor: 1_000,
              idempotencyKey: `race-${i}`,
              description: 'race',
              actor: { type: 'system', id: 'test' },
            }),
          ),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBe(10);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(
        failures.every((f) => (f.reason as { code?: string }).code === 'insufficient_balance'),
      ).toBe(true);
      const balance = await inTenant(orgId, () => wallet.balance());
      expect(balance.balanceMinor).toBe(0);
      expect((await inTenant(orgId, () => wallet.reconcile())).ok).toBe(true);
    });

    it('lets the platform freeze a wallet, which blocks spending', async () => {
      const { owner, orgId } = await newOrg();
      await credit(orgId, 400_000).expect(200);
      await P()
        .patch(`/v1/platform/billing/tenants/${orgId}/wallet/status`)
        .send({ status: 'frozen', note: 'chargeback review' })
        .expect(200);
      const res = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'inbox', interval: 'month' })
        .expect(403);
      expect(res.body.code).toBe('wallet_frozen');
      await P()
        .patch(`/v1/platform/billing/tenants/${orgId}/wallet/status`)
        .send({ status: 'active', note: 'cleared' })
        .expect(200);
      await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'inbox', interval: 'month' })
        .expect(200);
    });
  });

  describe('AI credit metering', () => {
    it('reserves the worst case, charges real tokens from free credit first, and records cost only for the platform', async () => {
      const { owner, orgId } = await newOrg();
      const credits = app.app.get(CreditsService);
      const reserved = await inTenant(orgId, () =>
        credits.reserve({
          requestId: 'req-1',
          feature: 'inbox_reply',
          tier: 'standard',
          estimatedInputTokens: 1_000,
          maxOutputTokens: 500,
        }),
      );
      expect(reserved.reservedMinor).toBe(210);
      expect((await summary(owner, orgId)).wallet).toMatchObject({
        heldMinor: 210,
        availableMinor: 25_000 - 210,
      });

      const settled = await inTenant(orgId, () =>
        credits.settle({
          requestId: 'req-1',
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          inputTokens: 800,
          outputTokens: 200,
        }),
      );
      expect(settled).toMatchObject({
        status: 'settled',
        credits: 10.8,
        billedMinor: 108,
        costUsdMicros: 3_600,
        costMinor: 44,
        shortfallMinor: 0,
      });
      // Settling twice changes nothing.
      await inTenant(orgId, () =>
        credits.settle({
          requestId: 'req-1',
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          inputTokens: 999_999,
          outputTokens: 999,
        }),
      );
      expect((await summary(owner, orgId)).wallet).toMatchObject({
        balanceMinor: 25_000 - 108,
        bonusMinor: 25_000 - 108,
        heldMinor: 0,
      });

      // A failed call releases its hold without charging.
      await inTenant(orgId, () =>
        credits.reserve({
          requestId: 'req-2',
          feature: 'seo_keywords',
          tier: 'fast',
          estimatedInputTokens: 500,
          maxOutputTokens: 100,
        }),
      );
      const released = await inTenant(orgId, () => credits.release('req-2'));
      expect(released?.status).toBe('released');
      expect((await summary(owner, orgId)).wallet.heldMinor).toBe(0);

      const usage = (
        await app.as(owner.token).get(`/v1/orgs/${orgId}/billing/ai-usage/requests`).expect(200)
      ).body as { items: unknown[] };
      expect(usage.items).toHaveLength(1);
      expect([...keysOf(usage)].filter((k) => COST_KEYS.includes(k))).toEqual([]);
      const daily = (
        await app.as(owner.token).get(`/v1/orgs/${orgId}/billing/ai-usage`).expect(200)
      ).body as { totals: { credits: number; chargedMinor: number; requests: number } };
      expect(daily.totals).toEqual({ credits: 10.8, chargedMinor: 108, requests: 1 });

      const ledger = (
        await app
          .as(owner.token)
          .get(`/v1/orgs/${orgId}/billing/wallet/ledger?type=ai_usage`)
          .expect(200)
      ).body.items as { amountMinor: number; credits: number }[];
      expect(ledger).toEqual([expect.objectContaining({ amountMinor: -108, credits: 10.8 })]);

      const profit = (
        await P().get(`/v1/platform/billing/ai-profit?groupBy=model&orgId=${orgId}`).expect(200)
      ).body as { rows: Record<string, unknown>[] };
      expect(profit.rows).toEqual([
        expect.objectContaining({
          key: 'anthropic/claude-sonnet-5-5',
          currency: 'BDT',
          requests: 1,
          collectedMinor: 108,
          costMinor: 44,
          profitMinor: 64,
        }),
      ]);
      const byOrg = (
        await P().get(`/v1/platform/billing/ai-profit?groupBy=org&orgId=${orgId}`).expect(200)
      ).body as { rows: { label: string }[] };
      expect(byOrg.rows[0]!.label).toMatch(/^Shop /);
      const byDay = (
        await P().get(`/v1/platform/billing/ai-profit?groupBy=day&orgId=${orgId}`).expect(200)
      ).body as { timezone: string; rows: { key: string }[] };
      // Days are cut in the configured report time zone, and the response says which one.
      expect(byDay.timezone).toBe('Asia/Dhaka');
      expect(byDay.rows[0]!.key).toBe(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()),
      );
    });

    it('refuses to start a call the wallet cannot cover, and records a shortfall instead of failing a finished call', async () => {
      await setSettings({ trial: { enabled: false } });
      const { orgId } = await newOrg();
      await setSettings({ trial: { enabled: true } });
      const credits = app.app.get(CreditsService);
      await credit(orgId, 150).expect(200);

      await expect(
        inTenant(orgId, () =>
          credits.reserve({
            requestId: 'big',
            feature: 'inbox_reply',
            tier: 'advanced',
            estimatedInputTokens: 10_000,
            maxOutputTokens: 4_000,
          }),
        ),
      ).rejects.toMatchObject({ code: 'insufficient_balance' });

      await inTenant(orgId, () =>
        credits.reserve({
          requestId: 'small',
          feature: 'inbox_reply',
          tier: 'fast',
          estimatedInputTokens: 1_000,
          maxOutputTokens: 100,
        }),
      );
      const settled = await inTenant(orgId, () =>
        credits.settle({
          requestId: 'small',
          provider: 'anthropic',
          model: 'claude-haiku-5-5',
          inputTokens: 20_000,
          outputTokens: 2_000,
        }),
      );
      expect(settled).toMatchObject({ billedMinor: 600, shortfallMinor: 450 });
      const balance = await inTenant(orgId, () => app.app.get(WalletService).balance());
      expect(balance).toMatchObject({ balanceMinor: 0, heldMinor: 0 });
    });

    it('releases reservations a crashed call left behind', async () => {
      const { owner, orgId } = await newOrg();
      const credits = app.app.get(CreditsService);
      await inTenant(orgId, () =>
        credits.reserve({
          requestId: 'orphan',
          feature: 'inbox_reply',
          tier: 'fast',
          estimatedInputTokens: 100,
          maxOutputTokens: 100,
        }),
      );
      await app.db
        .db!.collection('ai_usage')
        .updateOne(
          { requestId: 'orphan', orgId: new Types.ObjectId(orgId) },
          { $set: { createdAt: new Date(Date.now() - 2 * 3600_000) } },
        );
      const result = await app.app.get(BillingJobsService).releaseStaleReservations();
      expect(result.released).toBeGreaterThanOrEqual(1);
      expect((await summary(owner, orgId)).wallet.heldMinor).toBe(0);
    });
  });

  describe('renewals and trial end', () => {
    it('renews from the wallet, goes past due when it cannot, and drops to free after the grace period', async () => {
      const { owner, orgId } = await newOrg();
      await credit(orgId, 300_000).expect(200);
      await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription`)
        .send({ planCode: 'inbox', interval: 'month' })
        .expect(200);
      const jobs = app.app.get(BillingJobsService);

      const end1 = new Date(Date.now() - 60_000);
      await app.db
        .db!.collection('subscriptions')
        .updateOne({ orgId: new Types.ObjectId(orgId) }, { $set: { currentPeriodEnd: end1 } });
      await jobs.runRenewals();
      const renewed = await subDoc(orgId);
      expect(renewed).toMatchObject({ status: 'active', planCode: 'inbox' });
      expect((renewed!.currentPeriodStart as Date).getTime()).toBe(end1.getTime());
      const invoices = (
        await app.as(owner.token).get(`/v1/orgs/${orgId}/billing/invoices`).expect(200)
      ).body.items as unknown[];
      expect(invoices).toHaveLength(2);

      // Empty the cash, then let the period end again.
      const cash = (await summary(owner, orgId)).wallet.withdrawableMinor;
      await P()
        .post(`/v1/platform/billing/tenants/${orgId}/wallet/adjust`)
        .send({
          direction: 'debit',
          type: 'adjustment',
          amountMinor: cash,
          note: 'test drain',
          idempotencyKey: `drain-${orgId}`,
        })
        .expect(200);
      await app.db
        .db!.collection('subscriptions')
        .updateOne(
          { orgId: new Types.ObjectId(orgId) },
          { $set: { currentPeriodEnd: new Date(Date.now() - 60_000) } },
        );
      await jobs.runRenewals();
      expect(await subDoc(orgId)).toMatchObject({ status: 'past_due' });
      const grace = await summary(owner, orgId);
      expect(grace.subscription.entitlements).toMatchObject({
        paidAccess: true,
        inGracePeriod: true,
      });

      await app.db
        .db!.collection('subscriptions')
        .updateOne(
          { orgId: new Types.ObjectId(orgId) },
          { $set: { currentPeriodEnd: new Date(Date.now() - 4 * DAY) } },
        );
      await jobs.runRenewals();
      const after = await summary(owner, orgId);
      expect(after.subscription).toMatchObject({ status: 'active', plan: { code: 'free' } });
      expect(after.subscription.entitlements.modules).toEqual(['inbox', 'commerce']);
    });

    it('moves an ended trial to the free plan and expires the unused trial credit', async () => {
      const { owner, orgId } = await newOrg();
      const past = new Date(Date.now() - 60_000);
      await app.db
        .db!.collection('subscriptions')
        .updateOne(
          { orgId: new Types.ObjectId(orgId) },
          { $set: { trialEndsAt: past, currentPeriodEnd: past } },
        );
      // Access ends on time even before the job runs.
      await app.redis.del(`ent:${orgId}`);
      expect((await summary(owner, orgId)).subscription.entitlements.paidAccess).toBe(false);
      await app.app.get(BillingJobsService).runRenewals();
      const s = await summary(owner, orgId);
      expect(s.subscription).toMatchObject({ status: 'active', plan: { code: 'free' } });
      expect(s.wallet).toMatchObject({ balanceMinor: 0, bonusMinor: 0 });
    });

    it('lets the platform extend a trial and give a plan without payment', async () => {
      const { owner, orgId } = await newOrg();
      const before = Date.parse((await summary(owner, orgId)).subscription.trialEndsAt!);
      await P()
        .post(`/v1/platform/billing/tenants/${orgId}/subscription/extend-trial`)
        .send({ days: 7, note: 'asked nicely' })
        .expect(200);
      const extended = Date.parse((await summary(owner, orgId)).subscription.trialEndsAt!);
      expect(extended - before).toBeGreaterThan(6.99 * DAY);

      await P()
        .put(`/v1/platform/billing/tenants/${orgId}/subscription`)
        .send({ planCode: 'growth', interval: 'year', note: 'partner deal' })
        .expect(200);
      const s = await summary(owner, orgId);
      expect(s.subscription).toMatchObject({ status: 'active', plan: { code: 'growth' } });
      expect(Date.parse(s.subscription.currentPeriodEnd!) - Date.now()).toBeGreaterThan(360 * DAY);
    });
  });

  describe('payments', () => {
    it('takes manual bKash/bank transfers for review, once per transaction id', async () => {
      await P()
        .put('/v1/platform/billing/gateways/manual')
        .send({
          enabled: true,
          credentials: {
            instructions: 'Send money to our bKash merchant number',
            accounts: [{ method: 'bkash', label: 'Sellora', account: '01711000000' }],
          },
        })
        .expect(200);
      const gateways = (await P().get('/v1/platform/billing/gateways').expect(200)).body as {
        key: string;
        publicConfig: { accounts: unknown[] } | null;
        webhookUrl: string | null;
      }[];
      // The admin panel sees the manual instructions it set, so it can edit them.
      expect(gateways.find((g) => g.key === 'manual')?.publicConfig?.accounts).toHaveLength(1);
      // It also shows the notification address to paste into each gateway's dashboard.
      expect(gateways.find((g) => g.key === 'stripe')?.webhookUrl).toMatch(
        /\/v1\/payments\/stripe\/webhook$/,
      );
      expect(gateways.find((g) => g.key === 'sslcommerz')?.webhookUrl).toMatch(
        /\/v1\/payments\/sslcommerz\/ipn$/,
      );
      expect(gateways.find((g) => g.key === 'manual')?.webhookUrl).toBeNull();
      const { owner, orgId } = await newOrg();
      const methods = (
        await app.as(owner.token).get(`/v1/orgs/${orgId}/billing/payment-methods`).expect(200)
      ).body as { manual: { accounts: unknown[] } };
      expect(methods.manual.accounts).toHaveLength(1);

      const body = {
        amountMinor: 100_000,
        method: 'bkash',
        senderAccount: '01811000000',
        transactionRef: `TRX${orgId.slice(-8)}`,
      };
      const submitted = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/manual-topups`)
        .send(body)
        .expect(201);
      expect(submitted.body.status).toBe('pending');
      const dup = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/manual-topups`)
        .send(body)
        .expect(409);
      expect(dup.body.code).toBe('transfer_already_reported');

      const queue = (
        await P().get('/v1/platform/billing/payments?status=pending&gateway=manual').expect(200)
      ).body.items as { id: string }[];
      expect(queue.map((p) => p.id)).toContain(submitted.body.id);
      await P()
        .post(`/v1/platform/billing/payments/${submitted.body.id}/approve`)
        .send({ note: 'seen in statement' })
        .expect(200);
      await P()
        .post(`/v1/platform/billing/payments/${submitted.body.id}/approve`)
        .send({})
        .expect(409);
      expect((await summary(owner, orgId)).wallet.balanceMinor).toBe(25_000 + 100_000);
      const invoices = (
        await app.as(owner.token).get(`/v1/orgs/${orgId}/billing/invoices`).expect(200)
      ).body.items as { kind: string }[];
      expect(invoices.map((i) => i.kind)).toEqual(['wallet_topup']);
    });

    it('credits an SSLCommerz payment only after the validation API confirms the exact amount', async () => {
      await P()
        .put('/v1/platform/billing/gateways/sslcommerz')
        .send({
          enabled: true,
          sandbox: true,
          credentials: { storeId: 'teststore', storePassword: 'store-secret-pass' },
        })
        .expect(200);
      const list = await P().get('/v1/platform/billing/gateways').expect(200);
      expect(JSON.stringify(list.body)).not.toContain('store-secret-pass');
      expect(
        (list.body as { key: string; publicConfig: unknown }[]).find((g) => g.key === 'sslcommerz')
          ?.publicConfig,
      ).toBeNull();

      const { owner, orgId } = await newOrg();
      const pay = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/topups`)
        .send({ amountMinor: 50_000, gateway: 'sslcommerz' })
        .expect(201);
      expect(pay.body.checkoutUrl).toContain('sandbox.sslcommerz.com');
      expect(fake.sslSessions.get(pay.body.id as string)).toEqual({
        amount: '500.00',
        currency: 'BDT',
      });

      // A forged browser "success" without a validation id moves nothing.
      await app
        .http()
        .post(`/v1/payments/sslcommerz/return/${pay.body.id}/success`)
        .type('form')
        .send({ status: 'VALID' })
        .expect(303);
      expect((await summary(owner, orgId)).wallet.balanceMinor).toBe(25_000);

      fake.sslValidations.set('VAL-OK', {
        status: 'VALID',
        tran_id: pay.body.id as string,
        amount: '500.00',
        currency: 'BDT',
        bank_tran_id: 'BANK-1',
      });
      await app
        .http()
        .post('/v1/payments/sslcommerz/ipn')
        .type('form')
        .send({ tran_id: pay.body.id, val_id: 'VAL-OK', status: 'VALID' })
        .expect(200);
      await app
        .http()
        .post('/v1/payments/sslcommerz/ipn')
        .type('form')
        .send({ tran_id: pay.body.id, val_id: 'VAL-OK', status: 'VALID' })
        .expect(200);
      const ret = await app
        .http()
        .post(`/v1/payments/sslcommerz/return/${pay.body.id}/success`)
        .type('form')
        .send({ val_id: 'VAL-OK' })
        .expect(303);
      expect(ret.headers.location).toContain('status=succeeded');
      expect((await summary(owner, orgId)).wallet.balanceMinor).toBe(75_000);
      const payment = (
        await app
          .as(owner.token)
          .get(`/v1/orgs/${orgId}/billing/payments/${pay.body.id}`)
          .expect(200)
      ).body;
      expect(payment).toMatchObject({ status: 'succeeded', gatewayRef: 'BANK-1' });

      // A validation for less money than asked fails the payment and credits nothing.
      const short = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/topups`)
        .send({ amountMinor: 60_000, gateway: 'sslcommerz' })
        .expect(201);
      fake.sslValidations.set('VAL-SHORT', {
        status: 'VALID',
        tran_id: short.body.id as string,
        amount: '50.00',
        currency: 'BDT',
      });
      await app
        .http()
        .post('/v1/payments/sslcommerz/ipn')
        .type('form')
        .send({ tran_id: short.body.id, val_id: 'VAL-SHORT' })
        .expect(200);
      expect(
        (
          await app
            .as(owner.token)
            .get(`/v1/orgs/${orgId}/billing/payments/${short.body.id}`)
            .expect(200)
        ).body,
      ).toMatchObject({ status: 'failed', failureReason: 'amount_mismatch' });

      // Someone else's validation id cannot pay for this payment.
      const other = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/topups`)
        .send({ amountMinor: 50_000, gateway: 'sslcommerz' })
        .expect(201);
      await app
        .http()
        .post('/v1/payments/sslcommerz/ipn')
        .type('form')
        .send({ tran_id: other.body.id, val_id: 'VAL-OK' })
        .expect(200);
      expect(
        (
          await app
            .as(owner.token)
            .get(`/v1/orgs/${orgId}/billing/payments/${other.body.id}`)
            .expect(200)
        ).body.status,
      ).toBe('pending');
      expect((await summary(owner, orgId)).wallet.balanceMinor).toBe(75_000);

      // Gateway outage: the payment is marked failed and the caller gets 502.
      fake.failNextCheckout = true;
      const down = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/topups`)
        .send({ amountMinor: 50_000, gateway: 'sslcommerz' })
        .expect(502);
      expect(down.body.code).toBe('gateway_error');

      // The platform's owners hear of failed payments; without Telegram, by email (ADR 0022).
      // Repeats within 30 minutes are grouped, so the mismatch above and the outage make one.
      let alerts: { subject: string; text: string }[] = [];
      // The alert is sent after the request answers; under a full parallel run it can take seconds.
      for (let i = 0; i < 200 && !alerts.length; i++) {
        alerts = (await app.outbox(platformEmail)).filter((m) => m.category === 'platform.alert');
        if (!alerts.length) await new Promise((r) => setTimeout(r, 50));
      }
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.subject).toBe('Sellora alert: A payment failed');
      expect(alerts[0]!.text).toContain('through sslcommerz');
    });

    it('completes bKash payments through execute, and rejects a mismatched paymentID', async () => {
      await P()
        .put('/v1/platform/billing/gateways/bkash')
        .send({
          enabled: true,
          sandbox: true,
          credentials: {
            appKey: 'app-key',
            appSecret: 'app-secret',
            username: 'sandbox-user',
            password: 'sandbox-pass',
          },
        })
        .expect(200);
      const { owner, orgId } = await newOrg();
      const pay = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/topups`)
        .send({ amountMinor: 20_000, gateway: 'bkash' })
        .expect(201);
      expect(pay.body.checkoutUrl).toContain('bkash.com');

      const wrong = await app
        .http()
        .get(`/v1/payments/bkash/callback/${pay.body.id}?paymentID=BKsomeoneelse&status=success`)
        .expect(302);
      expect(wrong.headers.location).toContain('status=failed');
      expect((await summary(owner, orgId)).wallet.balanceMinor).toBe(25_000);

      const pay2 = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/topups`)
        .send({ amountMinor: 20_000, gateway: 'bkash' })
        .expect(201);
      const ok = await app
        .http()
        .get(
          `/v1/payments/bkash/callback/${pay2.body.id}?paymentID=BK${pay2.body.id}&status=success`,
        )
        .expect(302);
      expect(ok.headers.location).toContain('status=succeeded');
      expect((await summary(owner, orgId)).wallet.balanceMinor).toBe(45_000);

      const pay3 = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/wallet/topups`)
        .send({ amountMinor: 20_000, gateway: 'bkash' })
        .expect(201);
      const cancel = await app
        .http()
        .get(
          `/v1/payments/bkash/callback/${pay3.body.id}?paymentID=BK${pay3.body.id}&status=cancel`,
        )
        .expect(302);
      expect(cancel.headers.location).toContain('status=canceled');
    });

    it('trusts Stripe only through signed webhooks and can buy a plan through a gateway', async () => {
      const webhookSecret = 'whsec_test_123456';
      await P()
        .put('/v1/platform/billing/gateways/stripe')
        .send({
          enabled: true,
          sandbox: true,
          credentials: { secretKey: 'sk_test_abc', webhookSecret },
        })
        .expect(200);
      const { owner, orgId } = await newOrg();
      const pay = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/subscription/checkout`)
        .send({ planCode: 'inbox', interval: 'month', gateway: 'stripe' })
        .expect(201);
      expect(pay.body).toMatchObject({
        purpose: 'subscription',
        amountMinor: 149_900,
        plan: { code: 'inbox', interval: 'month' },
      });

      const event = JSON.stringify({
        id: 'evt_test_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_test_${pay.body.id}`,
            client_reference_id: pay.body.id,
            payment_status: 'paid',
            amount_total: 149_900,
            currency: 'bdt',
            payment_intent: 'pi_test_1',
          },
        },
      });
      const t = Math.floor(Date.now() / 1000);
      const sig = (secret: string) =>
        `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${event}`).digest('hex')}`;

      const bad = await app
        .http()
        .post('/v1/payments/stripe/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', sig('whsec_wrong'))
        .send(event)
        .expect(400);
      expect(bad.body.code).toBe('invalid_signature');
      expect((await summary(owner, orgId)).subscription.status).toBe('trialing');

      await app
        .http()
        .post('/v1/payments/stripe/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', sig(webhookSecret))
        .send(event)
        .expect(200);
      const s = await summary(owner, orgId);
      expect(s.subscription).toMatchObject({ status: 'active', plan: { code: 'inbox' } });
      // Paid 149,900 in, plan took 149,900; trial credit expired, 300 included credits granted.
      expect(s.wallet).toMatchObject({ balanceMinor: 3_000, bonusMinor: 3_000 });
    });
  });

  describe('withdrawals', () => {
    it('stay off until enabled, hold cash only, and leave the wallet only when paid', async () => {
      const { owner, orgId } = await newOrg();
      await credit(orgId, 100_000).expect(200);
      const off = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/withdrawals`)
        .send({ amountMinor: 10_000, method: 'bkash', destination: '01711000000' })
        .expect(403);
      expect(off.body.code).toBe('withdrawals_disabled');

      await setSettings({ billing: { withdrawalsEnabled: true } });
      try {
        // 125,000 balance, but 25,000 is free trial credit.
        await app
          .as(owner.token)
          .post(`/v1/orgs/${orgId}/billing/withdrawals`)
          .send({ amountMinor: 110_000, method: 'bkash', destination: '01711000000' })
          .expect(402);
        const w = await app
          .as(owner.token)
          .post(`/v1/orgs/${orgId}/billing/withdrawals`)
          .send({ amountMinor: 40_000, method: 'bkash', destination: '01711000000' })
          .expect(201);
        expect((await summary(owner, orgId)).wallet).toMatchObject({
          heldMinor: 40_000,
          withdrawableMinor: 60_000,
        });

        await P()
          .post(`/v1/platform/billing/withdrawals/${w.body.id}/paid`)
          .send({ payoutRef: 'BK-PAYOUT-1' })
          .expect(409);
        await P()
          .post(`/v1/platform/billing/withdrawals/${w.body.id}/approve`)
          .send({ note: 'ok' })
          .expect(200);
        await P()
          .post(`/v1/platform/billing/withdrawals/${w.body.id}/paid`)
          .send({ payoutRef: 'BK-PAYOUT-1' })
          .expect(200);
        expect((await summary(owner, orgId)).wallet).toMatchObject({
          balanceMinor: 85_000,
          heldMinor: 0,
          bonusMinor: 25_000,
        });

        const w2 = await app
          .as(owner.token)
          .post(`/v1/orgs/${orgId}/billing/withdrawals`)
          .send({ amountMinor: 10_000, method: 'nagad', destination: '01911000000' })
          .expect(201);
        await P()
          .post(`/v1/platform/billing/withdrawals/${w2.body.id}/reject`)
          .send({ note: 'use refund instead' })
          .expect(200);
        const w3 = await app
          .as(owner.token)
          .post(`/v1/orgs/${orgId}/billing/withdrawals`)
          .send({ amountMinor: 5_000, method: 'bank', destination: 'DBBL 123' })
          .expect(201);
        await app
          .as(owner.token)
          .post(`/v1/orgs/${orgId}/billing/withdrawals/${w3.body.id}/cancel`)
          .expect(200);
        expect((await summary(owner, orgId)).wallet).toMatchObject({
          balanceMinor: 85_000,
          heldMinor: 0,
        });
        expect((await inTenant(orgId, () => app.app.get(WalletService).reconcile())).ok).toBe(true);
      } finally {
        await setSettings({ billing: { withdrawalsEnabled: false } });
      }
    });
  });

  describe('super-admin controls', () => {
    it('shows revenue, wallets, AI profit and queues, and keeps merchants out', async () => {
      const overview = (await P().get('/v1/platform/billing/overview').expect(200)).body as {
        ai: { currency: string; profitMinor: number }[];
        wallets: { currency: string }[];
        queues: Record<string, number>;
        mrr: { mrrMinor: number }[];
      };
      expect(overview.ai.find((a) => a.currency === 'BDT')).toBeDefined();
      expect(overview.wallets.find((w) => w.currency === 'BDT')).toBeDefined();
      expect(overview.queues).toHaveProperty('pendingManualPayments');
      expect(overview.mrr.reduce((a, r) => a + r.mrrMinor, 0)).toBeGreaterThan(0);

      const { owner, orgId } = await newOrg();
      await app.as(owner.token).get('/v1/platform/billing/overview').expect(401);
      const detail = (await P().get(`/v1/platform/billing/tenants/${orgId}`).expect(200)).body as {
        wallet: { reconciled: boolean };
        subscription: { status: string };
      };
      expect(detail).toMatchObject({
        wallet: { reconciled: true },
        subscription: { status: 'trialing' },
      });
    });

    it('edits plans and publishes a new credit price list that applies to new usage', async () => {
      const catalogue = (await P().get('/v1/platform/billing/modules').expect(200)).body as {
        modules: { key: string; name: string }[];
        limits: string[];
      };
      expect(catalogue.modules.map((m) => m.key)).toContain('ai_agent');
      expect(catalogue.limits).toContain('seats');
      const created = await P()
        .post('/v1/platform/billing/plans')
        .send({
          code: 'starter',
          name: 'Starter',
          modules: ['inbox', 'ai_agent'],
          limits: { seats: 2 },
          prices: [{ interval: 'month', currency: 'BDT', amountMinor: 99_900 }],
          includedCreditsPerMonth: 100,
          sortOrder: 5,
        })
        .expect(201);
      expect(created.body).toMatchObject({ code: 'starter', version: 1 });
      await P()
        .post('/v1/platform/billing/plans')
        .send({ code: 'starter', name: 'Again', modules: [], prices: [] })
        .expect(409);
      await P()
        .patch('/v1/platform/billing/plans/starter')
        .send({
          prices: [
            { interval: 'month', currency: 'BDT', amountMinor: 1 },
            { interval: 'month', currency: 'BDT', amountMinor: 2 },
          ],
        })
        .expect(422);
      const updated = await P()
        .patch('/v1/platform/billing/plans/starter')
        .send({ prices: [{ interval: 'month', currency: 'BDT', amountMinor: 89_900 }] })
        .expect(200);
      expect(updated.body).toMatchObject({ version: 2, prices: [{ amountMinor: 89_900 }] });
      // Fields the edit left out keep their values (they are not reset to the defaults).
      expect(updated.body).toMatchObject({
        includedCreditsPerMonth: 100,
        sortOrder: 5,
        isActive: true,
        limits: expect.objectContaining({ seats: 2 }),
      });
      const pub = (await app.http().get('/v1/public/plans').expect(200)).body as { code: string }[];
      expect(pub[0]!.code).toBe('free');
      expect(pub.map((p) => p.code)).toContain('starter');

      const rate = await P()
        .post('/v1/platform/billing/credit-rates')
        .send({
          currency: 'BDT',
          creditPriceMinor: 12,
          minimumCreditsPerRequest: 1,
          usdRate: 123.5,
          tiers: [
            { tier: 'fast', inputCreditsPer1k: 2.5, outputCreditsPer1k: 10 },
            { tier: 'standard', inputCreditsPer1k: 6, outputCreditsPer1k: 30 },
            { tier: 'advanced', inputCreditsPer1k: 10, outputCreditsPer1k: 50 },
          ],
        })
        .expect(201);
      expect(rate.body).toMatchObject({ version: 2, usdRate: 123.5, creditPriceMinor: 12 });

      const { owner, orgId } = await newOrg();
      expect((await summary(owner, orgId)).creditRate).toMatchObject({
        version: 2,
        creditPriceMinor: 12,
      });
      const quote = await app
        .as(owner.token)
        .post(`/v1/orgs/${orgId}/billing/ai-usage/quote`)
        .send({ tier: 'fast', inputTokens: 1_000, outputTokens: 1_000 })
        .expect(200);
      expect(quote.body).toMatchObject({ credits: 12.5, amountMinor: 150, rateVersion: 2 });
    });
  });
});
