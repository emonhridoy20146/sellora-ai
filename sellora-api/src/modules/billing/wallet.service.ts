import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { Page } from '../../common/pagination/cursor.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import type { Organization } from '../orgs/schemas.js';
import type { LedgerEntry, LedgerType, Wallet } from './schemas.js';

export type WalletDoc = WithId<Wallet>;

/** Ledger types that count as spending (lifetime spend, low-balance alerts). */
const SPEND_TYPES = new Set<LedgerType>(['ai_usage', 'sms_usage', 'subscription']);

type Funding = 'bonus_first' | 'cash_only' | 'cash_first' | 'bonus_only';

/** Which part of the balance pays for each kind of debit. Free credit is for AI only. */
const FUNDING: Record<LedgerType, Funding> = {
  ai_usage: 'bonus_first',
  sms_usage: 'cash_only',
  subscription: 'cash_only',
  withdrawal: 'cash_only',
  adjustment: 'cash_first',
  refund: 'cash_first',
  topup: 'cash_first',
  bonus: 'bonus_only',
};
export type LedgerDoc = WithId<LedgerEntry>;

@Injectable()
export class WalletRepository extends TenantScopedRepository<Wallet> {
  constructor(@InjectModel('Wallet') model: Model<Wallet>) {
    super(model);
  }
}

@Injectable()
export class LedgerRepository extends TenantScopedRepository<LedgerEntry> {
  constructor(@InjectModel('LedgerEntry') model: Model<LedgerEntry>) {
    super(model);
  }
}

export interface MovementInput {
  type: LedgerType;
  amountMinor: number;
  idempotencyKey: string;
  description: string;
  reference?: { type: string; id: string };
  credits?: number;
  metadata?: Record<string, unknown>;
  actor?: { type: string; id: string };
}

export interface WalletBalance {
  currency: string;
  balanceMinor: number;
  heldMinor: number;
  availableMinor: number;
  bonusMinor: number;
  withdrawableMinor: number;
  status: 'active' | 'frozen';
  lifetimeTopupMinor: number;
  lifetimeSpentMinor: number;
}

export function toBalance(w: Wallet): WalletBalance {
  return {
    currency: w.currency,
    balanceMinor: w.balanceMinor,
    heldMinor: w.heldMinor,
    availableMinor: w.balanceMinor - w.heldMinor,
    bonusMinor: w.bonusMinor,
    withdrawableMinor: Math.max(0, w.balanceMinor - w.heldMinor - w.bonusMinor),
    status: w.status,
    lifetimeTopupMinor: w.lifetimeTopupMinor,
    lifetimeSpentMinor: w.lifetimeSpentMinor,
  };
}

