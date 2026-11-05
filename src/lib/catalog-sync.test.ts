import { describe, expect, it } from 'vitest';
import {
  countsText,
  defaultInterval,
  intervalsFor,
  pagesText,
  runText,
} from '@/components/catalog-sync/shared';
import type { SyncCounts, SyncPageCounts } from '@/lib/api/types';

const counts = (c: Partial<SyncCounts> = {}): SyncCounts => ({
  seen: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  archived: 0,
  restored: 0,
  failed: 0,
  held: 0,
  ...c,
});
const pages = (p: Partial<SyncPageCounts> = {}): SyncPageCounts => ({
  read: 0,
  added: 0,
  changed: 0,
  removed: 0,
  notRead: 0,
  ...p,
});

describe('catalog sync texts', () => {
  it('names held changes in the counts', () => {
    expect(countsText(counts({ seen: 3, updated: 1, unchanged: 1, held: 1 }))).toBe(
      '1 updated, 1 unchanged, 1 waiting for you',
    );
  });

  it('says what a crawl read', () => {
    expect(pagesText(pages({ read: 1 }))).toBe('1 page read');
    expect(pagesText(pages({ read: 14, added: 2, changed: 1, notRead: 30 }))).toBe(
      '14 pages read (2 new, 1 changed), 30 more not read',
    );
  });

  it('a website run gives pages first, and products only when it read some', () => {
    expect(runText(counts(), pages({ read: 5, added: 5 }), 'website')).toBe('5 pages read (5 new)');
    expect(runText(counts({ seen: 2, created: 2 }), pages({ read: 5 }), 'website')).toBe(
      '5 pages read; products: 2 added',
    );
    expect(runText(counts({ seen: 2, created: 2 }), null, 'shopify')).toBe('2 added');
  });

  it('a website is read at most hourly and daily by default', () => {
    expect(intervalsFor('website').map((i) => i.value)).toEqual([0, 60, 360, 1440]);
    expect(intervalsFor('sheet').map((i) => i.value)).toContain(15);
    expect(defaultInterval('website')).toBe(1440);
    expect(defaultInterval('shopify')).toBe(60);
  });
});
