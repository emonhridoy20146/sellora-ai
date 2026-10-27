/**
 * Fills a development database with a realistic demo so the dashboards have something to
 * show: a fashion shop with staff, a pending invitation, wallet money, AI usage across two
 * weeks, a manual payment waiting for review, and a platform owner.
 *
 * Usage: npm run dev:seed
 * Refuses to run when NODE_ENV=production. Safe to re-run: it skips what already exists.
 * Never use these accounts or passwords outside your own machine.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { AppModule } from '../src/app.module.js';
import { RequestContext } from '../src/common/context/request-context.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { CreditsService } from '../src/modules/billing/credits.service.js';
import { WalletService } from '../src/modules/billing/wallet.service.js';
import { OrgsService } from '../src/modules/orgs/orgs.service.js';
import { PlatformAdminsService } from '../src/modules/platform/platform-admins.service.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:seed never runs in production.');
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD ?? 'sellora demo password';
const OWNER = { name: 'Emon Hridoy', email: 'owner@demo.sellora.test' };
const STAFF = [
  { name: 'Nusrat Jahan', email: 'manager@demo.sellora.test', role: 'manager' },
  { name: 'Rakib Hasan', email: 'agent@demo.sellora.test', role: 'sales_agent' },
  { name: 'Tania Akter', email: 'packing@demo.sellora.test', role: 'fulfillment' },
];

const app = await NestFactory.createApplicationContext(AppModule.forRoot(), {
  logger: ['error', 'warn'],
});
const db = app.get<Connection>(getConnectionToken());
const users = db.model('User');
const client = { ip: '127.0.0.1', userAgent: 'dev-seed' };

async function ensureUser(name: string, email: string): Promise<string> {
  const existing = await users
    .findOne({ email }, { _id: 1 })
    .lean<{ _id: Types.ObjectId }>()
    .exec();
  if (!existing) {
    await app.get(AuthService).signup({ name, email, password: PASSWORD, locale: 'en' }, client);
  }
  await users.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } }).exec();
  const user = await users.findOne({ email }, { _id: 1 }).lean<{ _id: Types.ObjectId }>().exec();
  return user!._id.toHexString();
}

try {
  const ownerId = await ensureUser(OWNER.name, OWNER.email);
  const orgModel = db.model('Organization');
  let org = await orgModel
    .findOne({ ownerUserId: new Types.ObjectId(ownerId) })
    .lean<{ _id: Types.ObjectId; slug: string }>()
    .exec();
  if (!org) {
    const created = await RequestContext.run(
      { requestId: 'seed', actor: { type: 'user', id: ownerId } },
      () =>
        app.get(OrgsService).create(ownerId, {
          name: 'Dhaka Fashion House',
          category: 'fashion',
          country: 'BD',
          currency: 'BDT',
          timezone: 'Asia/Dhaka',
          locale: 'en',
          phone: '+8801711000000',
        }),
    );
    org = { _id: created._id, slug: created.slug };
  }
  const orgId = org._id.toHexString();

  await RequestContext.withTenant(orgId, async () => {
    const memberships = db.model('Membership');
    for (const s of STAFF) {
      const userId = await ensureUser(s.name, s.email);
      await memberships
        .updateOne(
          { orgId: org._id, userId: new Types.ObjectId(userId) },
          {
            $setOnInsert: {
              orgId: org._id,
              userId: new Types.ObjectId(userId),
              roleKey: s.role,
              status: 'active',
              invitedBy: new Types.ObjectId(ownerId),
              joinedAt: new Date(),
            },
          },
          { upsert: true },
        )
        .exec();
    }

    const wallet = app.get(WalletService);
    await wallet.credit({
      type: 'topup',
      amountMinor: 500_000,
      idempotencyKey: 'seed-topup-1',
      description: 'Top-up via bkash',
      actor: { type: 'system', id: 'seed' },
    });

    // Two weeks of AI replies so the usage and profit screens have shape.
    const credits = app.get(CreditsService);
    const usage = db.model('AiUsage');
    const tiers = [
      { tier: 'fast' as const, model: 'claude-haiku-5-5', feature: 'inbox_reply' },
      { tier: 'standard' as const, model: 'claude-sonnet-5-5', feature: 'inbox_reply' },
      { tier: 'standard' as const, model: 'claude-sonnet-5-5', feature: 'product_description' },
      { tier: 'advanced' as const, model: 'claude-opus-5-5', feature: 'seo_keywords' },
    ];
    let n = 0;
    for (let day = 13; day >= 0; day--) {
      const perDay = 6 + ((day * 7) % 9);
      for (let i = 0; i < perDay; i++) {
        n += 1;
        const requestId = `seed-${n}`;
        if (await usage.exists({ orgId: org._id, requestId })) continue;
        const t = tiers[(day + i) % tiers.length]!;
        await credits.reserve({
          requestId,
          feature: t.feature,
          tier: t.tier,
          estimatedInputTokens: 3_000,
          maxOutputTokens: 600,
        });
        await credits.settle({
          requestId,
          provider: 'anthropic',
          model: t.model,
          inputTokens: 900 + ((i * 337) % 2_200),
          outputTokens: 120 + ((i * 97) % 380),
          cachedInputTokens: i % 3 === 0 ? 1_200 : 0,
        });
        const at = new Date(Date.now() - day * 24 * 3600_000 - i * 1800_000);
        await usage
          .updateOne({ orgId: org._id, requestId }, { $set: { createdAt: at, settledAt: at } })
          .exec();
      }
    }
  });

  // One manual bKash payment waiting for the super-admin.
  const payments = db.model('Payment');
  await RequestContext.withTenant(orgId, () =>
    payments
      .updateOne(
        { orgId: org._id, idempotencyKey: 'manual:bkash:SEED8K2Q9X' },
        {
          $setOnInsert: {
            orgId: org._id,
            purpose: 'wallet_topup',
            amountMinor: 200_000,
            currency: 'BDT',
            gateway: 'manual',
            status: 'pending',
            idempotencyKey: 'manual:bkash:SEED8K2Q9X',
            manual: { method: 'bkash', senderAccount: '01811000000', transactionRef: 'SEED8K2Q9X' },
            createdBy: new Types.ObjectId(ownerId),
            events: [{ at: new Date(), type: 'submitted', data: {} }],
          },
        },
        { upsert: true },
      )
      .exec(),
  );

  const platformUsers = await db.model('PlatformUser').countDocuments({}).exec();
  let platformNote = 'Platform owner already exists; sign in at /admin/login.';
  if (platformUsers === 0) {
    const { setupUrl } = await app
      .get(PlatformAdminsService)
      .bootstrapOwner('admin@demo.sellora.test', 'Platform Owner');
    platformNote = `Finish the platform owner account (password + 2FA) within 24 hours:\n  ${setupUrl}`;
  }

  console.log(`
Demo data ready.
  Business:  Dhaka Fashion House (${orgId})
  Owner:     ${OWNER.email}
  Staff:     ${STAFF.map((s) => `${s.email} (${s.role})`).join(', ')}
  Password:  ${PASSWORD}   (all demo users)
  ${platformNote}
`);
} finally {
  await app.close();
}