/**
 * The prepaid wallet. Every change is an atomic conditional update on the wallet plus one
 * append-only ledger entry, in the same transaction, keyed by an idempotency key so a
 * retried payment callback or AI settlement can never apply twice.
 *
 * Must run inside a tenant scope (RequestContext.withTenant or an @OrgScoped route).
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly tx: TransactionService,
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
  ) {}

  async get(): Promise<WalletDoc> {
    const existing = await this.wallets.findOne({});
    if (existing) return existing;
    const tenant = RequestContext.tenant()!;
    const org = await this.orgs.findById(tenant.orgId, { currency: 1 }).lean().exec();
    try {
      return await this.wallets.create({
        currency: org?.currency ?? 'BDT',
        balanceMinor: 0,
        heldMinor: 0,
      });
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.wallets.findOne({}))!;
      throw err;
    }
  }

  async balance(): Promise<WalletBalance> {
    return toBalance(await this.get());
  }

  private actor(input: MovementInput): { type: string; id: string } {
    if (input.actor) return input.actor;
    const a = RequestContext.actor();
    return { type: a.type, id: a.id };
  }

  private async existing(key: string): Promise<LedgerDoc | null> {
    return this.ledger.findOne({ idempotencyKey: key });
  }

  private async record(
    wallet: WalletDoc,
    input: MovementInput,
    signedAmount: number,
  ): Promise<LedgerDoc> {
    return this.ledger.create({
      type: input.type,
      amountMinor: signedAmount,
      balanceAfterMinor: wallet.balanceMinor,
      currency: wallet.currency,
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.credits !== undefined ? { credits: input.credits } : {}),
      actor: this.actor(input),
      metadata: input.metadata ?? {},
    });
  }

  private async idempotent(
    input: MovementInput,
    apply: () => Promise<LedgerDoc>,
  ): Promise<{ entry: LedgerDoc; applied: boolean }> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Wallet movement amount must be a positive integer');
    try {
      return await this.tx.runOrJoin(async () => {
        const prior = await this.existing(input.idempotencyKey);
        if (prior) return { entry: prior, applied: false };
        return { entry: await apply(), applied: true };
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        const prior = await this.existing(input.idempotencyKey);
        if (prior) return { entry: prior, applied: false };
      }
      throw err;
    }
  }

  /** Adds money (top-up, refund, bonus, positive adjustment). */
  async credit(input: MovementInput): Promise<{ entry: LedgerDoc; applied: boolean }> {
    await this.get();
    return this.idempotent(input, async () => {
      const wallet = await this.wallets.findOneAndUpdate(
        {},
        {
          $inc: {
            balanceMinor: input.amountMinor,
            ...(input.type === 'topup' ? { lifetimeTopupMinor: input.amountMinor } : {}),
            ...(input.type === 'bonus' ? { bonusMinor: input.amountMinor } : {}),
          },
        },
      );
      return this.record(wallet!, input, input.amountMinor);
    });
  }

  /**
   * Takes money out of the wallet in one atomic conditional update. Which part of the
   * balance pays depends on the movement (see FUNDING): AI usage spends free credit first;
   * plans and withdrawals take cash only (free credit is for AI); platform corrections take
   * cash first; expiring free credit takes only free credit. `consumeHeldMinor` releases a
   * hold in the same step (settling a reservation or paying a held withdrawal). Fails with
   * 402 when the funding source is short.
   */
  async debit(
    input: MovementInput & { consumeHeldMinor?: number; allowFrozen?: boolean },
  ): Promise<{ entry: LedgerDoc; applied: boolean }> {
    await this.get();
    const consume = input.consumeHeldMinor ?? 0;
    const amount = input.amountMinor;
    const funding = FUNDING[input.type];
    const isSpend = SPEND_TYPES.has(input.type);
    const free = { $subtract: ['$balanceMinor', { $subtract: ['$heldMinor', consume] }] };
    const condition =
      funding === 'cash_only'
        ? { $gte: [{ $subtract: [free, '$bonusMinor'] }, amount] }
        : funding === 'bonus_only'
          ? { $and: [{ $gte: ['$bonusMinor', amount] }, { $gte: [free, amount] }] }
          : { $gte: [free, amount] };
    const nextBonus =
      funding === 'cash_only'
        ? '$bonusMinor'
        : funding === 'cash_first'
          ? { $max: [0, { $min: ['$bonusMinor', { $subtract: ['$balanceMinor', amount] }] }] }
          : { $max: [0, { $subtract: ['$bonusMinor', amount] }] };
    return this.idempotent(input, async () => {
      const wallet = await this.wallets.findOneAndUpdate(
        {
          ...(input.allowFrozen ? {} : { status: 'active' }),
          heldMinor: { $gte: consume },
          $expr: condition,
        },
        [
          {
            $set: {
              balanceMinor: { $subtract: ['$balanceMinor', amount] },
              heldMinor: { $subtract: ['$heldMinor', consume] },
              bonusMinor: nextBonus,
              lifetimeSpentMinor: isSpend
                ? { $add: ['$lifetimeSpentMinor', amount] }
                : '$lifetimeSpentMinor',
            },
          },
        ] as never,
        { updatePipeline: true },
      );
      if (!wallet) {
        const current = await this.get();
        if (current.status === 'frozen' && !input.allowFrozen)
          throw AppError.forbidden('wallet_frozen', 'This wallet is frozen. Contact support.');
        const freeNow = current.balanceMinor - (current.heldMinor - consume);
        const available =
          funding === 'cash_only'
            ? freeNow - current.bonusMinor
            : funding === 'bonus_only'
              ? Math.min(current.bonusMinor, freeNow)
              : freeNow;
        throw AppError.paymentRequired(
          'insufficient_balance',
          funding === 'cash_only' && current.bonusMinor > 0
            ? 'Your wallet cash is too low. Free AI credits can only be used for AI. Top up to continue.'
            : 'Your wallet balance is too low. Top up to continue.',
          { availableMinor: Math.max(0, available), requiredMinor: amount },
        );
      }
      return this.record(wallet, input, -amount);
    });
  }

  /**
   * Reserves funds without spending them (AI reservations, pending withdrawals). With
   * `excludeBonus` only cash counts, so free credit can never be withdrawn.
   */
  async hold(amountMinor: number, opts: { excludeBonus?: boolean } = {}): Promise<void> {
    if (amountMinor <= 0) return;
    await this.get();
    const free = opts.excludeBonus
      ? { $subtract: [{ $subtract: ['$balanceMinor', '$heldMinor'] }, '$bonusMinor'] }
      : { $subtract: ['$balanceMinor', '$heldMinor'] };
    const res = await this.wallets.updateOne(
      { status: 'active', $expr: { $gte: [free, amountMinor] } },
      { $inc: { heldMinor: amountMinor } },
    );
    if (res.modified !== 1) {
      const current = await this.get();
      if (current.status === 'frozen')
        throw AppError.forbidden('wallet_frozen', 'This wallet is frozen. Contact support.');
      const balance = toBalance(current);
      throw AppError.paymentRequired(
        'insufficient_balance',
        'Your wallet balance is too low. Top up to continue.',
        {
          availableMinor: Math.max(
            0,
            opts.excludeBonus ? balance.withdrawableMinor : balance.availableMinor,
          ),
          requiredMinor: amountMinor,
        },
      );
    }
  }

  async release(amountMinor: number): Promise<void> {
    if (amountMinor <= 0) return;
    const res = await this.wallets.updateOne(
      { heldMinor: { $gte: amountMinor } },
      { $inc: { heldMinor: -amountMinor } },
    );
    if (res.modified !== 1) throw new Error('Cannot release more than is held');
  }

  async markLowBalanceNotified(): Promise<void> {
    await this.wallets.updateOne({}, { $set: { lowBalanceNotifiedAt: new Date() } });
  }

  async setStatus(status: 'active' | 'frozen'): Promise<void> {
    await this.get();
    await this.wallets.updateOne({}, { $set: { status } });
  }

  async history(q: {
    limit: number;
    cursor?: string;
    type?: LedgerType;
  }): Promise<Page<LedgerDoc>> {
    return this.ledger.paginate(q.type ? { type: q.type } : {}, q);
  }

  /** Re-adds the ledger and compares with the stored balance (reconciliation check). */
  async reconcile(): Promise<{ ok: boolean; ledgerSumMinor: number; balanceMinor: number }> {
    const wallet = await this.get();
    const [sum] = await this.ledger.aggregate<{ total: number }>([
      { $match: {} },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]);
    const ledgerSumMinor = sum?.total ?? 0;
    return {
      ok: ledgerSumMinor === wallet.balanceMinor,
      ledgerSumMinor,
      balanceMinor: wallet.balanceMinor,
    };
  }

  static orgObjectId(): Types.ObjectId {
    return new Types.ObjectId(RequestContext.tenant()!.orgId);
  }
}
