'use client';

import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, Globe, ShoppingBag, Store, Upload } from 'lucide-react';
import { api } from '@/lib/api/client';
import type {
  CatalogSource,
  CatalogSourceKind,
  SyncCounts,
  SyncPageCounts,
  SyncRunStatus,
  SyncRunTrigger,
} from '@/lib/api/types';

export const syncKeys = {
  sources: (orgId: string) => ['org', orgId, 'catalog-sync', 'sources'] as const,
  runs: (orgId: string, sourceId: string) =>
    ['org', orgId, 'catalog-sync', 'sources', sourceId, 'runs'] as const,
  run: (orgId: string, sourceId: string, runId: string) =>
    ['org', orgId, 'catalog-sync', 'sources', sourceId, 'runs', runId] as const,
  pages: (orgId: string, sourceId: string) =>
    ['org', orgId, 'catalog-sync', 'sources', sourceId, 'pages'] as const,
  page: (orgId: string, sourceId: string, pageId: string) =>
    ['org', orgId, 'catalog-sync', 'sources', sourceId, 'pages', pageId] as const,
};

/** Sources of the business. Refreshes often while one is syncing. */
export function useCatalogSources(orgId: string, enabled = true) {
  return useQuery({
    queryKey: syncKeys.sources(orgId),
    queryFn: async () =>
      (await api<{ items: CatalogSource[] }>(`/orgs/${orgId}/catalog-sources`)).items,
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => s.running) ? 3_000 : 60_000),
    enabled,
  });
}

export const KIND_INFO: Record<
  CatalogSourceKind,
  { label: string; blurb: string; scheduled: boolean }
> = {
  shopify: {
    label: 'Shopify',
    blurb: 'Products, variants, stock and photos from your Shopify shop.',
    scheduled: true,
  },
  woocommerce: {
    label: 'WooCommerce',
    blurb: 'Products and variations from a WordPress shop with WooCommerce.',
    scheduled: true,
  },
  sheet: {
    label: 'Google Sheet',
    blurb: 'A sheet shared with “Anyone with the link”, or any CSV link.',
    scheduled: true,
  },
  csv: {
    label: 'CSV file',
    blurb: 'A file exported from Excel, Google Sheets or another shop. Upload new versions.',
    scheduled: false,
  },
  website: {
    label: 'Your website',
    blurb:
      'Your own site: products from its product pages, and its pages (delivery, returns, FAQ) for the AI to answer from.',
    scheduled: true,
  },
};

export const KIND_ICON = {
  shopify: ShoppingBag,
  woocommerce: Store,
  sheet: FileSpreadsheet,
  csv: Upload,
  website: Globe,
} as const satisfies Record<CatalogSourceKind, unknown>;

export const INTERVALS: { value: number; label: string }[] = [
  { value: 0, label: 'Only when I ask' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
  { value: 1440, label: 'Once a day' },
];

/** A website is read at most hourly: each crawl reads many pages (ADR 0024). */
const WEBSITE_INTERVALS = new Set([0, 60, 360, 1440]);

export const intervalsFor = (kind: CatalogSourceKind) =>
  kind === 'website' ? INTERVALS.filter((i) => WEBSITE_INTERVALS.has(i.value)) : INTERVALS;

export const defaultInterval = (kind: CatalogSourceKind) => (kind === 'website' ? 1440 : 60);

export function intervalLabel(minutes: number): string {
  return INTERVALS.find((i) => i.value === minutes)?.label ?? `Every ${minutes} minutes`;
}

export const TRIGGER_LABEL: Record<SyncRunTrigger, string> = {
  first: 'First import',
  schedule: 'Scheduled',
  manual: 'Sync now',
  upload: 'File upload',
};

export const RUN_STATUS: Record<
  SyncRunStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
  queued: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Syncing', tone: 'info' },
  succeeded: { label: 'Done', tone: 'success' },
  partial: { label: 'Done with problems', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const isFinished = (s: SyncRunStatus) => s !== 'queued' && s !== 'running';

/** "2 added, 1 updated, 3 unchanged" (only what happened). */
export function countsText(c: SyncCounts): string {
  const parts: string[] = [];
  if (c.created) parts.push(`${c.created} added`);
  if (c.updated) parts.push(`${c.updated} updated`);
  if (c.restored) parts.push(`${c.restored} back`);
  if (c.archived) parts.push(`${c.archived} archived`);
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
  if (c.failed) parts.push(`${c.failed} skipped`);
  if (c.held) parts.push(`${c.held} waiting for you`);
  return parts.length ? parts.join(', ') : 'No products read';
}

/** "14 pages read (2 new, 1 changed)" for a website crawl. */
export function pagesText(p: SyncPageCounts): string {
  const parts: string[] = [];
  if (p.added) parts.push(`${p.added} new`);
  if (p.changed) parts.push(`${p.changed} changed`);
  if (p.removed) parts.push(`${p.removed} removed`);
  let out = `${p.read} page${p.read === 1 ? '' : 's'} read`;
  if (parts.length) out += ` (${parts.join(', ')})`;
  if (p.notRead) out += `, ${p.notRead} more not read`;
  return out;
}

/** What one run did, products and (for a website) pages. */
export function runText(c: SyncCounts, p: SyncPageCounts | null, kind: CatalogSourceKind): string {
  if (kind !== 'website' || !p) return countsText(c);
  const products = c.seen || c.archived || c.held ? countsText(c) : null;
  return products ? `${pagesText(p)}; products: ${products}` : pagesText(p);
}

export const CSV_MAX_BYTES = 700 * 1024;

/** Reads a chosen CSV file as text, or says why it cannot be used. */
export async function readCsvFile(
  file: File,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (file.size > CSV_MAX_BYTES)
    return {
      ok: false,
      message: `The file is ${Math.round(file.size / 1024)} KB; files can be up to 700 KB. Use a Google Sheet link for a bigger catalog.`,
    };
  if (!/\.(csv|txt|tsv)$/i.test(file.name) && !/csv|text\/plain/.test(file.type))
    return { ok: false, message: 'Choose a .csv file (in Excel: File › Save as › CSV UTF-8).' };
  const text = await file.text();
  if (!text.trim()) return { ok: false, message: 'The file is empty.' };
  return { ok: true, text };
}
