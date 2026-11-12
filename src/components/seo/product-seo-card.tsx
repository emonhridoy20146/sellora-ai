'use client';

import { CircleCheck, CircleX, Plus, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { PhotoItem } from '@/components/commerce/photo-manager';
import { useOrg } from '@/components/org-context';
import { useStores } from '@/components/stores/hooks';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Product, SeoSuggestion, WriterLanguage } from '@/lib/api/types';
import { formatCredits } from '@/lib/format';
import {
  BAND_LABEL,
  CHECK_LABEL,
  FAQ_MAX,
  LANGUAGE_OPTIONS,
  applySuggestion,
  completeFaq,
  draftKeywords,
  googlePreview,
  productSlug,
  scoreBand,
  type SeoDraft,
} from '@/lib/seo';
import { META_MAX, TITLE_MAX, scoreProductSeo, visibleLength } from '@/lib/seo-score';
import { cn } from '@/lib/utils';

function Counter({ value, max }: { value: string; max: number }) {
  const n = visibleLength(value);
  return (
    <span className={cn('tabular', n > max && 'text-destructive')}>
      {n}/{max}
    </span>
  );
}

const BAND_TONE = { good: 'success', fair: 'warning', poor: 'danger' } as const;

/** What the AI writer needs from the rest of the form. */
export interface SeoMaterial {
  name: string;
  description: string;
  tags: string[];
  categoryId: string | null;
  priceMinor: number | null;
}

/**
 * The product form's "Search engines" card (ADR 0032): focus keyword, search title, meta
 * description, address, photo alt texts and questions, with a Google preview and a live
 * score using the same rules as the SEO page. "Write with AI" suggests every field; nothing
 * changes until the business uses a suggestion, and nothing is saved until they save.
 */
