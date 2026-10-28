'use client';

import { useQuery } from '@tanstack/react-query';
import { Flag, PanelsTopLeft } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { LandingStatusBadge } from '@/components/landing/status';
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
import type { PlatformLandingList } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';

type Filter = 'pending' | 'live' | 'taken_down' | 'all';
const PAGE_SIZE = 25;

export default function PlatformLandingPagesPage() {
  const [status, setStatus] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 300);
  const list = useQuery({
    queryKey: ['platform', 'landing-pages', status, q, page],
    queryFn: () =>
      api<PlatformLandingList>('/platform/landing-pages', {
        query: { status, q: q || undefined, page, pageSize: PAGE_SIZE },
      }),
    placeholderData: (prev) => prev,
  });
  const pending = list.data?.pending;

  return (
    <>
      <PageHeader
        title="Landing pages"
        description="Each version a business publishes waits here, oldest first. The live version stays up while a newer one is checked. Approve what you looked at, or say what to change."
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
              { value: 'live', label: 'Published' },
              { value: 'taken_down', label: 'Taken down' },
              { value: 'all', label: 'All' },
            ]}
          />
          <label htmlFor="lp-search" className="sr-only">
            Search landing pages
          </label>
          <Input
            id="lp-search"
            type="search"
            placeholder="Page name or address"
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
              icon={PanelsTopLeft}
              title={
                status === 'pending' && !q ? 'Nothing waiting for review' : 'No landing pages match'
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Page</TH>
                  <TH>Business</TH>
                  <TH>Status</TH>
                  <TH>Warnings</TH>
                  <TH>{status === 'pending' ? 'Sent' : 'Last change'}</TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((p) => {
                  const when =
                    status === 'pending' && p.submission ? p.submission.submittedAt : p.updatedAt;
                  return (
                    <TR key={p.id}>
                      <TD className="max-w-80">
                        <Link
                          href={`/admin/landing-pages/${p.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {p.name}
                        </Link>
                        <span className="block truncate text-xs text-muted-foreground">
                          {p.store?.handle ?? 'Store removed'} · /{p.slug}
                        </span>
                      </TD>
                      <TD>
                        {p.org ? (
                          <Link href={`/admin/tenants/${p.org.id}`} className="hover:underline">
                            {p.org.name}
                          </Link>
                        ) : (
                          '–'
                        )}
                      </TD>
                      <TD>
                        <div className="flex flex-col items-start gap-1">
                          <LandingStatusBadge status={p.status} />
                          {p.status === 'live' && p.submission?.status === 'pending' && (
                            <span className="text-xs text-muted-foreground">
                              Changes to a live page
                            </span>
                          )}
                        </div>
                      </TD>
                      <TD>
                        {p.flagCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <Flag className="size-3.5" aria-hidden /> {p.flagCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </TD>
                      <TD
                        className="whitespace-nowrap text-muted-foreground"
                        title={formatDateTime(when)}
                      >
                        {formatRelative(when)}
                      </TD>
                    </TR>
                  );
                })}
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
