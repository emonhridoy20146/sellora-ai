'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { DomainCard } from '@/components/stores/domain-card';
import { storeKeys, useStore } from '@/components/stores/hooks';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Store, StoreDomain, StoreDomainList } from '@/lib/api/types';

export default function StoreDomainPage() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const { storeId } = useParams<{ storeId: string }>();
  const store = useStore(org.id, storeId);
  const key = [...storeKeys.store(org.id, storeId), 'domains'] as const;
  const domains = useQuery({
    queryKey: key,
    queryFn: () => api<StoreDomainList>(`/orgs/${org.id}/stores/${storeId}/domains`),
    // Sellora checks waiting domains by itself; keep the page in step while one waits.
    refetchInterval: (q) =>
      q.state.data?.items.some((d) => d.status === 'pending' || d.status === 'review')
        ? 30_000
        : false,
  });
  const [input, setInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StoreDomain | null>(null);
  const canManage = can('stores.manage');

  if (store.isPending || domains.isPending) return <Skeleton className="h-64" />;
  if (!store.data) return null;
  if (domains.isError)
    return (
      <Alert tone="danger" action={<Button onClick={() => void domains.refetch()}>Retry</Button>}>
        {errorMessage(domains.error)}
      </Alert>
    );
  const s = store.data;
  const list = domains.data;
  const full = list.limit !== null && list.used >= list.limit;
  const storeFull = list.items.length >= list.maxPerStore;

  const refresh = async (updated?: Store) => {
    if (updated) queryClient.setQueryData(storeKeys.store(org.id, s.id), updated);
    else
      await queryClient.invalidateQueries({ queryKey: storeKeys.store(org.id, s.id), exact: true });
    await queryClient.invalidateQueries({ queryKey: key });
  };

  const add = async () => {
    setAdding(true);
    setAddError(null);
    try {
      const d = await api<StoreDomain>(`/orgs/${org.id}/stores/${s.id}/domains`, {
        method: 'POST',
        body: { domain: input },
      });
      setInput('');
      await refresh();
      toast.success(`${d.displayDomain} added. Now add its DNS records.`);
    } catch (err) {
      setAddError(
        err instanceof ApiError ? (err.fieldErrors().domain ?? err.message) : errorMessage(err),
      );
    } finally {
      setAdding(false);
    }
  };

  const act = async (d: StoreDomain, action: 'check' | 'primary') => {
    setBusy(d.id);
    try {
      if (action === 'check') {
        const after = await api<StoreDomain>(
          `/orgs/${org.id}/stores/${s.id}/domains/${d.id}/check`,
          { method: 'POST' },
        );
        await refresh();
        if (after.status !== d.status)
          toast.success(
            after.status === 'active'
              ? `${after.displayDomain} is connected.`
              : `The records are right. ${after.displayDomain} is now in review.`,
          );
        else if (after.status === 'pending') toast.info('Not there yet. See what is still to do.');
        else toast.success('Checked.');
      } else {
        const updated = await api<Store>(`/orgs/${org.id}/stores/${s.id}/primary-domain`, {
          method: 'PUT',
          body: { domainId: d.id },
        });
        await refresh(updated);
        toast.success(`Shoppers are now sent to ${d.displayDomain}.`);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const makeSelloraMain = async () => {
    setBusy('sellora');
    try {
      const updated = await api<Store>(`/orgs/${org.id}/stores/${s.id}/primary-domain`, {
        method: 'PUT',
        body: { domainId: null },
      });
      await refresh(updated);
      toast.success('The Sellora address is the main address again.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid max-w-3xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Sellora address</CardTitle>
          <CardDescription>
            Every store has one. It keeps working whatever else you add.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium break-all">{s.host}</span>
          {!s.primaryDomain && (
            <Badge tone="info">
              <Star aria-hidden /> Main address
            </Badge>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <CopyButton value={s.selloraUrl} label="Copy link" />
            {s.primaryDomain && canManage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void makeSelloraMain()}
              >
                <Star /> Make main address
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your own domain</CardTitle>
          <CardDescription>
            Use a domain you bought, such as www.yourshop.com. You add two records where you bought
            it; Sellora checks them, and the store opens there once approved.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!list.enabled ? (
            <Alert tone="info">
              Custom domains are not available on this server yet. Your store works at its Sellora
              address.
            </Alert>
          ) : list.limit === 0 ? (
            <Alert tone="info">
              Your plan does not include your own domain.{' '}
              {can('billing.view') && (
                <Link href={`/app/${org.id}/billing/plans`} className="text-primary underline">
                  See plans
                </Link>
              )}
            </Alert>
          ) : (
            canManage && (
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (input.trim()) void add();
                }}
              >
                <Field
                  label="Domain"
                  htmlFor="domain-input"
                  error={addError ?? undefined}
                  hint={
                    list.apexAllowed
                      ? 'A subdomain such as www.yourshop.com, or the domain itself.'
                      : 'Use a subdomain such as www.yourshop.com or shop.yourshop.com.'
                  }
                >
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="domain-input"
                      placeholder="www.yourshop.com"
                      autoComplete="off"
                      spellCheck={false}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      disabled={full || storeFull}
                      aria-invalid={addError ? true : undefined}
                      aria-describedby={addError ? 'domain-input-error' : 'domain-input-hint'}
                    />
                    <Button
                      type="submit"
                      disabled={adding || full || storeFull || !input.trim()}
                      className="shrink-0"
                    >
                      <Plus /> Add domain
                    </Button>
                  </div>
                </Field>
                {(full || storeFull) && (
                  <p className="text-sm text-muted-foreground">
                    {storeFull
                      ? `A store can have ${list.maxPerStore} domains. Remove one to add another.`
                      : `Your plan allows ${list.limit} domain${list.limit === 1 ? '' : 's'}.`}
                  </p>
                )}
              </form>
            )
          )}

          {list.items.length === 0 ? (
            list.enabled &&
            list.limit !== 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                <Globe className="size-5 shrink-0" aria-hidden />
                No domain yet. Shoppers use the Sellora address.
              </div>
            )
          ) : (
            <div className="grid gap-3">
              {list.items.map((d) => (
                <DomainCard
                  key={d.id}
                  domain={d}
                  canManage={canManage}
                  busy={busy !== null}
                  onCheck={() => void act(d, 'check')}
                  onPrimary={() => void act(d, 'primary')}
                  onRemove={() => setRemoving(d)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.displayDomain ?? 'domain'}?`}
        description={
          removing?.status === 'active'
            ? 'Shoppers can no longer reach the store there. Also delete its records where you bought the domain.'
            : 'You can add it again later. Also delete its records where you bought the domain.'
        }
        confirmLabel="Remove domain"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api(`/orgs/${org.id}/stores/${s.id}/domains/${removing.id}`, {
              method: 'DELETE',
            });
            await refresh();
            toast.success('Domain removed.');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </div>
  );
}
