import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import type { Model, Types } from 'mongoose';
import { sha256 } from '../../common/crypto/tokens.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { abResult, abVariant, AB_VISITOR_RE } from './ab-test.js';
import type { LandingContent } from './blocks.js';
import { LandingAbTestRepository } from './repositories.js';
import type {
  AbTestEndReason,
  AbTestSettings,
  LandingAbTest,
  LandingPage,
  LandingRunningTest,
} from './schemas.js';

export type AbTestDoc = WithId<LandingAbTest>;

/** How long the marker that a visitor was counted in a test lives (longer than any test). */
const VISITOR_TTL_S = 62 * 86_400;

/** Which version a shopper sees, and the test it belongs to. */
export interface AbAssignment {
  testId: string;
  variant: 'a' | 'b';
  /** The browser's A/B id, hashed before it is stored anywhere. */
  visitor: string;
}

/**
 * A/B tests on landing pages (ADR 0031): the records, the visitor split, the counts and the
 * results. Starting and ending a test (which publishes B when it wins) is done by the
 * landing pages service, which owns publishing.
 */
@Injectable()
export class LandingAbTestsService {
  constructor(
    private readonly tests: LandingAbTestRepository,
    @InjectModel('LandingAbTest') private readonly model: Model<LandingAbTest>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  toDto(t: AbTestDoc, now = new Date()) {
    const result = abResult(t.counts, t.settings.minVisitors);
    return {
      id: t._id.toHexString(),
      status: t.status,
      settings: t.settings,
      a: { version: t.a.version },
      b: { revision: t.b.revision },
      counts: t.counts,
      result,
      startedAt: t.startedAt.toISOString(),
      endsBy:
        t.status === 'running' && t.settings.autoWinner
          ? new Date(t.startedAt.getTime() + t.settings.maxDays * 86_400_000).toISOString()
          : null,
      days: Math.floor(((t.endedAt ?? now).getTime() - t.startedAt.getTime()) / 86_400_000),
      endedAt: t.endedAt?.toISOString() ?? null,
      endReason: t.endReason ?? null,
      winner: t.winner ?? null,
      publishedVersion: t.publishedVersion ?? null,
    };
  }

  get(id: string | Types.ObjectId): Promise<AbTestDoc | null> {
    return this.tests.findById(id);
  }

  /** The page's tests, newest first (the running one, then the last 20 ended). */
  async list(pageId: Types.ObjectId) {
    const items = await this.tests.find({ pageId }, { sort: { startedAt: -1 }, limit: 21 });
    const now = new Date();
    return items.map((t) => this.toDto(t, now));
  }

  /** Records a new running test; the caller puts it on the page in the same transaction. */
  create(input: {
    pageId: Types.ObjectId;
    settings: AbTestSettings;
    aVersion: number;
    b: {
      revision: number;
      content: LandingContent;
      approvedBy: { id: string };
      autoApproved: boolean;
    };
    startedBy: { id: string };
  }): Promise<AbTestDoc> {
    const zero = { visitors: 0, buyers: 0, orders: 0, revenueMinor: 0 };
    return this.tests.create({
      pageId: input.pageId,
      status: 'running',
      settings: input.settings,
      a: { version: input.aVersion },
      b: input.b,
      counts: { a: { ...zero }, b: { ...zero } },
      startedAt: new Date(),
      startedBy: input.startedBy,
    });
  }

  /** Marks a running test ended; false when it had already ended. */
  async markEnded(
    id: Types.ObjectId,
    end: {
      reason: AbTestEndReason;
      winner: 'a' | 'b' | null;
      by: { id: string };
      publishedVersion?: number;
    },
  ): Promise<boolean> {
    const res = await this.tests.updateOne(
      { _id: id, status: 'running' },
      {
        $set: {
          status: 'ended',
          endedAt: new Date(),
          endedBy: end.by,
          endReason: end.reason,
          winner: end.winner,
          ...(end.publishedVersion ? { publishedVersion: end.publishedVersion } : {}),
        },
      },
    );
    return res.modified === 1;
  }

  async removeForPage(pageId: Types.ObjectId): Promise<void> {
    await this.tests.deleteMany({ pageId });
  }

  // ---------------------------------------------------------------- shoppers

  /** The version this browser sees on a page with a running test; null without one. */
  assign(page: Pick<LandingPage, 'abTest'>, visitor: string | undefined): AbAssignment | null {
    const test: LandingRunningTest | undefined = page.abTest;
    if (!test || !visitor || !AB_VISITOR_RE.test(visitor)) return null;
    const testId = test.id.toHexString();
    return { testId, variant: abVariant(testId, visitor, test.splitB), visitor };
  }

  private marker(kind: 'v' | 'b', a: AbAssignment) {
    return `lp:ab:${kind}:${a.testId}:${sha256(a.visitor).slice(0, 32)}`;
  }

  /** Counts the visitor once for the whole test. Runs in the page's business. */
  async countVisit(a: AbAssignment): Promise<boolean> {
    const first = await this.redis.set(this.marker('v', a), '1', 'EX', VISITOR_TTL_S, 'NX');
    if (first !== 'OK') return false;
    await this.tests.updateOne(
      { _id: a.testId, status: 'running' },
      { $inc: { [`counts.${a.variant}.visitors`]: 1 } },
    );
    return true;
  }

  /**
   * Counts an order for the version the shopper saw: an order, its value, and the visitor
   * as a buyer the first time (also as a visitor, if the visit beacon never arrived).
   */
  async countOrder(a: AbAssignment, totalMinor: number): Promise<void> {
    await this.countVisit(a);
    const firstBuy = await this.redis.set(this.marker('b', a), '1', 'EX', VISITOR_TTL_S, 'NX');
    await this.tests.updateOne(
      { _id: a.testId, status: 'running' },
      {
        $inc: {
          [`counts.${a.variant}.orders`]: 1,
          [`counts.${a.variant}.revenueMinor`]: totalMinor,
          ...(firstBuy === 'OK' ? { [`counts.${a.variant}.buyers`]: 1 } : {}),
        },
      },
    );
  }

  // ---------------------------------------------------------------- the worker's sweep

  /** Running automatic tests of every business, oldest first, for the minute sweep. */
  runningAutomatic(limit = 200): Promise<AbTestDoc[]> {
    return this.model
      .find({ status: 'running', 'settings.autoWinner': true })
      .setOptions({ [CROSS_TENANT]: true })
      .sort({ startedAt: 1 })
      .limit(limit)
      .lean<AbTestDoc[]>()
      .exec();
  }
}