export function ProductSeoCard({
  product,
  draft,
  setDraft,
  material,
  photos,
  setPhotos,
  onUseDescription,
  onUseTags,
  errors,
  editable,
}: {
  product?: Product;
  draft: SeoDraft;
  setDraft: (fn: (d: SeoDraft) => SeoDraft) => void;
  material: SeoMaterial;
  photos: PhotoItem[];
  setPhotos: (fn: (p: PhotoItem[]) => PhotoItem[]) => void;
  onUseDescription: (text: string) => void;
  onUseTags: (tags: string[]) => void;
  errors: Record<string, string>;
  editable: boolean;
}) {
  const { org, can, modules } = useOrg();
  const seoInPlan = modules === null || modules.includes('seo');
  const stores = useStores(org.id);
  const store = stores.data?.items.find((s) => s.status === 'live') ?? stores.data?.items[0];

  const ready = photos.filter((p) => p.state === 'ready');
  const slug = productSlug(draft.slug) || productSlug(material.name);
  const keywords = draftKeywords(draft);

  // How many other products use the same title or description (checked after typing stops).
  const [dupes, setDupes] = useState({ sameTitle: 0, sameMeta: 0 });
  const titleForDupes = draft.title.trim() || material.name.trim();
  const metaForDupes = draft.meta.trim();
  const checkDupes = seoInPlan && can('catalog.view');
  useEffect(() => {
    if (!checkDupes || (!titleForDupes && !metaForDupes)) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<{ sameTitle: number; sameMeta: number }>(`/orgs/${org.id}/seo/duplicates`, {
        query: {
          title: titleForDupes || undefined,
          meta: metaForDupes || undefined,
          exceptId: product?.id,
        },
        signal: ctl.signal,
      })
        .then(setDupes)
        .catch(() => undefined);
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [org.id, product?.id, titleForDupes, metaForDupes, checkDupes]);

  const score = scoreProductSeo({
    name: material.name,
    slug,
    seoTitle: draft.title,
    metaDescription: draft.meta,
    description: material.description,
    keywords,
    images: ready.map((p) => ({ alt: p.alt })),
    faqCount: completeFaq(draft.faq).length,
    sameTitle: dupes.sameTitle,
    sameMeta: dupes.sameMeta,
  });
  const band = scoreBand(score.score);
  const preview = googlePreview({
    storeName: store?.name ?? org.name,
    storeUrl: store?.url ?? null,
    slug,
    title: draft.title,
    name: material.name || 'Product name',
    meta: draft.meta,
    description: material.description,
  });

  // ------------------------------------------------------------ AI suggestion
  const [language, setLanguage] = useState<WriterLanguage>('bn');
  const [writing, setWriting] = useState(false);
  const [suggestion, setSuggestion] = useState<(SeoSuggestion & { credits: number }) | null>(null);
  const write = async () => {
    if (!material.name.trim()) return toast.error('Enter the product name first.');
    setWriting(true);
    try {
      const res = await api<{ suggestion: SeoSuggestion; credits: number }>(
        `/orgs/${org.id}/seo/write/product`,
        {
          body: {
            ...(product ? { productId: product.id } : {}),
            name: material.name.trim(),
            description: material.description,
            tags: material.tags,
            categoryId: material.categoryId,
            imageCount: ready.length,
            priceMinor: material.priceMinor,
            focusKeyword: draft.focus.trim() || null,
            language,
          },
        },
      );
      setSuggestion({ ...res.suggestion, credits: res.credits });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWriting(false);
    }
  };
  const applyFields = (fields: Parameters<typeof applySuggestion>[2]) =>
    suggestion && setDraft((d) => applySuggestion(d, suggestion, fields));
  const applyAlts = () =>
    suggestion &&
    setPhotos((list) => {
      let i = 0;
      return list.map((p) =>
        p.state === 'ready' ? { ...p, alt: suggestion.imageAlts[i++] ?? p.alt } : p,
      );
    });
  const applyAll = () => {
    if (!suggestion) return;
    applyFields(['keywords', 'title', 'meta', 'faq', ...(product ? [] : (['slug'] as const))]);
    applyAlts();
    toast.success('Suggestion used. Check it, then save the product.');
  };

  const setFaq = (i: number, patch: Partial<SeoDraft['faq'][number]>) =>
    setDraft((d) => ({ ...d, faq: d.faq.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));

  const slugChanged =
    product && productSlug(draft.slug) && productSlug(draft.slug) !== product.slug;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Search engines</CardTitle>
          <CardDescription>
            How this product shows on Google. The score updates as you type.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2" aria-live="polite">
          <span className="tabular text-2xl font-semibold" data-testid="seo-score">
            {score.score}
          </span>
          <Badge tone={BAND_TONE[band]}>{BAND_LABEL[band]}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        {editable && can('catalog.manage') && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3">
            {seoInPlan ? (
              <>
                <Segmented
                  label="Language of the suggestion"
                  value={language}
                  onChange={setLanguage}
                  options={LANGUAGE_OPTIONS}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void write()}
                  loading={writing}
                >
                  <Sparkles /> Write with AI
                </Button>
                <p className="text-[13px] text-muted-foreground">
                  Uses AI credit. Nothing changes until you use the suggestion and save.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                AI writing of search fields comes with the AI SEO studio.{' '}
                {can('billing.view') && (
                  <Link
                    href={`/app/${org.id}/billing/plans`}
                    className="text-primary hover:underline"
                  >
                    See plans
                  </Link>
                )}
              </p>
            )}
          </div>
        )}

        {suggestion && (
          <div className="grid gap-3 rounded-lg border bg-muted/40 p-4" aria-label="AI suggestion">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                Suggestion{' '}
                <span className="font-normal text-muted-foreground">
                  ({formatCredits(suggestion.credits)})
                </span>
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={applyAll}>
                  Use all
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
            <dl className="grid gap-3 text-sm">
              <SuggestionRow label="Keywords" onUse={() => applyFields(['keywords'])}>
                {suggestion.keywords.join(', ')}
              </SuggestionRow>
              <SuggestionRow label="Search title" onUse={() => applyFields(['title'])}>
                {suggestion.seoTitle}
              </SuggestionRow>
              <SuggestionRow label="Meta description" onUse={() => applyFields(['meta'])}>
                {suggestion.metaDescription}
              </SuggestionRow>
              <SuggestionRow label="Address" onUse={() => applyFields(['slug'])}>
                /products/{suggestion.slug}
              </SuggestionRow>
              <SuggestionRow
                label="Description"
                onUse={() => onUseDescription(suggestion.description)}
              >
                <span className="line-clamp-4 whitespace-pre-line">{suggestion.description}</span>
              </SuggestionRow>
              {suggestion.tags.length > 0 && (
                <SuggestionRow label="Tags" onUse={() => onUseTags(suggestion.tags)}>
                  {suggestion.tags.join(', ')}
                </SuggestionRow>
              )}
              {suggestion.imageAlts.length > 0 && (
                <SuggestionRow label="Photo alt text" onUse={applyAlts}>
                  {suggestion.imageAlts.join(' · ')}
                </SuggestionRow>
              )}
              {suggestion.faq.length > 0 && (
                <SuggestionRow label="Questions" onUse={() => applyFields(['faq'])}>
                  <ul className="grid gap-1">
                    {suggestion.faq.map((f) => (
                      <li key={f.question}>
                        <span className="font-medium">{f.question}</span> {f.answer}
                      </li>
                    ))}
                  </ul>
                </SuggestionRow>
              )}
            </dl>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Focus keyword"
            htmlFor="seo-focus"
            hint="The one phrase shoppers type, in Bangla, English or Banglish"
          >
            <Input
              id="seo-focus"
              value={draft.focus}
              maxLength={80}
              placeholder="জামদানি শাড়ি"
              onChange={(e) => setDraft((d) => ({ ...d, focus: e.target.value }))}
            />
          </Field>
          <Field
            label="Other keywords"
            htmlFor="seo-more"
            optional
            hint="Separate with commas, up to 9"
            error={errors['seo.keywords']}
          >
            <Input
              id="seo-more"
              value={draft.more}
              placeholder="jamdani saree, dhakai jamdani"
              onChange={(e) => setDraft((d) => ({ ...d, more: e.target.value }))}
            />
          </Field>
          <Field
            label="Search title"
            htmlFor="seo-title"
            optional
            className="sm:col-span-2"
            hint={
              <>
                <Counter value={draft.title || material.name} max={TITLE_MAX} /> Empty: the product
                name is used.
              </>
            }
            error={errors['seo.title']}
          >
            <Input
              id="seo-title"
              value={draft.title}
              maxLength={70}
              placeholder={material.name}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </Field>
          <Field
            label="Meta description"
            htmlFor="seo-meta"
            optional
            className="sm:col-span-2"
            hint={
              <>
                <Counter value={draft.meta} max={META_MAX} /> The short text under the title on
                Google.
              </>
            }
            error={errors['seo.description']}
          >
            <Textarea
              id="seo-meta"
              rows={3}
              value={draft.meta}
              maxLength={170}
              onChange={(e) => setDraft((d) => ({ ...d, meta: e.target.value }))}
            />
          </Field>
          <Field
            label="Address"
            htmlFor="seo-slug"
            optional={!product}
            className="sm:col-span-2"
            error={errors.slug}
            hint={
              slugChanged
                ? `The old address /products/${product.slug} will send shoppers and Google here.`
                : product
                  ? 'Changing it keeps the old address working: it redirects here.'
                  : 'Empty: made from the name.'
            }
          >
            <div className="flex items-center rounded-md border border-input bg-card shadow-xs focus-within:ring-2 focus-within:ring-ring/40">
              <span className="pl-3 text-sm text-muted-foreground">/products/</span>
              <input
                id="seo-slug"
                className="h-9 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
                value={draft.slug}
                maxLength={120}
                placeholder={productSlug(material.name)}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                onBlur={() =>
                  setDraft((d) => ({ ...d, slug: d.slug.trim() ? productSlug(d.slug) : '' }))
                }
              />
            </div>
          </Field>
        </div>

        <section aria-labelledby="seo-preview-h" className="grid gap-2">
          <h3 id="seo-preview-h" className="text-sm font-medium">
            Google preview
          </h3>
          <div className="rounded-lg border bg-card p-4" data-testid="google-preview">
            <p className="truncate text-[13px] text-muted-foreground">{preview.url}</p>
            <p className="mt-0.5 text-lg leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">
              {preview.title}
            </p>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {preview.text || 'Add a meta description so Google shows your words here.'}
            </p>
          </div>
        </section>

        {ready.length > 0 && (
          <section aria-labelledby="seo-alts-h" className="grid gap-3">
            <div>
              <h3 id="seo-alts-h" className="text-sm font-medium">
                Photo alt text
              </h3>
              <p className="text-[13px] text-muted-foreground">
                A few words on what each photo shows, for Google Images and screen readers.
              </p>
            </div>
            <ul className="grid gap-2">
              {ready.map((p, i) => (
                <li key={p.key} className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- product photo thumbnail */}
                  <img
                    src={p.url}
                    alt=""
                    className="size-10 shrink-0 rounded border object-cover"
                  />
                  <Input
                    aria-label={`Alt text for photo ${i + 1}`}
                    value={p.alt ?? ''}
                    maxLength={200}
                    placeholder={`Photo ${i + 1}`}
                    onChange={(e) =>
                      setPhotos((list) =>
                        list.map((x) => (x.key === p.key ? { ...x, alt: e.target.value } : x)),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="seo-faq-h" className="grid gap-3">
          <div>
            <h3 id="seo-faq-h" className="text-sm font-medium">
              Questions and answers
            </h3>
            <p className="text-[13px] text-muted-foreground">
              Shown on the product page and given to Google. Answer what shoppers ask before they
              buy.
            </p>
          </div>
          {draft.faq.map((f, i) => (
            <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto]">
              <div className="grid gap-2">
                <Input
                  aria-label={`Question ${i + 1}`}
                  placeholder="Is it handwoven?"
                  value={f.question}
                  maxLength={200}
                  onChange={(e) => setFaq(i, { question: e.target.value })}
                />
                <Textarea
                  aria-label={`Answer ${i + 1}`}
                  rows={2}
                  placeholder="Yes, woven by hand in Narayanganj."
                  value={f.answer}
                  maxLength={1000}
                  onChange={(e) => setFaq(i, { answer: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove question ${i + 1}`}
                onClick={() => setDraft((d) => ({ ...d, faq: d.faq.filter((_, j) => j !== i) }))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {draft.faq.length < FAQ_MAX && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraft((d) => ({ ...d, faq: [...d.faq, { question: '', answer: '' }] }))
                }
              >
                <Plus /> Add a question
              </Button>
            </div>
          )}
        </section>

        <details className="group rounded-lg border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            Checklist: {score.checks.filter((c) => c.ok).length} of {score.checks.length} done
          </summary>
          <ul className="grid gap-2 border-t px-4 py-3" data-testid="seo-checklist">
            {score.checks.map((c) => (
              <li key={c.key} className="flex gap-2 text-sm">
                {c.ok ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />
                ) : (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="To do" />
                )}
                <span>
                  <span className="font-medium">{CHECK_LABEL[c.key].name}</span>{' '}
                  <span className="text-muted-foreground">({c.detail})</span>
                  {!c.ok && (
                    <span className="block text-[13px] text-muted-foreground">
                      {CHECK_LABEL[c.key].fix}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
        {product?.previousSlugs.length ? (
          <Alert tone="info" title="Old addresses that still work">
            {product.previousSlugs.map((s) => `/products/${s}`).join(', ')} redirect here.
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({
  label,
  onUse,
  children,
}: {
  label: string;
  onUse: () => void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[140px_1fr_auto] sm:items-start sm:gap-3">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
      <Button type="button" size="sm" variant="outline" onClick={onUse} className="w-fit">
        Use
      </Button>
    </div>
  );
}
