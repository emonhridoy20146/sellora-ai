'use client';

import { useQueryClient } from '@tanstack/react-query';
import { FolderTree, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { commerceKeys, useCategories } from '@/components/commerce/hooks';
import { PageError } from '@/components/commerce/page-error';
import { ProductsTabs } from '@/components/commerce/products-tabs';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Category } from '@/lib/api/types';

export default function CategoriesPage() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const categories = useCategories(org.id);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const manage = can('catalog.manage');
  const refresh = () => queryClient.invalidateQueries({ queryKey: commerceKeys.all(org.id) });

  const open = (c: Category | 'new') => {
    setEditing(c);
    setName(c === 'new' ? '' : c.name);
    setError(null);
  };

  return (
    <>
      <PageHeader
        title="Products"
        description="Group products so customers and your team find them faster."
        actions={
          manage && (
            <Button onClick={() => open('new')}>
              <Plus /> Add category
            </Button>
          )
        }
      />
      <ProductsTabs orgId={org.id} />
      <Card>
        <CardContent className="px-0 py-0">
          {categories.isPending ? (
            <Skeleton className="m-5 h-32" />
          ) : categories.isError ? (
            <PageError error={categories.error} onRetry={() => void categories.refetch()} />
          ) : categories.data.length === 0 ? (
            <EmptyState icon={FolderTree} title="No categories yet">
              For example: Men, Women, Kids, Accessories.
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {categories.data.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.productCount ?? 0} product{c.productCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  {manage && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Rename ${c.name}`}
                        onClick={() => open(c)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => setDeleting(c)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing === 'new' ? 'Add category' : 'Rename category'}>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || !editing) return;
              setBusy(true);
              setError(null);
              (editing === 'new'
                ? api(`/orgs/${org.id}/categories`, { body: { name: name.trim() } })
                : api(`/orgs/${org.id}/categories/${editing.id}`, {
                    method: 'PATCH',
                    body: { name: name.trim() },
                  })
              )
                .then(async () => {
                  await refresh();
                  setEditing(null);
                })
                .catch((err: unknown) => setError(errorMessage(err)))
                .finally(() => setBusy(false));
            }}
          >
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Name" htmlFor="cat-name">
              <Input
                id="cat-name"
                autoFocus
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!name.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={`Delete ${deleting?.name ?? 'category'}?`}
        description="Its products stay; they just have no category."
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await api(`/orgs/${org.id}/categories/${deleting!.id}`, { method: 'DELETE' });
            await refresh();
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </>
  );
}
