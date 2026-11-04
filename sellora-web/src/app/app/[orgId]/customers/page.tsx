'use client';

import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AddressFields, cleanAddress, emptyAddress } from '@/components/commerce/address-fields';
import { commerceKeys } from '@/components/commerce/hooks';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Address, Customer, Page } from '@/lib/api/types';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

function AddCustomerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { org } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [address, setAddress] = useState<Address>(emptyAddress);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add customer" wide>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setErrors({});
            setExistingId(null);
            const addr = cleanAddress(address);
            api<Customer>(`/orgs/${org.id}/customers`, {
              body: {
                name: name.trim(),
                ...(phone.trim() ? { phone: phone.trim() } : {}),
                ...(email.trim() ? { email: email.trim() } : {}),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
                ...(addr.line1 ? { addresses: [addr] } : {}),
              },
            })
              .then(async (c) => {
                await queryClient.invalidateQueries({ queryKey: commerceKeys.customers(org.id) });
                router.push(`/app/${org.id}/customers/${c.id}`);
              })
              .catch((err: unknown) => {
                if (err instanceof ApiError) {
                  setErrors(err.fieldErrors());
                  const id = err.details.customerId;
                  if (err.code === 'customer_phone_taken' && typeof id === 'string')
                    setExistingId(id);
                }
                setError(errorMessage(err));
              })
              .finally(() => setBusy(false));
          }}
        >
          {error && (
            <Alert
              tone="danger"
              action={
                existingId && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/app/${org.id}/customers/${existingId}`}>Open customer</Link>
                  </Button>
                )
              }
            >
              {error}
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="c-name" error={errors.name}>
              <Input
                id="c-name"
                autoFocus
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Phone" htmlFor="c-phone" optional error={errors.phone}>
              <Input
                id="c-phone"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor="c-email" optional error={errors.email}>
              <Input
                id="c-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          </div>
          <AddressFields
            idPrefix="c-addr"
            value={address}
            onChange={setAddress}
            errors={{ line1: errors['addresses.0.line1'], phone: errors['addresses.0.phone'] }}
          />
          <Field label="Notes" htmlFor="c-notes" optional hint="Only your team sees notes.">
            <Textarea id="c-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              Add customer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function CustomersPage() {
  const { org, can } = useOrg();
  const [search, setSearch] = useState('');
  const [blocked, setBlocked] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useDebounced(search.trim());
  const list = useInfiniteQuery({
    queryKey: [...commerceKeys.customers(org.id), 'list', q, blocked],
    queryFn: ({ pageParam }) =>
      api<Page<Customer>>(`/orgs/${org.id}/customers`, {
        query: { q, blocked, limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(q || blocked);

  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone who has ordered or talked to you. One phone number is one customer."
        actions={
          can('customers.manage') && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add customer
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b px-5 py-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="absolute top-2.5 left-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <label htmlFor="c-search" className="sr-only">
              Search customers
            </label>
            <Input
              id="c-search"
              className="h-9 pl-8"
              placeholder="Name, phone or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label htmlFor="c-blocked" className="sr-only">
            Blocked
          </label>
          <NativeSelect
            id="c-blocked"
            className="w-40"
            value={blocked}
            onChange={(e) => setBlocked(e.target.value)}
          >
            <option value="">Everyone</option>
            <option value="true">Blocked only</option>
            <option value="false">Not blocked</option>
          </NativeSelect>
        </div>
        <CardContent className={cn('px-0 py-0', list.isPlaceholderData && 'opacity-60')}>
          {list.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : list.isError ? (
            <PageError error={list.error} onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title={filtered ? 'No customers match' : 'No customers yet'}
            >
              {!filtered && 'Customers are added when you create orders, or you can add them here.'}
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Customer</TH>
                  <TH className="text-right">Orders</TH>
                  <TH className="text-right">Delivered</TH>
                  <TH className="text-right">Returned</TH>
                  <TH className="text-right">Spent</TH>
                  <TH>Last order</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link
                        href={`/app/${org.id}/customers/${c.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {c.name}
                      </Link>
                      {c.blocked && (
                        <Badge tone="danger" className="ml-2">
                          Blocked
                        </Badge>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {c.phone ?? c.email ?? 'No contact'}
                      </span>
                    </TD>
                    <TD className="tabular text-right">{c.stats.orders}</TD>
                    <TD className="tabular text-right">{c.stats.delivered}</TD>
                    <TD
                      className={cn(
                        'tabular text-right',
                        c.stats.returned > 0 && 'font-medium text-destructive',
                      )}
                    >
                      {c.stats.returned}
                    </TD>
                    <TD className="tabular text-right whitespace-nowrap">
                      {formatMoney(c.stats.spentMinor, org.currency)}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {formatDate(c.stats.lastOrderAt, org.timezone)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          />
        </CardContent>
      </Card>
      {adding && <AddCustomerDialog open={adding} onOpenChange={setAdding} />}
    </>
  );
}
