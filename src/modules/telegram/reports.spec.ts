import { describe, expect, it } from 'vitest';
import { alertHtml, htmlToText } from './alerts.service.js';
import { bytes, reportHtml, reportPeriod, reportSlot, type ReportData } from './reports.service.js';

const DHAKA = 'Asia/Dhaka'; // UTC+6, no daylight saving
const LONDON = 'Europe/London';

describe('reportSlot', () => {
  it('is today at the hour once it has passed, else yesterday', () => {
    // 2026-11-04 15:30 UTC is 21:30 in Dhaka.
    expect(reportSlot('daily', new Date('2026-11-04T15:30:00Z'), 21, DHAKA).toISOString()).toBe(
      '2026-11-04T15:00:00.000Z',
    );
    // 20:59 in Dhaka: still yesterday's.
    expect(reportSlot('daily', new Date('2026-11-04T14:59:00Z'), 21, DHAKA).toISOString()).toBe(
      '2026-11-03T15:00:00.000Z',
    );
  });

  it('is the latest Monday for weekly reports', () => {
    // Wednesday 2026-11-04 in Dhaka: Monday 2026-11-02 at 21:00.
    expect(reportSlot('weekly', new Date('2026-11-04T15:30:00Z'), 21, DHAKA).toISOString()).toBe(
      '2026-11-02T15:00:00.000Z',
    );
    // Monday 20:00 in Dhaka: the Monday before.
    expect(reportSlot('weekly', new Date('2026-11-02T14:00:00Z'), 21, DHAKA).toISOString()).toBe(
      '2026-10-26T15:00:00.000Z',
    );
    // Monday 21:00 exactly: this Monday.
    expect(reportSlot('weekly', new Date('2026-11-02T15:00:00Z'), 21, DHAKA).toISOString()).toBe(
      '2026-11-02T15:00:00.000Z',
    );
  });

  it('is the 1st of the month for monthly reports, across a year end', () => {
    expect(reportSlot('monthly', new Date('2026-11-04T15:30:00Z'), 21, DHAKA).toISOString()).toBe(
      '2026-11-01T15:00:00.000Z',
    );
    // 1 January 2027, 09:00 in Dhaka: still December's slot of 1 December.
    expect(reportSlot('monthly', new Date('2027-01-01T03:00:00Z'), 21, DHAKA).toISOString()).toBe(
      '2026-12-01T15:00:00.000Z',
    );
  });

  it('keeps the wall-clock hour across daylight saving', () => {
    // London leaves summer time on 2026-10-25: 21:00 is 20:00 UTC before, 21:00 UTC after.
    expect(reportSlot('daily', new Date('2026-10-24T22:00:00Z'), 21, LONDON).toISOString()).toBe(
      '2026-10-24T20:00:00.000Z',
    );
    expect(reportSlot('daily', new Date('2026-10-25T22:00:00Z'), 21, LONDON).toISOString()).toBe(
      '2026-10-25T21:00:00.000Z',
    );
  });
});

describe('reportPeriod', () => {
  const slot = new Date('2026-11-01T15:00:00Z'); // 1 November, 21:00 in Dhaka

  it('covers the 24 hours, 7 days or calendar month before the slot', () => {
    expect(reportPeriod('daily', slot, DHAKA)).toEqual({
      from: new Date('2026-10-31T15:00:00Z'),
      to: slot,
    });
    expect(reportPeriod('weekly', slot, DHAKA)).toEqual({
      from: new Date('2026-10-25T15:00:00Z'),
      to: slot,
    });
    expect(reportPeriod('monthly', slot, DHAKA)).toEqual({
      from: new Date('2026-10-01T15:00:00Z'),
      to: slot,
    });
    expect(reportPeriod('monthly', new Date('2027-01-01T15:00:00Z'), DHAKA).from).toEqual(
      new Date('2026-12-01T15:00:00Z'),
    );
  });

  it('is 25 hours on the day London leaves summer time', () => {
    const p = reportPeriod('daily', new Date('2026-10-25T21:00:00Z'), LONDON);
    expect(p.from.toISOString()).toBe('2026-10-24T20:00:00.000Z');
  });
});

const data: ReportData = {
  from: new Date('2026-11-03T15:00:00Z'),
  to: new Date('2026-11-04T15:00:00Z'),
  timezone: DHAKA,
  growth: {
    signups: 4,
    newBusinesses: 3,
    demoBusinesses: 1,
    trials: 2,
    newPaying: 1,
    activeBusinesses: 12,
  },
  money: {
    received: [{ currency: 'BDT', topupsMinor: 1_000_000, subscriptionsMinor: 250_000, count: 3 }],
    subscriptionsBilled: [{ currency: 'BDT', count: 3, minor: 450_000 }],
    mrr: [{ currency: 'BDT', mrrMinor: 4_500_000, payingBusinesses: 30 }],
    failedPayments: 1,
  },
  ai: {
    replies: 340,
    conversations: 120,
    handovers: 12,
    inputTokens: 1_234_567,
    outputTokens: 150_000,
    providers: [
      {
        provider: 'anth<ropic',
        currency: 'BDT',
        costMinor: 80_000,
        costUsdMicros: 6_500_000,
        requests: 400,
      },
    ],
    totals: [
      {
        currency: 'BDT',
        credits: 40_000,
        billedMinor: 200_000,
        collectedMinor: 200_000,
        costMinor: 80_000,
        profitMinor: 120_000,
        marginPct: 60,
      },
    ],
  },
  activity: {
    orders: [{ currency: 'BDT', count: 85, totalMinor: 12_000_000 }],
    sms: { count: 300, parts: 320, failed: 2, cost: [{ currency: 'BDT', minor: 9_600 }] },
    campaignsStarted: 2,
  },
  backups: {
    last: {
      status: 'verified',
      startedAt: new Date('2026-11-03T21:00:00Z'),
      verifiedAt: new Date('2026-11-03T21:05:00Z'),
      size: 2_200_000,
      offsite: { ok: true },
    },
    lastTestRestore: {
      status: 'verified',
      startedAt: new Date('2026-11-03T21:00:00Z'),
      testRestore: { at: new Date('2026-11-03T22:10:00Z'), ok: true },
    },
    businessBackupsFailed: 0,
    driveFailing: 2,
  },
  queues: [
    { name: 'ai', waiting: 3, active: 1, delayed: 0, failed: 1 },
    { name: 'mail', waiting: 0, active: 0, delayed: 0, failed: 0 },
  ],
  host: {
    hostname: 'worker-1',
    load: [0.42, 0.3, 0.2],
    cpus: 4,
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3 },
    disk: { path: '/', totalBytes: 100 * 1024 ** 3, freeBytes: 60 * 1024 ** 3 },
    uptimeSeconds: 90_000,
  },
};

