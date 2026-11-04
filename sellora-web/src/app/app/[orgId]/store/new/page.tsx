'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { HandleField } from '@/components/stores/handle-field';
import { storeKeys, useThemes } from '@/components/stores/hooks';
import { ThemePicker } from '@/components/stores/theme-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Store, StoreLanguage } from '@/lib/api/types';
import { toHandle } from '@/lib/stores';

export default function NewStorePage() {
  const { org, can } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const themes = useThemes(org.id);
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(org.name);
  const [typedHandle, setTypedHandle] = useState<string | null>(null);
  const [language, setLanguage] = useState<StoreLanguage>(org.locale === 'bn' ? 'bn' : 'en');
  const [pick, setPick] = useState<{ themeKey: string; palette: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The address follows the name until the person types one of their own.
  const handle = typedHandle ?? toHandle(name);
  const catalog = themes.data;
  const chosen = pick ?? (catalog ? { themeKey: catalog.suggested[0]!, palette: 0 } : null);
  const chosenTheme = catalog?.items.find((t) => t.key === chosen?.themeKey);
  const colours = chosenTheme?.palettes[chosen?.palette ?? 0] ?? { primary: '', accent: '' };

  if (!can('stores.manage'))
    return <Alert tone="info">Only the owner and admins can create the online store.</Alert>;

  const next = () => {
    const found: Record<string, string> = {};
    if (name.trim().length < 2) found.name = 'Give the store a name';
    setErrors(found);
    if (Object.keys(found).length === 0) setStep(2);
  };

  const create = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const store = await api<Store>(`/orgs/${org.id}/stores`, {
        body: {
          name: name.trim(),
          ...(handle ? { handle } : {}),
          language,
          themeKey: chosen.themeKey,
          palette: chosen.palette,
        },
      });
      await queryClient.invalidateQueries({ queryKey: storeKeys.all(org.id) });
      queryClient.setQueryData(storeKeys.store(org.id, store.id), store);
      toast.success('Store created as a draft. Only you can see it for now.');
      router.push(`/app/${org.id}/store/${store.id}`);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'handle_taken' || err.fieldErrors().handle)) {
        setErrors({ handle: err.fieldErrors().handle ?? err.message });
        setStep(1);
      } else if (err instanceof ApiError && err.fieldErrors().name) {
        setErrors({ name: err.fieldErrors().name! });
        setStep(1);
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Create your online store"
        description={`Step ${step} of 2: ${step === 1 ? 'name and address' : 'choose a look'}`}
        actions={
          <Button asChild variant="ghost">
            <Link href={`/app/${org.id}/store`}>Cancel</Link>
          </Button>
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {step === 1 ? (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Name and address</CardTitle>
            <CardDescription>You can change both later, until the store opens.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              noValidate
              className="grid gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                next();
              }}
            >
              <Field label="Store name" htmlFor="store-name" error={errors.name}>
                <Input
                  id="store-name"
                  value={name}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <HandleField
                orgId={org.id}
                value={handle}
                error={errors.handle}
                onChange={(v) => {
                  setTypedHandle(v);
                  setErrors((e) => ({ ...e, handle: '' }));
                }}
              />
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Store language</span>
                <Segmented
                  label="Store language"
                  value={language}
                  onChange={setLanguage}
                  options={[
                    { value: 'en', label: 'English' },
                    { value: 'bn', label: 'বাংলা' },
                  ]}
                />
                <p className="text-[13px] text-muted-foreground">
                  Buttons, checkout and the starting text are in this language.
                </p>
              </div>
              <div className="flex justify-end">
                <Button type="submit">
                  Next <ArrowRight />
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : themes.isPending ? (
        <Skeleton className="h-96" />
      ) : themes.isError ? (
        <PageError error={themes.error} onRetry={() => void themes.refetch()} />
      ) : (
        <div className="grid gap-5">
          <p className="text-sm text-muted-foreground">
            Themes set the fonts, corners and layout; colours can change any time in Design.
          </p>
          <ThemePicker
            themes={themes.data.items}
            suggested={themes.data.suggested}
            themeKey={chosen?.themeKey ?? ''}
            colours={colours}
            storeName={name}
            disabled={busy}
            onPick={(t, palette) => setPick({ themeKey: t.key, palette })}
          />
          <div className="flex justify-between gap-2">
            <Button variant="outline" onClick={() => setStep(1)} disabled={busy}>
              <ArrowLeft /> Back
            </Button>
            <Button onClick={() => void create()} loading={busy} disabled={!chosen}>
              Create store
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
