'use client';

import { useQueryClient } from '@tanstack/react-query';
import { FileText, Sparkles, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ProductPicker } from '@/components/commerce/product-picker';
import { useOrg } from '@/components/org-context';
import { seoKeys, useContentDrafts } from '@/components/seo/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type {
  ContentDraft,
  ContentKind,
  ContentTone,
  Product,
  TranslateTo,
  WriterLanguage,
} from '@/lib/api/types';
import { formatCredits, formatDateTime } from '@/lib/format';
import { CONTENT_KIND_LABEL, LANGUAGE_OPTIONS, TONE_LABEL, TRANSLATE_LABEL } from '@/lib/seo';

/** A draft variant as text to copy: headline, text, hashtags. */
function variantText(v: ContentDraft['variants'][number]): string {
  return [v.headline, v.text, v.hashtags.join(' ')].filter(Boolean).join('\n\n');
}

/**
 * The content studio (ADR 0032): Facebook ad copy, post captions, product descriptions and
 * translations between Bangla, English and Banglish. Every result is kept as a draft to copy.
 */
export default function ContentStudioPage() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const drafts = useContentDrafts(org.id);
  const editable = can('marketing.manage');
  const [kind, setKind] = useState<ContentKind>('facebook_ad');
  const [product, setProduct] = useState<Product | null>(null);
  const [source, setSource] = useState('');
  const [language, setLanguage] = useState<WriterLanguage>('bn');
  const [tone, setTone] = useState<ContentTone>('friendly');
  const [translateTo, setTranslateTo] = useState<TranslateTo>('bn');
  const [notes, setNotes] = useState('');
  const [variants, setVariants] = useState(3);
  const [busy, setBusy] = useState(false);

  const pick = (p: Product) => {
    setProduct(p);
    if (!source.trim())
      setSource([p.name, p.description].filter(Boolean).join('\n\n').slice(0, 8000));
  };

  const write = async () => {
    if (!source.trim()) return toast.error('Write what the text is about, or choose a product.');
    setBusy(true);
    try {
      await api<ContentDraft>(`/orgs/${org.id}/seo/content`, {
        body: {
          kind,
          ...(product ? { productId: product.id, productName: product.name } : {}),
          source: source.trim(),
          language,
          tone,
          translateTo,
          notes: notes.trim(),
          variants: kind === 'translate' ? 1 : variants,
        },
      });
      void queryClient.invalidateQueries({ queryKey: seoKeys.drafts(org.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: ContentDraft) => {
    try {
      await api(`/orgs/${org.id}/seo/content/${d.id}`, { method: 'DELETE' });
      void queryClient.invalidateQueries({ queryKey: seoKeys.drafts(org.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid gap-6">
      {editable && (
        <Card>
          <CardHeader>
            <CardTitle>Write with AI</CardTitle>
            <CardDescription>
              Uses AI credit. Results stay below as drafts; nothing is posted anywhere.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void write();
              }}
            >
              <Segmented
                label="What to write"
                value={kind}
                onChange={setKind}
                options={(Object.keys(CONTENT_KIND_LABEL) as ContentKind[]).map((k) => ({
                  value: k,
                  label: CONTENT_KIND_LABEL[k].name,
                }))}
              />
              <p className="-mt-2 text-[13px] text-muted-foreground">
                {CONTENT_KIND_LABEL[kind].use}
              </p>
              <div className="grid gap-2">
                <span className="text-sm font-medium">Product (optional)</span>
                {product ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Badge tone="info">{product.name}</Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove product"
                      onClick={() => setProduct(null)}
                    >
                      <X />
                    </Button>
                  </div>
                ) : (
                  <ProductPicker orgId={org.id} onPick={(p) => pick(p)} />
                )}
              </div>
              <Field
                label={kind === 'translate' ? 'Text to translate' : 'What it is about'}
                htmlFor="cs-source"
                hint="Facts only: what you sell, price, offer, delivery. AI does not add facts."
              >
                <Textarea
                  id="cs-source"
                  rows={5}
                  value={source}
                  maxLength={8000}
                  onChange={(e) => setSource(e.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                {kind === 'translate' ? (
                  <Field label="Translate to" htmlFor="cs-to">
                    <NativeSelect
                      id="cs-to"
                      value={translateTo}
                      onChange={(e) => setTranslateTo(e.target.value as TranslateTo)}
                    >
                      {(Object.keys(TRANSLATE_LABEL) as TranslateTo[]).map((t) => (
                        <option key={t} value={t}>
                          {TRANSLATE_LABEL[t]}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : (
                  <>
                    <Field label="Language" htmlFor="cs-lang">
                      <NativeSelect
                        id="cs-lang"
                        value={language}
                        onChange={(e) => setLanguage(e.target.value as WriterLanguage)}
                      >
                        {LANGUAGE_OPTIONS.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field label="Tone" htmlFor="cs-tone">
                      <NativeSelect
                        id="cs-tone"
                        value={tone}
                        onChange={(e) => setTone(e.target.value as ContentTone)}
                      >
                        {(Object.keys(TONE_LABEL) as ContentTone[]).map((t) => (
                          <option key={t} value={t}>
                            {TONE_LABEL[t]}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field label="Versions" htmlFor="cs-n">
                      <NativeSelect
                        id="cs-n"
                        value={variants}
                        onChange={(e) => setVariants(Number(e.target.value))}
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  </>
                )}
              </div>
              <Field label="Notes for the writer" htmlFor="cs-notes" optional>
                <Input
                  id="cs-notes"
                  value={notes}
                  maxLength={500}
                  placeholder="Mention free delivery in Dhaka"
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
              <div>
                <Button type="submit" loading={busy}>
                  <Sparkles /> Write
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="drafts-h" className="grid gap-3">
        <h2 id="drafts-h" className="text-base font-semibold">
          Drafts
        </h2>
        {!drafts.data ? (
          <Skeleton className="h-40" />
        ) : drafts.data.items.length === 0 ? (
          <Card>
            <EmptyState icon={FileText} title="No drafts yet">
              Write an ad, a caption, a description or a translation and it shows here.
            </EmptyState>
          </Card>
        ) : (
          drafts.data.items.map((d) => (
            <Card key={d.id}>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <CardTitle className="text-sm">
                    {CONTENT_KIND_LABEL[d.kind].name}
                    {d.productName ? `: ${d.productName}` : ''}
                  </CardTitle>
                  <CardDescription>
                    {formatDateTime(d.createdAt, org.timezone)} ·{' '}
                    {d.kind === 'translate' && d.translateTo
                      ? `to ${TRANSLATE_LABEL[d.translateTo]}`
                      : `${LANGUAGE_OPTIONS.find((l) => l.value === d.language)?.label}, ${TONE_LABEL[d.tone].toLowerCase()}`}{' '}
                    · {formatCredits(d.credits)}
                  </CardDescription>
                </div>
                {editable && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete draft"
                    onClick={() => void remove(d)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                {d.variants.map((v, i) => (
                  <div key={i} className="grid content-start gap-2 rounded-lg border p-3">
                    {v.headline && <p className="font-medium">{v.headline}</p>}
                    <p className="text-sm whitespace-pre-line">{v.text}</p>
                    {v.hashtags.length > 0 && (
                      <p className="text-[13px] text-primary">{v.hashtags.join(' ')}</p>
                    )}
                    <div>
                      <CopyButton value={variantText(v)} ariaLabel={`Copy version ${i + 1}`} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
