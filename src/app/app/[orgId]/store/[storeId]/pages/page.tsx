'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { storeKeys, useStore } from '@/components/stores/hooks';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Store, StorePageKey } from '@/lib/api/types';
import { PAGE_INFO, PAGE_KEYS } from '@/lib/stores';

function PagesForm({ store }: { store: Store }) {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const editable = can('stores.manage');
  const [pages, setPages] = useState<Record<StorePageKey, string>>(store.pages);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        api<Store>(`/orgs/${org.id}/stores/${store.id}`, { method: 'PATCH', body: { pages } })
          .then((saved) => {
            queryClient.setQueryData(storeKeys.store(org.id, store.id), saved);
            toast.success('Saved.');
          })
          .catch((err: unknown) => setError(errorMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      <fieldset disabled={!editable || busy} className="grid max-w-3xl gap-6">
        {error && <Alert tone="danger">{error}</Alert>}
        <Card>
          <CardHeader>
            <CardTitle>Store pages</CardTitle>
            <CardDescription>
              Linked from the store footer. A page left empty is not shown. Delivery and returns
              start with sample text: read it and change it to match how you work.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {PAGE_KEYS.map((key) => {
              const info = PAGE_INFO[key];
              return (
                <Field
                  key={key}
                  label={info.label}
                  htmlFor={`page-${key}`}
                  optional
                  hint={`${info.hint} Leave a blank line between paragraphs.`}
                >
                  <Textarea
                    id={`page-${key}`}
                    rows={key === 'shipping' || key === 'returns' ? 5 : 4}
                    value={pages[key]}
                    maxLength={info.max}
                    onChange={(e) => setPages({ ...pages, [key]: e.target.value })}
                  />
                </Field>
              );
            })}
          </CardContent>
        </Card>
        {editable && (
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>
              Save pages
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

export default function StorePagesPage() {
  const { org } = useOrg();
  const { storeId } = useParams<{ storeId: string }>();
  const store = useStore(org.id, storeId);
  if (!store.data) return null;
  return <PagesForm key={store.data.updatedAt} store={store.data} />;
}
