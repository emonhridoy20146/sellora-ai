'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ProductThumb } from '@/components/commerce/product-thumb';
import { landingKeys, useLandingTemplates } from '@/components/landing/hooks';
import { ProductChooser } from '@/components/landing/offer-editor';
import { SlugField } from '@/components/landing/slug-field';
import { useOrg } from '@/components/org-context';
import { useStores } from '@/components/stores/hooks';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { LandingLanguage, LandingPage, LandingTemplateKey, Product } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { slugProblem, toSlug } from '@/lib/landing';
import { cn } from '@/lib/utils';

export default function NewLandingPage() {
  const { org, can } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const stores = useStores(org.id);
  const templates = useLandingTemplates(org.id);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [template, setTemplate] = useState<LandingTemplateKey>('full_offer');
  const [language, setLanguage] = useState<LandingLanguage | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const usable = (stores.data?.items ?? []).filter((s) => s.status !== 'suspended');
  // One store is the usual case: it is chosen without asking.
  const store = usable.find((s) => s.id === storeId) ?? (usable.length === 1 ? usable[0]! : null);
  const lang = language ?? store?.language ?? 'en';

  const pickProduct = (p: Product) => {
    setProduct(p);
    if (!name.trim()) setName(p.name.slice(0, 80));
    if (!slugTouched) setSlug(toSlug(p.name) || 'offer');
  };

  const submit = async () => {
    setError(null);
    setFieldErrors({});
    if (!store) return setError('Choose the store the page belongs to.');
    if (!product) return setError('Choose the product the page sells.');
    if (name.trim().length < 2) return setFieldErrors({ name: 'Name the page' });
    const s = slug.trim();
    if (s && slugProblem(s)) return setFieldErrors({ slug: slugProblem(s)! });
    setBusy(true);
    try {
      const page = await api<LandingPage>(`/orgs/${org.id}/landing-pages`, {
        body: {
          storeId: store.id,
          name: name.trim(),
          ...(s ? { slug: s } : {}),
          productId: product.id,
          template,
          language: lang,
        },
      });
      queryClient.setQueryData(landingKeys.page(org.id, page.id), page);
      void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
      toast.success('Page created. Fill in the offer, then publish.');
      router.push(`/app/${org.id}/landing-pages/${page.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length)
        setFieldErrors(Object.fromEntries(err.errors.map((e) => [e.path, e.message])));
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!can('stores.manage'))
    return <Alert tone="info">Only the owner and admins can make landing pages.</Alert>;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Link
        href={`/app/${org.id}/landing-pages`}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Landing pages
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New landing page</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose what to sell and a starting layout. You can change every word afterwards.
        </p>
      </div>

      {stores.isPending ? (
        <Skeleton className="h-24" />
      ) : usable.length === 0 ? (
        <Alert tone="warning" title="Make a store first">
          <p>
            A landing page lives on your store’s web address and uses its colours and contact
            number. The store does not have to be open.
          </p>
          <Button asChild size="sm" className="mt-2">
            <Link href={`/app/${org.id}/store/new`}>Create store</Link>
          </Button>
        </Alert>
      ) : (
        <>
          {usable.length > 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Store</CardTitle>
                <CardDescription>The page uses this store’s address and look.</CardDescription>
              </CardHeader>
              <CardContent>
                <Field label="Store" htmlFor="lp-store" error={fieldErrors.storeId}>
                  <NativeSelect
                    id="lp-store"
                    value={store?.id ?? ''}
                    onChange={(e) => setStoreId(e.target.value || null)}
                  >
                    <option value="">Choose…</option>
                    {usable.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.host})
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Product</CardTitle>
              <CardDescription>
                One page sells one product. You set packages and an add-on in the editor.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {product ? (
                <div className="flex items-center gap-3 rounded-md border p-3">
                  <ProductThumb url={product.images[0]?.url} className="size-12" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{product.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatMoney(product.priceRange.minMinor, product.currency)}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setProduct(null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <ProductChooser orgId={org.id} id="lp-product" onPick={pickProduct} />
              )}
              {fieldErrors.productId && (
                <p role="alert" className="text-[13px] text-destructive">
                  {fieldErrors.productId}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Template</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {templates.data ? (
                <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Template">
                  {templates.data.items.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="radio"
                      aria-checked={template === t.key}
                      onClick={() => setTemplate(t.key)}
                      className={cn(
                        'relative grid content-start gap-1 rounded-lg border p-4 text-left transition-colors',
                        template === t.key
                          ? 'border-primary bg-info-soft'
                          : 'hover:border-foreground/30',
                      )}
                    >
                      {template === t.key && (
                        <Check className="absolute top-3 right-3 size-4 text-primary" aria-hidden />
                      )}
                      <span className="font-medium">{t.name}</span>
                      <span className="text-[13px] text-muted-foreground">{t.description}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <Skeleton className="h-28" />
              )}
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Language of the page</span>
                <Segmented<LandingLanguage>
                  label="Language of the page"
                  value={lang}
                  onChange={setLanguage}
                  options={[
                    { value: 'bn', label: 'বাংলা' },
                    { value: 'en', label: 'English' },
                  ]}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Name and address</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field
                label="Page name"
                htmlFor="lp-name"
                hint="For you; shoppers see the headline instead."
                error={fieldErrors.name}
              >
                <Input
                  id="lp-name"
                  value={name}
                  maxLength={80}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(toSlug(e.target.value));
                  }}
                />
              </Field>
              <SlugField
                orgId={org.id}
                storeId={store?.id ?? null}
                value={slug}
                error={fieldErrors.slug}
                onChange={(v) => {
                  setSlug(v);
                  setSlugTouched(true);
                }}
              />
            </CardContent>
          </Card>

          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button asChild variant="ghost">
              <Link href={`/app/${org.id}/landing-pages`}>Cancel</Link>
            </Button>
            <Button loading={busy} onClick={() => void submit()}>
              Create page
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
