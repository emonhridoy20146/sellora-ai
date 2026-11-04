import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectConnection } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { Connection, mongo } from 'mongoose';
import { formatMoney, isSupportedCurrency } from '../../common/money/money.js';
import { zonedParts, zonedTimeToUtc } from '../../common/time/zoned.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { escapeHtml } from '../../infra/telegram/telegram.client.js';
import { PlatformBillingService } from '../billing/platform-billing.service.js';
import { AlertsService } from './alerts.service.js';

export type ReportKind = 'daily' | 'weekly' | 'monthly';
export const REPORT_KINDS: ReportKind[] = ['daily', 'weekly', 'monthly'];

type Money = { currency: string; minor: number };

export interface HostStats {
  hostname: string;
  load: [number, number, number];
  cpus: number;
  memory: { totalBytes: number; usedBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  uptimeSeconds: number;
}

export interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface BackupLine {
  status: string;
  startedAt: Date;
  verifiedAt?: Date;
  size?: number;
  error?: string;
  offsite?: { ok: boolean; error?: string };
  testRestore?: { at: Date; ok: boolean; error?: string };
}

/** Everything a report says. Counts and sums only: no customer's name, phone or message. */
export interface ReportData {
  from: Date;
  to: Date;
  timezone: string;
  growth: {
    signups: number;
    newBusinesses: number;
    demoBusinesses: number;
    trials: number;
    newPaying: number;
    activeBusinesses: number;
  };
  money: {
    received: {
      currency: string;
      topupsMinor: number;
      subscriptionsMinor: number;
      count: number;
    }[];
    subscriptionsBilled: { currency: string; count: number; minor: number }[];
    mrr: { currency: string; mrrMinor: number; payingBusinesses: number }[];
    failedPayments: number;
  };
  ai: {
    replies: number;
    conversations: number;
    handovers: number;
    inputTokens: number;
    outputTokens: number;
    providers: {
      provider: string;
      currency: string;
      costMinor: number;
      costUsdMicros: number;
      requests: number;
    }[];
    totals: {
      currency: string;
      credits: number;
      billedMinor: number;
      collectedMinor: number;
      costMinor: number;
      profitMinor: number;
      marginPct: number | null;
    }[];
  };
  activity: {
    orders: { currency: string; count: number; totalMinor: number }[];
    sms: { count: number; parts: number; failed: number; cost: Money[] };
    campaignsStarted: number;
  };
  backups: {
    last: BackupLine | null;
    lastTestRestore: BackupLine | null;
    businessBackupsFailed: number;
    driveFailing: number;
  };
  queues: QueueStats[];
  host: HostStats;
}

const DAY_MS = 24 * 3600_000;

/** Calendar day arithmetic on y/m/d (pure UTC, so daylight saving cannot shift it). */
function addDays(p: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The latest time a report of `kind` was due at or before `now`: daily at `hour`, weekly on
 * Mondays at `hour`, monthly on the 1st at `hour`, in `timeZone`.
 */
export function reportSlot(kind: ReportKind, now: Date, hour: number, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  if (kind === 'monthly') {
    const first = zonedTimeToUtc({ year: p.year, month: p.month, day: 1, hour }, timeZone);
    if (first.getTime() <= now.getTime()) return first;
    const prev =
      p.month === 1 ? { year: p.year - 1, month: 12 } : { year: p.year, month: p.month - 1 };
    return zonedTimeToUtc({ ...prev, day: 1, hour }, timeZone);
  }
  let day = { year: p.year, month: p.month, day: p.day };
  if (zonedTimeToUtc({ ...day, hour }, timeZone).getTime() > now.getTime()) day = addDays(day, -1);
  if (kind === 'weekly') {
    // 1 = Monday.
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    day = addDays(day, -((weekday + 6) % 7));
  }
  return zonedTimeToUtc({ ...day, hour }, timeZone);
}

/** What a report sent at `slot` covers: the 24 hours, 7 days or calendar month before it. */
export function reportPeriod(
  kind: ReportKind,
  slot: Date,
  timeZone: string,
): { from: Date; to: Date } {
  const p = zonedParts(slot, timeZone);
  const day = { year: p.year, month: p.month, day: p.day };
  if (kind === 'monthly') {
    const prev =
      p.month === 1 ? { year: p.year - 1, month: 12 } : { year: p.year, month: p.month - 1 };
    return { from: zonedTimeToUtc({ ...prev, day: 1, hour: p.hour }, timeZone), to: slot };
  }
  const back = addDays(day, kind === 'weekly' ? -7 : -1);
  return { from: zonedTimeToUtc({ ...back, hour: p.hour }, timeZone), to: slot };
}

// ---------------------------------------------------------------- formatting

function money(minor: number, currency: string): string {
  return isSupportedCurrency(currency)
    ? formatMoney(Math.round(minor), currency)
    : `${minor} ${currency}`;
}

function moneyList(rows: Money[]): string {
  const shown = rows.filter((r) => r.minor !== 0);
  return shown.length ? shown.map((r) => money(r.minor, r.currency)).join(' + ') : '0';
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function when(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

function pct(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '–';
}

export function hostLine(h: HostStats): string {
  const mem = pct(h.memory.usedBytes, h.memory.totalBytes);
  const disk = h.disk
    ? `disk ${pct(h.disk.totalBytes - h.disk.freeBytes, h.disk.totalBytes)} used (${bytes(h.disk.freeBytes)} free)`
    : 'disk unknown';
  return `load ${h.load[0].toFixed(2)} on ${h.cpus} CPUs · memory ${mem} · ${disk}`;
}

function backupLine(b: BackupLine | null, timeZone: string): string {
  if (!b) return 'none yet';
  const state =
    b.status === 'verified'
      ? `✅ verified ${when(b.verifiedAt ?? b.startedAt, timeZone)}${b.size ? ` (${bytes(b.size)})` : ''}`
      : b.status === 'failed'
        ? `❌ failed ${when(b.startedAt, timeZone)}${b.error ? `: ${escapeHtml(b.error.slice(0, 120))}` : ''}`
        : `⏳ ${b.status} since ${when(b.startedAt, timeZone)}`;
  const offsite = b.offsite ? (b.offsite.ok ? ' · off-site ✅' : ' · off-site ❌') : '';
  return `${state}${offsite}`;
}

function queueLine(q: QueueStats[]): string {
  const waiting = q.reduce((n, r) => n + r.waiting, 0);
  const failed = q.reduce((n, r) => n + r.failed, 0);
  const busiest = [...q].sort((a, b) => b.waiting - a.waiting)[0];
  return `${whole.format(waiting)} waiting${busiest && busiest.waiting > 0 ? ` (most in ${busiest.name}: ${whole.format(busiest.waiting)})` : ''} · ${whole.format(failed)} failed in the last 14 days`;
}

const TITLES: Record<ReportKind | 'today', string> = {
  daily: '📊 <b>Sellora daily report</b>',
  weekly: '📊 <b>Sellora weekly report</b>',
  monthly: '📊 <b>Sellora monthly report</b>',
  today: '📊 <b>Sellora today so far</b>',
};

/** The report as Telegram HTML. */
export function reportHtml(kind: ReportKind | 'today', r: ReportData): string {
  const tz = r.timezone;
  const g = r.growth;
  const m = r.money;
  const ai = r.ai;
  const received = m.received.map((x) => ({
    currency: x.currency,
    minor: x.topupsMinor + x.subscriptionsMinor,
  }));
  const topups = m.received.map((x) => ({ currency: x.currency, minor: x.topupsMinor }));
  const subs = m.received.map((x) => ({ currency: x.currency, minor: x.subscriptionsMinor }));
  const billed = m.subscriptionsBilled.reduce((n, x) => n + x.count, 0);
  const cost = ai.totals.map((t) => ({ currency: t.currency, minor: t.costMinor }));
  const lines = [
    TITLES[kind],
    `${when(r.from, tz)} – ${when(r.to, tz)} (${escapeHtml(tz)})`,
    '',
    '<b>Growth</b>',
    `Sign-ups: ${g.signups} · new businesses: ${g.newBusinesses}${g.demoBusinesses ? ` (${g.demoBusinesses} demo)` : ''}`,
    `Trials started: ${g.trials} · new paying businesses: ${g.newPaying}`,
    `Active businesses (an order or a customer message): ${g.activeBusinesses}`,
    '',
    '<b>Money</b>',
    `Received: ${moneyList(received)} (wallet top-ups ${moneyList(topups)}, subscriptions ${moneyList(subs)})`,
    `Subscriptions billed: ${billed}${billed ? `, ${moneyList(m.subscriptionsBilled.map((x) => ({ currency: x.currency, minor: x.minor })))}` : ''}`,
    `MRR: ${m.mrr.length ? m.mrr.map((x) => `${money(x.mrrMinor, x.currency)} from ${x.payingBusinesses} businesses`).join(' · ') : '0'}`,
    `Failed payments: ${m.failedPayments}`,
    '',
    '<b>AI</b>',
    `Replies: ${whole.format(ai.replies)} in ${whole.format(ai.conversations)} chats · handed to people: ${whole.format(ai.handovers)}`,
    `Tokens: ${compact.format(ai.inputTokens)} in, ${compact.format(ai.outputTokens)} out`,
    `Real cost: ${
      ai.providers.length
        ? ai.providers
            .map(
              (p) =>
                `${escapeHtml(p.provider)} ${money(p.costMinor, p.currency)} ($${(p.costUsdMicros / 1e6).toFixed(2)})`,
            )
            .join(' · ')
        : '0'
    }`,
    ...ai.totals.map(
      (t) =>
        `Billed ${money(t.billedMinor, t.currency)} (${whole.format(t.credits)} credits) · profit ${money(t.profitMinor, t.currency)}${t.marginPct === null ? '' : `, margin ${t.marginPct}%`}`,
    ),
    `Cost per conversation: ${
      ai.conversations > 0 && cost.length
        ? cost.map((c) => money(c.minor / ai.conversations, c.currency)).join(' + ')
        : '–'
    }`,
    '',
    '<b>Activity</b>',
    `Orders: ${r.activity.orders.reduce((n, o) => n + o.count, 0)}${
      r.activity.orders.length
        ? `, ${moneyList(r.activity.orders.map((o) => ({ currency: o.currency, minor: o.totalMinor })))}`
        : ''
    }`,
    `SMS: ${whole.format(r.activity.sms.count)} (${whole.format(r.activity.sms.parts)} parts, ${r.activity.sms.failed} failed) · cost ${moneyList(r.activity.sms.cost)}`,
    `Campaigns started: ${r.activity.campaignsStarted}`,
    '',
    '<b>Backups</b>',
    `Last platform backup: ${backupLine(r.backups.last, tz)}`,
    `Last test restore: ${
      r.backups.lastTestRestore?.testRestore
        ? `${r.backups.lastTestRestore.testRestore.ok ? '✅' : '❌'} ${when(r.backups.lastTestRestore.testRestore.at, tz)}`
        : 'none yet'
    }`,
    ...(r.backups.businessBackupsFailed
      ? [`Business restore points that failed: ${r.backups.businessBackupsFailed}`]
      : []),
    ...(r.backups.driveFailing
      ? [`Google Drive copies failing: ${r.backups.driveFailing} businesses`]
      : []),
    '',
    '<b>Server</b>',
    `Queues: ${queueLine(r.queues)}`,
    `Worker host: ${hostLine(r.host)}`,
  ];
  return lines.join('\n');
}

/**
 * The numbers in owner reports and bot replies (ADR 0022). Reads across every business, so
 * it reads raw collections and returns counts and sums only.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly billing: PlatformBillingService,
    private readonly alerts: AlertsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private col(name: string): mongo.Collection {
    return this.connection.db!.collection(name);
  }

  private async count(name: string, filter: mongo.Filter<mongo.Document>): Promise<number> {
    return this.col(name).countDocuments(filter);
  }

  async collect(from: Date, to: Date, timezone: string): Promise<ReportData> {
    const range = { $gte: from, $lt: to };
    const [
      signups,
      newBusinesses,
      demoBusinesses,
      trials,
      newPaying,
      orderOrgs,
      messageOrgs,
      received,
      subscriptionsBilled,
      failedPayments,
      overview,
      byModel,
      aiMessages,
      handovers,
      orders,
      sms,
      campaignsStarted,
      backups,
      queues,
      host,
    ] = await Promise.all([
      this.count('users', { createdAt: range }),
      this.count('organizations', { createdAt: range }),
      this.count('organizations', { createdAt: range, isDemo: true }),
      this.count('subscriptions', { source: 'trial', createdAt: range }),
      this.col('invoices')
        .aggregate<{ n: number }>([
          { $match: { kind: 'subscription', issuedAt: { $lt: to } } },
          { $group: { _id: '$orgId', first: { $min: '$issuedAt' } } },
          { $match: { first: range } },
          { $count: 'n' },
        ])
        .toArray(),
      this.col('orders').distinct('orgId', { createdAt: range }),
      this.col('messages').distinct('orgId', { direction: 'in', createdAt: range }),
      this.col('payments')
        .aggregate<{ _id: { currency: string; purpose: string }; minor: number; count: number }>([
          { $match: { status: 'succeeded', succeededAt: range } },
          {
            $group: {
              _id: { currency: '$currency', purpose: '$purpose' },
              minor: { $sum: '$amountMinor' },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      this.col('invoices')
        .aggregate<{ _id: string; count: number; minor: number }>([
          { $match: { kind: 'subscription', issuedAt: range } },
          { $group: { _id: '$currency', count: { $sum: 1 }, minor: { $sum: '$totalMinor' } } },
        ])
        .toArray(),
      this.count('payments', { status: 'failed', updatedAt: range }),
      this.billing.overview(from, to),
      this.billing.profit(from, to, 'model'),
      this.col('messages')
        .aggregate<{ replies: number; conversations: number }>([
          { $match: { 'sender.type': 'ai', direction: 'out', createdAt: range } },
          { $group: { _id: '$conversationId', n: { $sum: 1 } } },
          { $group: { _id: null, replies: { $sum: '$n' }, conversations: { $sum: 1 } } },
        ])
        .toArray(),
      this.alerts.sum('handovers', from, to),
      this.col('orders')
        .aggregate<{ _id: string; count: number; totalMinor: number }>([
          { $match: { createdAt: range } },
          {
            $group: {
              _id: '$currency',
              count: { $sum: 1 },
              totalMinor: {
                $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 0, '$totalMinor'] },
              },
            },
          },
        ])
        .toArray(),
      this.col('smsmessages')
        .aggregate<{
          _id: string;
          count: number;
          parts: number;
          failed: number;
          costMinor: number;
        }>([
          { $match: { queuedAt: range } },
          {
            $group: {
              _id: '$currency',
              count: { $sum: 1 },
              parts: { $sum: '$parts' },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              costMinor: { $sum: '$costMinor' },
            },
          },
        ])
        .toArray(),
      this.count('campaigns', { startedAt: range }),
      this.backupState(from, to),
      this.queues(),
      this.host(),
    ]);

    const active = new Set(
      [...(orderOrgs as unknown[]), ...(messageOrgs as unknown[])].map(String),
    );
    const receivedBy = new Map<string, ReportData['money']['received'][number]>();
    for (const r of received) {
      const row = receivedBy.get(r._id.currency) ?? {
        currency: r._id.currency,
        topupsMinor: 0,
        subscriptionsMinor: 0,
        count: 0,
      };
      if (r._id.purpose === 'subscription') row.subscriptionsMinor += r.minor;
      else row.topupsMinor += r.minor;
      row.count += r.count;
      receivedBy.set(r._id.currency, row);
    }
    const providers = new Map<string, ReportData['ai']['providers'][number]>();
    let inputTokens = 0;
    let outputTokens = 0;
    for (const row of byModel.rows) {
      const provider = row.key.split('/')[0] ?? 'unknown';
      const k = `${provider}|${row.currency}`;
      const p = providers.get(k) ?? {
        provider,
        currency: row.currency,
        costMinor: 0,
        costUsdMicros: 0,
        requests: 0,
      };
      p.costMinor += row.costMinor;
      p.costUsdMicros += row.costUsdMicros;
      p.requests += row.requests;
      providers.set(k, p);
      inputTokens += row.inputTokens + row.cachedInputTokens + row.cacheWriteInputTokens;
      outputTokens += row.outputTokens;
    }
    const smsCost = sms.map((s) => ({ currency: s._id, minor: s.costMinor }));
    return {
      from,
      to,
      timezone,
      growth: {
        signups,
        newBusinesses,
        demoBusinesses,
        trials,
        newPaying: newPaying[0]?.n ?? 0,
        activeBusinesses: active.size,
      },
      money: {
        received: [...receivedBy.values()],
        subscriptionsBilled: subscriptionsBilled.map((s) => ({
          currency: s._id,
          count: s.count,
          minor: s.minor,
        })),
        mrr: overview.mrr,
        failedPayments,
      },
      ai: {
        replies: aiMessages[0]?.replies ?? 0,
        conversations: aiMessages[0]?.conversations ?? 0,
        handovers,
        inputTokens,
        outputTokens,
        providers: [...providers.values()],
        totals: overview.ai.map((t) => ({
          currency: t.currency,
          credits: t.credits,
          billedMinor: t.billedMinor,
          collectedMinor: t.collectedMinor,
          costMinor: t.costMinor,
          profitMinor: t.profitMinor,
          marginPct: t.marginPct,
        })),
      },
      activity: {
        orders: orders.map((o) => ({ currency: o._id, count: o.count, totalMinor: o.totalMinor })),
        sms: {
          count: sms.reduce((n, s) => n + s.count, 0),
          parts: sms.reduce((n, s) => n + s.parts, 0),
          failed: sms.reduce((n, s) => n + s.failed, 0),
          cost: smsCost,
        },
        campaignsStarted,
      },
      backups,
      queues,
      host,
    };
  }

  /** The newest platform backups, newest first. */
  async lastBackups(limit: number): Promise<BackupLine[]> {
    return this.col('backup_runs')
      .find(
        { scope: 'platform', status: { $ne: 'deleted' } },
        {
          projection: {
            status: 1,
            startedAt: 1,
            verifiedAt: 1,
            size: 1,
            error: 1,
            offsite: 1,
            testRestore: 1,
          },
        },
      )
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray() as unknown as Promise<BackupLine[]>;
  }

  private async backupState(from: Date, to: Date): Promise<ReportData['backups']> {
    const [last, lastTestRestore, businessBackupsFailed, driveFailing] = await Promise.all([
      this.lastBackups(1),
      this.col('backup_runs')
        .find(
          { scope: 'platform', 'testRestore.at': { $exists: true } },
          { projection: { testRestore: 1, startedAt: 1, status: 1 } },
        )
        .sort({ 'testRestore.at': -1 })
        .limit(1)
        .toArray() as unknown as Promise<BackupLine[]>,
      this.count('backup_runs', {
        scope: 'tenant',
        status: 'failed',
        startedAt: { $gte: from, $lt: to },
      }),
      this.count('drive_connections', {
        enabled: true,
        $or: [
          { status: 'reconnect' },
          {
            lastError: { $exists: true, $ne: null },
            $expr: { $gt: ['$lastAttemptAt', { $ifNull: ['$lastSuccessAt', new Date(0)] }] },
          },
        ],
      }),
    ]);
    return {
      last: last[0] ?? null,
      lastTestRestore: lastTestRestore[0] ?? null,
      businessBackupsFailed,
      driveFailing,
    };
  }

  /** Jobs in each queue (waiting, running, delayed, and failed kept for 14 days). */
  async queues(): Promise<QueueStats[]> {
    const out: QueueStats[] = [];
    for (const name of Object.values(QUEUES)) {
      try {
        const q = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
        const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        out.push({
          name,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
        });
      } catch (err) {
        this.logger.warn({ err, queue: name }, 'Queue counts unavailable');
      }
    }
    return out;
  }

  /** This host (the worker's, when the worker sends the report). */
  async host(): Promise<HostStats> {
    const total = os.totalmem();
    let disk: HostStats['disk'];
    try {
      const s = await statfs('/');
      disk = { path: '/', totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      disk = null;
    }
    const load = os.loadavg();
    return {
      hostname: os.hostname(),
      load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpus: os.cpus().length,
      memory: { totalBytes: total, usedBytes: total - os.freemem() },
      disk,
      uptimeSeconds: Math.round(os.uptime()),
    };
  }

  // ---------------------------------------------------------------- bot replies

  async todayHtml(now: Date, timezone: string): Promise<string> {
    const p = zonedParts(now, timezone);
    const from = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timezone);
    return reportHtml('today', await this.collect(from, now, timezone));
  }

  async statusHtml(timezone: string): Promise<string> {
    const [queues, backups, host] = await Promise.all([
      this.queues(),
      this.lastBackups(1),
      this.host(),
    ]);
    return [
      '🟢 <b>Sellora status</b>',
      `Queues: ${queueLine(queues)}`,
      `Last platform backup: ${backupLine(backups[0] ?? null, timezone)}`,
      `Worker host: ${hostLine(host)}`,
    ].join('\n');
  }

  async backupHtml(timezone: string): Promise<string> {
    const rows = await this.lastBackups(5);
    if (!rows.length) return '🗄 <b>Platform backups</b>\nNone yet.';
    return [
      '🗄 <b>Platform backups</b> (newest first)',
      ...rows.map((b) => {
        const test = b.testRestore ? ` · test restore ${b.testRestore.ok ? '✅' : '❌'}` : '';
        return `• ${backupLine(b, timezone)}${test}`;
      }),
    ].join('\n');
  }

  async serversHtml(): Promise<string> {
    const h = await this.host();
    const days = Math.floor(h.uptimeSeconds / 86_400);
    const hours = Math.floor((h.uptimeSeconds % 86_400) / 3600);
    return [
      `🖥 <b>${escapeHtml(h.hostname)}</b> (the worker's host)`,
      `Load: ${h.load.map((l) => l.toFixed(2)).join(' / ')} (1, 5, 15 min) on ${h.cpus} CPUs`,
      `Memory: ${bytes(h.memory.usedBytes)} of ${bytes(h.memory.totalBytes)} (${pct(h.memory.usedBytes, h.memory.totalBytes)})`,
      h.disk
        ? `Disk ${h.disk.path}: ${bytes(h.disk.totalBytes - h.disk.freeBytes)} of ${bytes(h.disk.totalBytes)} used, ${bytes(h.disk.freeBytes)} free`
        : 'Disk: unknown',
      `Up ${days} d ${hours} h`,
      '<i>Other servers report through the monitoring system.</i>',
    ].join('\n');
  }

  /** Today's AI cost in US dollars against the daily average of the 7 days before. */
  async aiSpend(now: Date, timezone: string): Promise<{ todayUsd: number; averageUsd: number }> {
    const p = zonedParts(now, timezone);
    const start = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timezone);
    const weekAgo = new Date(start.getTime() - 7 * DAY_MS);
    const rows = await this.col('ai_usage')
      .aggregate<{ _id: boolean; usd: number }>([
        { $match: { status: 'settled', settledAt: { $gte: weekAgo, $lt: now } } },
        { $group: { _id: { $gte: ['$settledAt', start] }, usd: { $sum: '$costUsdMicros' } } },
      ])
      .toArray();
    const today = rows.find((r) => r._id)?.usd ?? 0;
    const before = rows.find((r) => !r._id)?.usd ?? 0;
    return { todayUsd: today / 1e6, averageUsd: before / 7 / 1e6 };
  }
}
