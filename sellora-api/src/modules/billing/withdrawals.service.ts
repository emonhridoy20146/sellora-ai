import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import type { Withdrawal, WithdrawalStatus } from './payment-schemas.js';
import { WalletService } from './wallet.service.js';

export type WithdrawalDoc = WithId<Withdrawal>;

export const WITHDRAWAL_REQUESTED = 'billing.withdrawal_requested';

@Injectable()
export class WithdrawalRepository extends TenantScopedRepository<Withdrawal> {
  constructor(@InjectModel('Withdrawal') model: Model<Withdrawal>) {
    super(model);
  }
}

export function toWithdrawalDto(w: WithdrawalDoc) {
  return {
    id: w._id.toHexString(),
    amountMinor: w.amountMinor,
    currency: w.currency,
    method: w.method,
    destination: w.destination,
    status: w.status,
    reviewNote: w.reviewNote ?? null,
    payoutRef: w.payoutRef ?? null,
    createdAt: w.createdAt.toISOString(),
    reviewedAt: w.reviewedAt?.toISOString() ?? null,
    paidAt: w.paidAt?.toISOString() ?? null,
  };
}

/**
 * Taking unused cash back out of the wallet. The request holds the money at once (so it
 * cannot be spent twice); the super-admin approves or rejects; the money leaves the
 * wallet only when marked paid. Free credit is never withdrawable. The whole feature is
 * off until the super-admin enables it after the legal review.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly withdrawals: WithdrawalRepository,
    @InjectModel('Withdrawal') private readonly model: Model<Withdrawal>,
    private readonly wallet: WalletService,
    private readonly settings: PlatformSettingsService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async request(input: {
    amountMinor: number;
    method: Withdrawal['method'];
    destination: string;
  }): Promise<WithdrawalDoc> {
    if (!(await this.settings.get()).billing.withdrawalsEnabled) {
      throw AppError.forbidden(
        'withdrawals_disabled',
        'Withdrawals are not available yet. Contact support for a refund.',
      );
    }
    const open = await this.withdrawals.count({ status: { $in: ['requested', 'approved'] } });
    if (open >= 3)
      throw AppError.conflict(
        'too_many_open_withdrawals',
        'Wait for your open withdrawal requests to finish first.',
      );
    const created = await this.tx.run(async () => {
      const wallet = await this.wallet.get();
      await this.wallet.hold(input.amountMinor, { excludeBonus: true });
      const doc = await this.withdrawals.create({
        amountMinor: input.amountMinor,
        currency: wallet.currency,
        method: input.method,
        destination: input.destination,
        status: 'requested',
        requestedBy: new Types.ObjectId(RequestContext.actor().id),
      });
      await this.audit.record({
        action: 'billing.withdrawal.requested',
        orgId: RequestContext.tenant()!.orgId,
        target: { type: 'withdrawal', id: doc._id.toHexString() },
        metadata: { amountMinor: input.amountMinor, method: input.method },
      });
      return doc;
    });
    this.events.emit(WITHDRAWAL_REQUESTED, {
      orgId: RequestContext.tenant()!.orgId,
      withdrawalId: created._id.toHexString(),
      amountMinor: created.amountMinor,
      currency: created.currency,
    });
    return created;
  }

  async cancel(id: string): Promise<WithdrawalDoc> {
    return this.transition(id, ['requested'], 'canceled', {
      releaseHold: true,
      action: 'billing.withdrawal.canceled',
    });
  }

  list(q: { limit: number; cursor?: string }) {
    return this.withdrawals.paginate({}, q);
  }

  // ---------------------------------------------------------------- platform

  async listForPlatform(q: { status?: WithdrawalStatus; limit: number; before?: string }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.before && Types.ObjectId.isValid(q.before))
      filter._id = { $lt: new Types.ObjectId(q.before) };
    const docs = await this.model
      .find(filter, null, { [CROSS_TENANT]: true })
      .sort({ _id: -1 })
      .limit(q.limit + 1)
      .lean<WithdrawalDoc[]>()
      .exec();
    const items = docs.slice(0, q.limit);
    return {
      items: items.map((w) => ({
        ...toWithdrawalDto(w),
        orgId: w.orgId.toHexString(),
        reviewedBy: w.reviewedBy ?? null,
      })),
      nextCursor: docs.length > q.limit ? items[items.length - 1]!._id.toHexString() : null,
    };
  }

  /** Platform decision, run in the withdrawal's tenant scope. */
  async review(
    id: string,
    decision: 'approve' | 'reject' | 'paid',
    input: { note: string; payoutRef?: string },
    actorId: string,
  ): Promise<WithdrawalDoc> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('withdrawal');
    const located = await this.model
      .findById(id, { orgId: 1 }, { [CROSS_TENANT]: true })
      .lean()
      .exec();
    if (!located) throw AppError.notFound('withdrawal');
    return RequestContext.withTenant(
      located.orgId.toHexString(),
      () => {
        if (decision === 'approve')
          return this.transition(id, ['requested'], 'approved', {
            note: input.note,
            actorId,
            action: 'platform.withdrawal.approved',
          });
        if (decision === 'reject')
          return this.transition(id, ['requested', 'approved'], 'rejected', {
            note: input.note,
            actorId,
            releaseHold: true,
            action: 'platform.withdrawal.rejected',
          });
        if (!input.payoutRef)
          throw AppError.validation([
            { path: 'payoutRef', message: 'Payout reference is required' },
          ]);
        return this.transition(id, ['approved'], 'paid', {
          note: input.note,
          actorId,
          payoutRef: input.payoutRef,
          debit: true,
          action: 'platform.withdrawal.paid',
        });
      },
      { type: 'platform', id: actorId },
    );
  }

  private async transition(
    id: string,
    from: WithdrawalStatus[],
    to: WithdrawalStatus,
    opts: {
      note?: string;
      actorId?: string;
      payoutRef?: string;
      releaseHold?: boolean;
      debit?: boolean;
      action: string;
    },
  ): Promise<WithdrawalDoc> {
    return this.tx.run(async () => {
      const current = await this.withdrawals.findById(id);
      if (!current) throw AppError.notFound('withdrawal');
      if (!from.includes(current.status))
        throw AppError.conflict(
          'invalid_withdrawal_state',
          `This withdrawal is ${current.status}.`,
        );
      const now = new Date();
      const updated = await this.withdrawals.findOneAndUpdate(
        { _id: current._id, status: current.status },
        {
          $set: {
            status: to,
            ...(opts.actorId ? { reviewedBy: opts.actorId, reviewedAt: now } : {}),
            ...(opts.note !== undefined ? { reviewNote: opts.note } : {}),
            ...(opts.payoutRef ? { payoutRef: opts.payoutRef } : {}),
            ...(to === 'paid' ? { paidAt: now } : {}),
          },
        },
      );
      if (!updated)
        throw AppError.conflict(
          'invalid_withdrawal_state',
          'This withdrawal changed in the meantime.',
        );
      if (opts.releaseHold) await this.wallet.release(current.amountMinor);
      if (opts.debit) {
        await this.wallet.debit({
          type: 'withdrawal',
          amountMinor: current.amountMinor,
          consumeHeldMinor: current.amountMinor,
          allowFrozen: true,
          idempotencyKey: `withdrawal:${current._id.toHexString()}`,
          description: `Withdrawal to ${current.method} ${current.destination}`,
          reference: { type: 'withdrawal', id: current._id.toHexString() },
          metadata: { payoutRef: opts.payoutRef },
        });
      }
      await this.audit.record({
        action: opts.action,
        orgId: current.orgId,
        target: { type: 'withdrawal', id: current._id.toHexString() },
        metadata: {
          amountMinor: current.amountMinor,
          note: opts.note ?? null,
          payoutRef: opts.payoutRef ?? null,
        },
      });
      return updated;
    });
  }
}
