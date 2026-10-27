'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, ShoppingBag, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { commerceKeys } from '@/components/commerce/hooks';
import { OrdersTable } from '@/components/commerce/orders-table';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Customer, Order, Page } from '@/lib/api/types';
import { addressLines, splitValues } from '@/lib/commerce';
import { formatDate, formatMoney, formatPercent } from '@/lib/format';

function DetailsForm({
  customer,
  onSaved,
}: {
  customer: Customer;
  onSaved: (c: Customer) => void;
}) {
  const { org, can } = useOrg();
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [email, setEmail] = useState(customer.email ?? '');
  const [tags, setTags] = useState(customer.tags.join(', '));
  const [notes, setNotes] = useState(customer.notes);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = can('customers.manage');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setErrors({});
            api<Customer>(`/orgs/${org.id}/customers/${customer.id}`, {
              method: 'PATCH',
              body: {
                name: name.trim(),
                phone: phone.trim() || null,
                email: email.trim() || null,
                tags: splitValues(tags),
                notes,
              },
            })
              .then((c) => {
                onSaved(c);
                toast.success('Saved.');
              })
              .catch((err: unknown) => {
                if (err instanceof ApiError) setErrors(err.fieldErrors());
                setError(errorMessage(err));
              })
              .finally(() => setBusy(false));
          }}
        >
          <fieldset disabled={!editable || busy} className="grid gap-4 sm:grid-cols-2">
            {error && (
              <Alert tone="danger" className="sm:col-span-2">
                {error}
              </Alert>
            )}
            <Field label="Name" htmlFor="cd-name" error={errors.name}>
              <Input
                id="cd-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Phone" htmlFor="cd-phone" optional error={errors.phone}>
              <Input
                id="cd-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor="cd-email" optional error={errors.email}>
              <Input
                id="cd-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Tags" htmlFor="cd-tags" optional hint="For example: wholesale, vip">
              <Input id="cd-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            <Field
              label="Notes"
              htmlFor="cd-notes"
              optional
              className="sm:col-span-2"
              hint="Only your team sees notes."
            >
              <Textarea
                id="cd-notes"
                value={notes}
                maxLength={5000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            {editable && (
              <div className="flex justify-end sm:col-span-2">
                <Button type="submit" loading={busy} disabled={!name.trim()}>
                  Save
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}

export default function CustomerPage() {
  const { org, can } = useOrg();
  const { customerId } = useParams<{ customerId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<'block' | 'delete' | null>(null);
  const key = commerceKeys.customer(org.id, customerId);
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Customer>(`/orgs/${org.id}/customers/${customerId}`),
  });
  const orders = useInfiniteQuery({
    queryKey: [...key, 'orders'],
    queryFn: ({ pageParam }) =>
      api<Page<Order>>(`/orgs/${org.id}/customers/${customerId}/orders`, {
        query: { limit: 10, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: can('orders.view'),
  });

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <PageError error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const finished = c.stats.delivered + c.stats.returned;
  const successRate = finished ? (c.stats.delivered / finished) * 100 : null;
  const saved = (next: Customer) => {
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: commerceKeys.customers(org.id), exact: false });
  };
  const orderItems = orders.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href={`/app/${org.id}/customers`}>
          <ArrowLeft /> Customers
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.name} {c.blocked && <Badge tone="danger">Blocked</Badge>}
          </span>
        }
        description={[c.phone, c.email, `customer since ${formatDate(c.createdAt, org.timezone)}`]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            {can('orders.create') && !c.blocked && (
              <Button asChild>
                <Link href={`/app/${org.id}/orders/new?customerId=${c.id}`}>
                  <ShoppingBag /> New order
                </Link>
              </Button>
            )}
            {can('customers.manage') && (
              <>
                <Button variant="outline" onClick={() => setConfirm('block')}>
                  <Ban /> {c.blocked ? 'Unblock' : 'Block'}
                </Button>
                {c.stats.orders === 0 && (
                  <Button variant="outline" onClick={() => setConfirm('delete')}>
                    <Trash2 /> Delete
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {c.blocked && (
        <Alert tone="warning" className="mb-6">
          New orders for this customer need an extra confirmation.
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Orders" value={c.stats.orders} sub={`${c.stats.cancelled} cancelled`} />
        <Stat
          label="Delivered"
          value={c.stats.delivered}
          sub={
            successRate === null
              ? 'No finished orders yet'
              : `${formatPercent(successRate, 0)} of finished orders`
          }
        />
        <Stat label="Returned" value={c.stats.returned} />
        <Stat
          label="Spent"
          value={formatMoney(c.stats.spentMinor, org.currency)}
          sub="Excludes cancelled and returned"
        />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid gap-6">
          <DetailsForm key={c.updatedAt} customer={c} onSaved={saved} />
          {can('orders.view') && (
            <Card>
              <CardHeader>
                <CardTitle>Orders</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {orders.isPending ? (
                  <Skeleton className="mx-5 mb-5 h-24" />
                ) : orders.isError ? (
                  <PageError error={orders.error} onRetry={() => void orders.refetch()} />
                ) : orderItems.length === 0 ? (
                  <EmptyState title="No orders yet" />
                ) : (
                  <OrdersTable
                    orgId={org.id}
                    orders={orderItems}
                    timezone={org.timezone}
                    showCustomer={false}
                  />
                )}
                <LoadMore
                  hasMore={Boolean(orders.hasNextPage)}
                  loading={orders.isFetchingNextPage}
                  onClick={() => void orders.fetchNextPage()}
                />
              </CardContent>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Addresses</CardTitle>
          </CardHeader>
          <CardContent>
            {c.addresses.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No saved address. One is added with the first order.
              </p>
            ) : (
              <ul className="grid gap-3 text-sm">
                {c.addresses.map((a, i) => (
                  <li key={i} className="rounded-md border p-3">
                    {a.name && <p className="font-medium">{a.name}</p>}
                    {addressLines(a).map((l) => (
                      <p key={l}>{l}</p>
                    ))}
                    {a.phone && <p className="text-muted-foreground">{a.phone}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        destructive={confirm === 'delete' || !c.blocked}
        title={
          confirm === 'delete'
            ? `Delete ${c.name}?`
            : c.blocked
              ? `Unblock ${c.name}?`
              : `Block ${c.name}?`
        }
        description={
          confirm === 'delete'
            ? 'This removes the customer and their saved addresses.'
            : c.blocked
              ? 'Orders for this customer will go through normally again.'
              : 'Use this for fake orders or people who refuse parcels. You can still place an order for them after an extra confirmation.'
        }
        confirmLabel={confirm === 'delete' ? 'Delete' : c.blocked ? 'Unblock' : 'Block'}
        onConfirm={async () => {
          try {
            if (confirm === 'delete') {
              await api(`/orgs/${org.id}/customers/${c.id}`, { method: 'DELETE' });
              await queryClient.invalidateQueries({ queryKey: commerceKeys.customers(org.id) });
              router.push(`/app/${org.id}/customers`);
            } else {
              saved(
                await api<Customer>(`/orgs/${org.id}/customers/${c.id}`, {
                  method: 'PATCH',
                  body: { blocked: !c.blocked },
                }),
              );
            }
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </>
  );
}
