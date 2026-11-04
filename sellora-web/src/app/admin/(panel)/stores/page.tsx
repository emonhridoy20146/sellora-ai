'use client';

import { useQuery } from '@tanstack/react-query';
import { Flag, Store } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { StoreStatusBadge } from '@/components/stores/store-status';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { PlatformStoreList, StoreStatus } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';

type Filter = StoreStatus | 'all';
const PAGE_SIZE = 25;

export default function PlatformStoresPage() {
  const [status, setStatus] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 300);
  const list = useQuery({
    queryKey: ['platform', 'stores', status, q, page],
    queryFn: () =>
      api<PlatformStoreList>('/platform/stores', {
        query: {
          status: status === 'all' ? undefined : status,
          q: q || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
      }),
    placeholderData: (prev) => prev,
  });
  const pending = list.data?.pending;

  return (
    <>
      <PageHeader
        title="Online stores"
        description="Stores wait here after a business sends them for review. Oldest first: check the preview and the automatic warnings, then approve or ask for changes."
        actions={
          <Link href="/admin/stores/domains" className="text-sm text-primary hover:underline">
            Custom domains
          </Link>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
          <Segmented<Filter>
            label="Status"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: 'pending', label: pending ? `To review (${pending})` : 'To review' },
              { value: 'live', label: 'Open' },
              { value: 'rejected', label: 'Changes asked' },
              { value: 'suspended', label: 'Suspended' },
              { value: 'all', label: 'All' },
            ]}
          />
          <label htmlFor="st-search" className="sr-only">
            Search stores
          </label>
          <Input
            id="st-search"
            type="search"
            placeholder="Store name or address"
            className="w-full sm:ml-auto sm:w-64"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <CardContent className="px-0 py-0">
          {list.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <EmptyState
              icon={Store}
              title={status === 'pending' && !q ? 'Nothing waiting for review' : 'No stores match'}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Store</TH>
                  <TH>Business</TH>
                  <TH>Status</TH>
                  <TH>Warnings</TH>
                  <TH>{status === 'pending' ? 'Sent' : 'Last change'}</TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((s) => (
                  <TR key={s.id}>
                    <TD>
                      <Link
                        href={`/admin/stores/${s.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {s.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{s.handle}</span>
                    </TD>
                    <TD>
                      {s.org ? (
                        <Link href={`/admin/tenants/${s.org.id}`} className="hover:underline">
                          {s.org.name}
                        </Link>
                      ) : (
                        '–'
                      )}
                    </TD>
                    <TD>
                      <StoreStatusBadge status={s.status} />
                    </TD>
                    <TD>
                      {s.flagCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-warning">
                          <Flag className="size-3.5" aria-hidden /> {s.flagCount}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TD>
                    <TD
                      className="whitespace-nowrap text-muted-foreground"
                      title={formatDateTime(status === 'pending' ? s.submittedAt : s.updatedAt)}
                    >
                      {formatRelative(status === 'pending' ? s.submittedAt : s.updatedAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {list.data && (
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
