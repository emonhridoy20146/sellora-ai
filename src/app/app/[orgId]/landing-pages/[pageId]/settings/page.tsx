'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { landingKeys, useLandingPage } from '@/components/landing/hooks';
import { OfferEndCard } from '@/components/landing/offer-end-card';
import { SlugField } from '@/components/landing/slug-field';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { LandingLanguage, LandingPage } from '@/lib/api/types';
import { slugProblem } from '@/lib/landing';

function SettingsForm({ page }: { page: LandingPage }) {
  const { org, can } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const editable = can('stores.manage');
  const [name, setName] = useState(page.name);
  const [slug, setSlug] = useState(page.slug);
  const [language, setLanguage] = useState<LandingLanguage>(page.language);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const dirty = name !== page.name || slug !== page.slug || language !== page.language;

  const save = async () => {
    const problem = slug !== page.slug ? slugProblem(slug) : null;
    if (problem) return setErrors({ slug: problem });
    if (name.trim().length < 2) return setErrors({ name: 'Name the page' });
    setBusy(true);
    setErrors({});
    try {
      const next = await api<LandingPage>(`/orgs/${org.id}/landing-pages/${page.id}`, {
        method: 'PATCH',
        body: {
          ...(name !== page.name ? { name: name.trim() } : {}),
          ...(slug !== page.slug ? { slug } : {}),
          ...(language !== page.language ? { language } : {}),
        },
      });
      queryClient.setQueryData(landingKeys.page(org.id, page.id), next);
      void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
      toast.success('Saved.');
    } catch (err) {
      if (err instanceof ApiError && err.errors.length)
        setErrors(Object.fromEntries(err.errors.map((e) => [e.path, e.message])));
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api(`/orgs/${org.id}/landing-pages/${page.id}`, { method: 'DELETE' }).catch(
      (err: unknown) => {
        toast.error(errorMessage(err));
        throw err;
      },
    );
    queryClient.removeQueries({ queryKey: landingKeys.page(org.id, page.id) });
    void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
    toast.success('Page deleted.');
    router.push(`/app/${org.id}/landing-pages`);
  };

  return (
    <div className="grid max-w-2xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Page</CardTitle>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!editable || busy} className="grid gap-4">
            <Field
              label="Page name"
              htmlFor="lps-name"
              hint="For you and your team."
              error={errors.name}
            >
              <Input
                id="lps-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <SlugField
              orgId={org.id}
              storeId={page.storeId}
              value={slug}
              current={page.slug}
              locked={page.slugLocked}
              error={errors.slug}
              onChange={setSlug}
            />
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Language</span>
              <Segmented<LandingLanguage>
                label="Language"
                value={language}
                onChange={setLanguage}
                options={[
                  { value: 'bn', label: 'বাংলা' },
                  { value: 'en', label: 'English' },
                ]}
              />
              <p className="text-[13px] text-muted-foreground">
                The words of the form, buttons and timer. Your own text stays as you wrote it.
              </p>
            </div>
            {editable && (
              <div className="flex justify-end">
                <Button loading={busy} disabled={!dirty} onClick={() => void save()}>
                  Save
                </Button>
              </div>
            )}
          </fieldset>
        </CardContent>
      </Card>

      {can('stores.publish') && <OfferEndCard page={page} orgId={org.id} />}

      {can('stores.publish') && (
        <Card>
          <CardHeader>
            <CardTitle>Delete page</CardTitle>
            <CardDescription>
              The page, its versions and its numbers are removed. Orders it took stay in Orders.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {page.takedown ? (
              <Alert tone="info">
                A page Sellora took down stays for the record. Contact support to remove it.
              </Alert>
            ) : (
              <Button variant="destructive" onClick={() => setDeleting(true)}>
                Delete page
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${page.name}?`}
        description={
          page.status === 'live'
            ? 'The page is live: its address stops working at once, so ads pointing to it will show a “not found” page.'
            : 'This cannot be undone.'
        }
        confirmLabel="Delete page"
        destructive
        onConfirm={() => remove()}
      />
    </div>
  );
}

export default function LandingSettingsPage() {
  const { org } = useOrg();
  const { pageId } = useParams<{ pageId: string }>();
  const page = useLandingPage(org.id, pageId);
  if (!page.data) return null;
  return <SettingsForm key={page.data.updatedAt} page={page.data} />;
}
