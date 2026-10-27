import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types, type Model } from 'mongoose';
import { RequestContext, type Actor } from '../../common/context/request-context.js';
import { canonicalJson, sha256 } from '../../common/crypto/tokens.js';
import {
  buildPage,
  decodeCursor,
  keysetFilter,
  type Page,
} from '../../common/pagination/cursor.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import type { AuditEvent, AuditHead } from './audit-event.schema.js';

export const GENESIS_HASH = '0'.repeat(64);
export const AUDIT_RECORDED = 'audit.recorded';

const SECRET_KEYS = /pass(word)?|secret|token|otp|code|cookie|authorization|hash|key/i;

export interface AuditInput {
  action: string;
  orgId?: string | Types.ObjectId | null;
  outcome?: 'success' | 'failure' | 'denied';
  target?: { type: string; id?: string; label?: string };
  metadata?: Record<string, unknown>;
  /** Overrides the actor taken from the request context. */
  actor?: Actor & { label?: string };
}

export type AuditRecord = AuditEvent & { _id: Types.ObjectId };

/** Removes anything that looks like a credential before it is written to the log. */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactMetadata(v, depth + 1));
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) ? '[redacted]' : redactMetadata(v, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 1000) return `${value.slice(0, 1000)}…`;
  return value;
}

function hashEvent(event: Omit<AuditEvent, 'hash'>): string {
  const { prevHash, ...rest } = event;
  return sha256(`${prevHash}|${canonicalJson(rest)}`);
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel('AuditEvent') private readonly events: Model<AuditEvent>,
    @InjectModel('AuditHead') private readonly heads: Model<AuditHead>,
    private readonly tx: TransactionService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Appends an event to the tenant's (or platform's) hash chain. Joins the caller's
   * transaction when there is one, so the audit entry commits or rolls back with the
   * change it describes.
   */
  async record(input: AuditInput): Promise<void> {
    const ctx = RequestContext.current();
    const actor = input.actor ?? ctx?.actor ?? { type: 'system' as const, id: 'system' };
    const orgId = input.orgId ? new Types.ObjectId(String(input.orgId)) : undefined;
    const scope = orgId ? orgId.toHexString() : 'platform';

    const saved = await this.tx.runOrJoin(async () => {
      const head = await this.heads.findById(scope).lean().exec();
      const seq = (head?.seq ?? 0) + 1;
      const base = {
        scope,
        seq,
        ...(orgId ? { orgId } : {}),
        action: input.action,
        outcome: input.outcome ?? 'success',
        actor: {
          type: actor.type,
          id: actor.id,
          ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
          ...('label' in actor && actor.label ? { label: actor.label } : {}),
          ...(actor.impersonatedBy ? { impersonatedBy: actor.impersonatedBy } : {}),
        },
        ...(input.target ? { target: input.target } : {}),
        ...(ctx?.ip ? { ip: ctx.ip } : {}),
        ...(ctx?.userAgent ? { userAgent: ctx.userAgent } : {}),
        ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
        metadata: redactMetadata(input.metadata ?? {}) as Record<string, unknown>,
        at: new Date(),
        prevHash: head?.hash ?? GENESIS_HASH,
      };
      const hash = hashEvent(base as Omit<AuditEvent, 'hash'>);
      // Inside a snapshot transaction a concurrent writer causes a WriteConflict, which the
      // driver retries; the upsert covers the very first event of a scope.
      await this.heads
        .updateOne({ _id: scope, seq: head?.seq ?? 0 }, { $set: { seq, hash } }, { upsert: true })
        .exec();
      await this.events.create([{ ...base, hash }] as never);
      return { ...base, hash };
    });
    this.emitter.emit(AUDIT_RECORDED, saved);
  }

  /** Same as record() but never throws; used on failure paths (e.g. failed logins). */
  async recordSafe(input: AuditInput): Promise<void> {
    try {
      await this.record(input);
    } catch (err) {
      this.logger.error({ err, action: input.action }, 'Failed to write audit event');
    }
  }

  async list(
    filter: {
      orgId?: string;
      scope?: string;
      action?: string;
      actorId?: string;
      from?: Date;
      to?: Date;
    },
    page: { limit: number; cursor?: string },
  ): Promise<Page<AuditRecord>> {
    const query: Record<string, unknown> = {};
    if (filter.orgId) query.orgId = new Types.ObjectId(filter.orgId);
    if (filter.scope) query.scope = filter.scope;
    if (filter.action)
      query.action = { $regex: `^${filter.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
    if (filter.actorId) query['actor.id'] = filter.actorId;
    if (filter.from || filter.to)
      query.at = {
        ...(filter.from ? { $gte: filter.from } : {}),
        ...(filter.to ? { $lte: filter.to } : {}),
      };
    const cursor = decodeCursor(page.cursor);
    const keyset = keysetFilter('_id', cursor);
    const docs = await this.events
      .find({ ...query, ...keyset })
      .sort({ _id: -1 })
      .limit(page.limit + 1)
      .lean<AuditRecord[]>()
      .exec();
    return buildPage(docs, page.limit, '_id');
  }

  /** Re-computes every hash in a scope. Returns the first broken sequence number, if any. */
  async verifyChain(
    scope: string,
  ): Promise<{ ok: boolean; checked: number; brokenAt?: number; reason?: string }> {
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;
    const cursor = this.events.find({ scope }).sort({ seq: 1 }).lean<AuditRecord[]>().cursor();
    for await (const raw of cursor) {
      const event = raw;
      if (event.seq !== expectedSeq)
        return { ok: false, checked, brokenAt: expectedSeq, reason: 'missing_event' };
      if (event.prevHash !== prev)
        return { ok: false, checked, brokenAt: event.seq, reason: 'prev_hash_mismatch' };
      const { _id, hash, ...rest } = event;
      const recomputed = hashEvent(stripUndefined(rest));
      if (recomputed !== hash)
        return { ok: false, checked, brokenAt: event.seq, reason: 'hash_mismatch' };
      prev = hash;
      expectedSeq++;
      checked++;
    }
    const head = await this.heads.findById(scope).lean().exec();
    if (head && head.seq !== checked)
      return { ok: false, checked, brokenAt: checked + 1, reason: 'head_mismatch' };
    return { ok: true, checked };
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
