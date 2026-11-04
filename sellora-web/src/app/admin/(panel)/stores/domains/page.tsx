'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, Globe } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DomainStatusBadge } from '@/components/stores/domain-card';
import { usePlatform } from '@/components/platform-context';
import { DomainDecision } from '@/components/stores/domain-decision';
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
import type { DomainStatus, PlatformStoreDomainList } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';

type Filter = DomainStatus | 'all';
const PAGE_SIZE = 25;

function Check({ ok, label }: { ok: boolean | undefined; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {ok ? (
        <CircleCheck className="size-3.5 text-success" aria-hidden />
      ) : (
        <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
      )}
      {label}
      <span className="sr-only">{ok ? ' right' : ' not right'}</span>
    </span>
  );
}

export default function PlatformStoreDomainsPage() {
  const queryClient = useQueryClient();
  const { can } = usePlatform();
  const editable = can('platform.stores.approve');
  const [status, setStatus] = useState<Filter>('review');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 300);
  const list = useQuery({
    queryKey: ['platform', 'store-domains', status, q, page],
    queryFn: () =>
      api<PlatformStoreDomainList>('/platform/store-domains', {
        query: {
          status: status === 'all' ? undefined : status,
          q: q || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
      }),
    placeholderData: (prev) => prev,
  });
  const review = list.data?.review;

  return (
    <>
      <PageHeader
        title="Custom domains"
        description="Businesses' own domains for their stores. A domain lands here once its DNS proves the business owns it and points at the stores. Check that the name fits the business, then approve or refuse."
        actions={
          <Link href="/admin/stores" className="text-sm text-primary hover:underline">
            Online stores
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
              { value: 'review', label: review ? `To review (${review})` : 'To review' },
              { value: 'active', label: 'Connected' },
              { value: 'pending', label: 'Waiting for DNS' },
              { value: 'rejected', label: 'Not approved' },
              { value: 'all', label: 'All' },
            ]}
          />
          <label htmlFor="dm-search" className="sr-only">
            Search domains
          </label>
          <Input
            id="dm-search"
            type="search"
            placeholder="Domain"
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
              icon={Globe}
              title={
                status === 'review' && !q ? 'No domain waiting for review' : 'No domains match'
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Domain</TH>
                  <TH>Store</TH>
                  <TH>Status</TH>
                  <TH>DNS</TH>
                  <TH>{status === 'review' ? 'Proven' : 'Last change'}</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((d) => {
                  const when = status === 'review' ? d.verifiedAt : d.updatedAt;
                  return (
                    <TR key={d.id}>
                      <TD>
                        {d.status === 'active' ? (
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium break-all text-primary hover:underline"
                          >
                            {d.displayDomain}
                          </a>
                        ) : (
                          <span className="font-medium break-all">{d.displayDomain}</span>
                        )}
                        {d.displayDomain !== d.domain && (
                          <span className="block text-xs text-muted-foreground">{d.domain}</span>
                        )}
                        {d.review.reason && (
                          <span className="block text-xs text-muted-foreground">
                            Reason: {d.review.reason}
                          </span>
                        )}
                      </TD>
                      <TD>
                        {d.store ? (
                          <Link
                            href={`/admin/stores/${d.store.id}`}
                            className="font-medium hover:underline"
                          >
                            {d.store.name}
                          </Link>
                        ) : (
                          '–'
                        )}
                        {d.org && (
                          <span className="block text-xs text-muted-foreground">{d.org.name}</span>
                        )}
                      </TD>
                      <TD>
                        <DomainStatusBadge status={d.status} />
                      </TD>
                      <TD className="text-xs whitespace-nowrap">
                        <div className="grid gap-0.5">
                          <Check ok={d.dns?.ownership} label="Owner" />
                          <Check ok={d.dns?.routing} label="Points here" />
                        </div>
                      </TD>
                      <TD
                        className="whitespace-nowrap text-muted-foreground"
                        title={formatDateTime(when)}
                      >
                        {formatRelative(when)}
                      </TD>
                      <TD>
                        {editable && (
                          <DomainDecision
                            domain={d}
                            onDone={() => {
                              void queryClient.invalidateQueries({
                                queryKey: ['platform', 'store-domains'],
                              });
                              void queryClient.invalidateQueries({
                                queryKey: ['platform', 'stores'],
                              });
                            }}
                          />
                        )}
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
