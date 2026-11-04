import { mongo } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, money, plain, text } from './export.js';
import { driveDue } from './merchant-backups.service.js';

const { Decimal128, Long, ObjectId } = mongo;

describe('export helpers (ADR 0021)', () => {
  it('turns BSON values into plain JSON and leaves secrets out at every depth', () => {
    const id = new ObjectId();
    const at = new Date('2026-11-04T08:00:00.000Z');
    const out = plain(
      {
        _id: id,
        createdAt: at,
        price: Decimal128.fromString('1250.50'),
        big: Long.fromString('9007199254740993'),
        tokenEnc: 'v1:secret',
        passwordHash: 'argon',
        __v: 3,
        nested: { apiKeyEnc: 'x', keyHash: 'y', ok: 1, list: [{ secret: 's', name: 'n' }] },
        costMinor: 500,
      },
      new Set(['costMinor']),
    );
    expect(out).toEqual({
      _id: id.toHexString(),
      createdAt: '2026-11-04T08:00:00.000Z',
      price: '1250.50',
      big: '9007199254740993',
      nested: { ok: 1, list: [{ name: 'n' }] },
    });
    expect(JSON.stringify(out)).not.toMatch(/secret|argon|v1:/);
  });

  it('writes CSV cells a spreadsheet will not run as formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+8801711')).toBe("'+8801711");
    expect(csvCell('-5 taka off')).toBe("'-5 taka off");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell('জামদানি, শাড়ি')).toBe('"জামদানি, শাড়ি"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(csvRow(['a', 'b,c', undefined])).toBe('a,"b,c",\r\n');
    // A plain negative number cannot be a formula, so spreadsheets still see a number.
    expect(csvCell(-120)).toBe('-120');
    expect(csvCell('-1250.50')).toBe('-1250.50');
    expect(csvCell('-1+2')).toBe("'-1+2");
  });

  it('shows objects as JSON and ids as hex in text cells', () => {
    const id = new ObjectId();
    expect(text(id)).toBe(id.toHexString());
    expect(text({ a: 1 })).toBe('{"a":1}');
    expect(text(undefined)).toBe('');
  });

  it('writes money in the currency, from minor units', () => {
    expect(money(125050, 'BDT')).toBe('1250.50');
    expect(money(5, 'BDT')).toBe('0.05');
    expect(money(-125050, 'BDT')).toBe('-1250.50');
    expect(money(0, 'BDT')).toBe('0.00');
    expect(money(undefined, 'BDT')).toBe('');
    expect(money(Number.NaN, 'BDT')).toBe('');
  });
});

describe('driveDue', () => {
  const slot = new Date('2026-11-03T22:00:00.000Z'); // 04:00 in Dhaka
  const at = (min: number) => new Date(slot.getTime() + min * 60_000);

  it('is due once the slot has passed and today has no copy yet', () => {
    expect(driveDue({}, at(1), slot)).toBe(true);
    expect(driveDue({ lastSuccessAt: at(-60 * 24) }, at(1), slot)).toBe(true);
    expect(driveDue({ lastSuccessAt: at(5) }, at(10), slot)).toBe(false);
  });

  it('waits 30 minutes between tries and stops after 3 failures in a day', () => {
    expect(driveDue({ lastAttemptAt: at(5) }, at(20), slot)).toBe(false);
    expect(driveDue({ lastAttemptAt: at(5) }, at(36), slot)).toBe(true);
    expect(driveDue({ lastAttemptAt: at(5), failures: { slot, count: 3 } }, at(120), slot)).toBe(
      false,
    );
    // Yesterday's failures do not count today.
    const yesterday = new Date(slot.getTime() - 24 * 3600_000);
    expect(driveDue({ failures: { slot: yesterday, count: 3 } }, at(1), slot)).toBe(true);
  });

  it('is not due while a copy is running or already queued', () => {
    expect(driveDue({ busyUntil: at(20) }, at(10), slot)).toBe(false);
    expect(driveDue({ queuedAt: at(5) }, at(10), slot)).toBe(false);
    expect(driveDue({ queuedAt: at(5) }, at(40), slot)).toBe(true);
  });
});