describe('reportHtml', () => {
  it('says every number in Telegram HTML, escaped', () => {
    // Currency amounts use a no-break space after the code.
    const html = reportHtml('daily', data).replace(/\u00a0/g, ' ');
    expect(html).toContain('📊 <b>Sellora daily report</b>');
    expect(html).toContain('3 Nov, 21:00 – 4 Nov, 21:00 (Asia/Dhaka)');
    expect(html).toContain('Sign-ups: 4 · new businesses: 3 (1 demo)');
    expect(html).toContain('Trials started: 2 · new paying businesses: 1');
    expect(html).toContain('Active businesses (an order or a customer message): 12');
    expect(html).toContain(
      'Received: BDT 12,500.00 (wallet top-ups BDT 10,000.00, subscriptions BDT 2,500.00)',
    );
    expect(html).toContain('MRR: BDT 45,000.00 from 30 businesses');
    expect(html).toContain('Replies: 340 in 120 chats · handed to people: 12');
    expect(html).toContain('Tokens: 1.2M in, 150K out');
    expect(html).toContain('anth&lt;ropic BDT 800.00 ($6.50)');
    expect(html).toContain('profit BDT 1,200.00, margin 60%');
    expect(html).toContain('Cost per conversation: BDT 6.67');
    expect(html).toContain('Orders: 85, BDT 120,000.00');
    expect(html).toContain('SMS: 300 (320 parts, 2 failed) · cost BDT 96.00');
    expect(html).toContain('Google Drive copies failing: 2 businesses');
    expect(html).toContain('off-site ✅');
    expect(html).toContain('Queues: 3 waiting (most in ai: 3) · 1 failed in the last 14 days');
    expect(html).toContain('load 0.42 on 4 CPUs · memory 63% · disk 40% used (60 GB free)');
    expect(html).not.toMatch(/undefined|NaN|null|\[object/);
    // Telegram's HTML mode takes only its own tags.
    expect(html.match(/<\/?([a-z]+)/g)?.every((t) => /^<\/?b$/.test(t))).toBe(true);
  });

  it('reads well with nothing to report', () => {
    const empty: ReportData = {
      ...data,
      growth: {
        signups: 0,
        newBusinesses: 0,
        demoBusinesses: 0,
        trials: 0,
        newPaying: 0,
        activeBusinesses: 0,
      },
      money: { received: [], subscriptionsBilled: [], mrr: [], failedPayments: 0 },
      ai: {
        replies: 0,
        conversations: 0,
        handovers: 0,
        inputTokens: 0,
        outputTokens: 0,
        providers: [],
        totals: [],
      },
      activity: {
        orders: [],
        sms: { count: 0, parts: 0, failed: 0, cost: [] },
        campaignsStarted: 0,
      },
      backups: { last: null, lastTestRestore: null, businessBackupsFailed: 0, driveFailing: 0 },
      queues: [],
      host: { ...data.host, disk: null },
    };
    const html = reportHtml('monthly', empty).replace(/\u00a0/g, ' ');
    expect(html).toContain('Sellora monthly report');
    expect(html).toContain('Received: 0 (wallet top-ups 0, subscriptions 0)');
    expect(html).toContain('Cost per conversation: –');
    expect(html).toContain('Last platform backup: none yet');
    expect(html).toContain('disk unknown');
    expect(html).not.toMatch(/undefined|NaN|null|\[object/);
  });
});

describe('alerts', () => {
  it('escapes the alert and says how many were held back', () => {
    const html = alertHtml(
      { topic: 'backups', key: 'k', title: 'A <b> & c', lines: ['x > y'], level: 'critical' },
      2,
    );
    expect(html).toBe(
      '🔴 <b>A &lt;b&gt; &amp; c</b>\nx &gt; y\n<i>2 more like this were held back since the last one.</i>',
    );
    expect(htmlToText(html)).toBe(
      '🔴 A <b> & c\nx > y\n2 more like this were held back since the last one.',
    );
    expect(alertHtml({ topic: 'ai', key: 'k', title: 'T' }, 1)).toContain(
      '1 more like this was held back',
    );
    expect(alertHtml({ topic: 'ai', key: 'k', title: 'T' }, 0)).toBe('🟠 <b>T</b>');
  });

  it('formats sizes', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(2_200_000)).toBe('2.1 MB');
    expect(bytes(60 * 1024 ** 3)).toBe('60 GB');
  });
});
