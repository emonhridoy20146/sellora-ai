'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building2, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Input, NativeSelect } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { OffsetPage, Tenant } from '@/lib/api/types';
import { formatDate, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

export default function TenantsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim());
  const list = useQuery({
    queryKey: ['platform', 'tenants', q, status, page],
    queryFn: () =>
      api<OffsetPage<Tenant>>('/platform/tenants', { query: { q, status, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="Businesses" description="Every shop on the platform." />
      <Card>
        <div className="flex flex-wrap gap-2 border-b px-5 py-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="absolute top-2.5 left-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <label htmlFor="t-search" className="sr-only">
              Search businesses
            </label>
            <Input
              id="t-search"
              className="h-9 pl-8"
              placeholder="Name, web address or owner email"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <label htmlFor="t-status" className="sr-only">
            Status
          </label>
          <NativeSelect
            id="t-status"
            className="w-40"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </NativeSelect>
        </div>
        <CardContent className={cn('px-0 py-0', list.isPlaceholderData && 'opacity-60')}>
          {list.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <EmptyState icon={Building2} title="No businesses match" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Business</TH>
                  <TH>Owner</TH>
                  <TH>Category</TH>
                  <TH className="text-right">Staff</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((t) => (
                  <TR key={t.id}>
                    <TD>
                      <Link
                        href={`/admin/tenants/${t.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {t.name}
                      </Link>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {t.slug}
                      </span>
                    </TD>
                    <TD>
                      <span className="block">{t.owner?.name ?? '–'}</span>
                      <span className="text-xs text-muted-foreground">{t.owner?.email}</span>
                    </TD>
                    <TD>{humanize(t.category)}</TD>
                    <TD className="tabular text-right">{t.memberCount}</TD>
                    <TD>
                      <span className="inline-flex gap-1">
                        <StatusBadge status={t.status} />
                        {t.isDemo && <Badge tone="info">Demo</Badge>}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {formatDate(t.createdAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {list.data && (
            <Pagination
              page={page}
              pageSize={list.data.pageSize}
              total={list.data.total}
              onPage={setPage}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
