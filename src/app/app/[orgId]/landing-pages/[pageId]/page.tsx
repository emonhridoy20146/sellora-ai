'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { LandingImageField } from '@/components/landing/image-field';
import { landingKeys, useLandingPage } from '@/components/landing/hooks';
import { OfferEditor } from '@/components/landing/offer-editor';
import { LandingPreviewButton } from '@/components/landing/preview-button';
import { LandingSectionList } from '@/components/landing/section-list';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { LandingContent, LandingPage, LandingSection } from '@/lib/api/types';
import { packageProblems, publishBlockers } from '@/lib/landing';
import { canonicalJson } from '@/lib/stores';

/** The API's error paths ("content.sections.3.url") as something a person can act on. */
function describeErrors(err: unknown, sections: LandingSection[]): string {
  if (!(err instanceof ApiError) || err.errors.length === 0) return errorMessage(err);
  return err.errors
    .map((e) => {
      const m = /^content\.sections\.(\d+)/.exec(e.path);
      const s = m ? sections[Number(m[1])] : undefined;
      return s ? `Section ${Number(m![1]) + 1}: ${e.message}` : e.message;
    })
    .join(' ');
}

function Editor({ page }: { page: LandingPage }) {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const editable = can('stores.manage') && page.store?.status !== 'suspended';
  const publisher = can('stores.publish');
  const [sections, setSections] = useState<LandingSection[]>(page.draft.sections);
  const [offer, setOffer] = useState<LandingContent['offer']>(page.draft.offer);
  const [seo, setSeo] = useState<LandingContent['seo']>(page.draft.seo);
  const [settings, setSettings] = useState<LandingContent['settings']>(page.draft.settings);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const draft: LandingContent = { sections, offer, seo, settings };
  const dirty = canonicalJson(draft) !== canonicalJson(page.draft);
  const blockers = publishBlockers(draft);
  const pkgProblem = Object.values(packageProblems(offer.packages, null))[0] ?? null;
  const addOnProblem = offer.addOn && !offer.addOn.label.trim() ? 'Say what the add-on is.' : null;
  const saveProblem = pkgProblem ?? addOnProblem;
  const key = landingKeys.page(org.id, page.id);

  const save = async (): Promise<LandingPage | null> => {
    if (saveProblem) {
      setError(saveProblem);
      return null;
    }
    setError(null);
    try {
      const saved = await api<LandingPage>(`/orgs/${org.id}/landing-pages/${page.id}/draft`, {
        method: 'PUT',
        body: { content: draft, revision: page.revision },
      });
      queryClient.setQueryData(key, saved);
      void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
      return saved;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'page_changed') setStale(true);
      setError(describeErrors(err, sections));
      return null;
    }
  };

  const onSave = async () => {
    setBusy('save');
    const saved = await save();
    setBusy(null);
    if (saved)
      toast.success(
        saved.status === 'live' ? 'Saved. Publish to show the changes to shoppers.' : 'Saved.',
      );
  };

  const onPublish = async () => {
    if (blockers.length) return setError(blockers[0]!);
    setBusy('publish');
    const saved = dirty ? await save() : page;
    if (!saved) return setBusy(null);
    try {
      const next = await api<LandingPage>(`/orgs/${org.id}/landing-pages/${page.id}/submit`, {
        method: 'POST',
      });
      queryClient.setQueryData(key, next);
      void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
      void queryClient.invalidateQueries({ queryKey: landingKeys.versions(org.id, page.id) });
      toast.success(
        next.submission?.status === 'pending'
          ? 'Sent for review. You get an email when it goes live.'
          : 'Published. Shoppers see it now.',
      );
    } catch (err) {
      setError(describeErrors(err, sections));
    } finally {
      setBusy(null);
    }
  };

  const pending =
    page.submission?.status === 'pending' && page.submission.revision === page.revision;
  const nothingNew = !dirty && page.published?.revision === page.revision && !page.takedown;

  return (
    <div className="grid gap-6 pb-20 lg:grid-cols-[1fr_280px]">
      <fieldset disabled={!editable || busy !== null} className="grid min-w-0 content-start gap-6">
        {!editable && (
          <Alert tone="info">Only the owner and admins can change landing pages.</Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Sections</CardTitle>
            <CardDescription>
              The page from top to bottom. Open a section to edit it. Hidden sections keep their
              words for later.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LandingSectionList
              sections={sections}
              setSections={setSections}
              orgId={org.id}
              language={page.language}
              disabled={!editable || busy !== null}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Offer</CardTitle>
            <CardDescription>
              What shoppers can order from this page. Prices are always worked out by Sellora, never
              by the shopper’s browser.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OfferEditor
              orgId={org.id}
              currency={org.currency}
              language={page.language}
              offer={offer}
              onChange={setOffer}
              disabled={!editable || busy !== null}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Order button on phones</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <label className="flex items-start gap-3 text-sm">
              <Switch
                checked={settings.stickyButton}
                onCheckedChange={(stickyButton) => setSettings((s) => ({ ...s, stickyButton }))}
                className="mt-0.5"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">
                  Keep an order button at the bottom of the screen
                </span>
                <span className="text-[13px] text-muted-foreground">
                  It jumps to the order form. Most shoppers come from ads on their phone.
                </span>
              </span>
            </label>
            {settings.stickyButton && (
              <Field
                label="Button text"
                htmlFor="lp-sticky"
                optional
                hint="Empty uses the order form’s button text."
                className="max-w-72"
              >
                <Input
                  id="lp-sticky"
                  value={settings.stickyLabel}
                  maxLength={30}
                  onChange={(e) => setSettings((s) => ({ ...s, stickyLabel: e.target.value }))}
                />
              </Field>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Search and sharing</CardTitle>
            <CardDescription>
              What Google and Facebook show when the link is shared. Empty fields use the page name
              and the product picture.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="Title" htmlFor="lp-seo-title" optional>
              <Input
                id="lp-seo-title"
                value={seo.title}
                maxLength={70}
                onChange={(e) => setSeo((s) => ({ ...s, title: e.target.value }))}
              />
            </Field>
            <Field label="Description" htmlFor="lp-seo-desc" optional>
              <Textarea
                id="lp-seo-desc"
                rows={2}
                value={seo.description}
                maxLength={200}
                onChange={(e) => setSeo((s) => ({ ...s, description: e.target.value }))}
              />
            </Field>
            <LandingImageField
              orgId={org.id}
              id="lp-seo-image-alt"
              label="Share picture"
              hint="Optional. 1200 × 630 pixels looks best on Facebook."
              value={seo.image}
              disabled={!editable || busy !== null}
              onChange={(image) => setSeo((s) => ({ ...s, image }))}
            />
            <label className="flex items-start gap-3 text-sm">
              <Switch
                checked={seo.index}
                onCheckedChange={(index) => setSeo((s) => ({ ...s, index }))}
                className="mt-0.5"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">Let search engines list this page</span>
                <span className="text-[13px] text-muted-foreground">
                  Turn off for pages only meant for ads.
                </span>
              </span>
            </label>
          </CardContent>
        </Card>
      </fieldset>

      <aside className="hidden lg:block">
        <div className="sticky top-20 grid gap-3">
          <p className="text-sm font-medium">Ready to publish?</p>
          {blockers.length === 0 ? (
            <p className="flex items-start gap-2 text-sm text-success">
              <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> Everything needed is
              there.
            </p>
          ) : (
            <ul className="grid gap-1.5 text-sm">
              {blockers.map((b) => (
                <li key={b} className="flex items-start gap-2 text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {b}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Publishing sends this version to Sellora for a quick check. The live version, if any,
            stays up until the new one is approved.
          </p>
          <LandingPreviewButton orgId={org.id} pageId={page.id} label="Preview saved draft" />
        </div>
      </aside>

      {editable && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur lg:left-60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-3 px-4 py-3 sm:px-6">
            {error ? (
              <p role="alert" className="mr-auto text-sm text-destructive">
                {error}
                {stale && (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-1 h-auto p-0"
                    onClick={() => void queryClient.invalidateQueries({ queryKey: key })}
                  >
                    Reload the page
                  </Button>
                )}
              </p>
            ) : (
              <p className="mr-auto text-sm text-muted-foreground">
                {dirty
                  ? 'You have unsaved changes.'
                  : pending
                    ? 'This version is waiting for review.'
                    : 'All changes saved.'}
              </p>
            )}
            <Button
              variant="ghost"
              disabled={!dirty || busy !== null}
              onClick={() => {
                setSections(page.draft.sections);
                setOffer(page.draft.offer);
                setSeo(page.draft.seo);
                setSettings(page.draft.settings);
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button
              variant={publisher ? 'outline' : 'default'}
              loading={busy === 'save'}
              disabled={!dirty || busy !== null}
              onClick={() => void onSave()}
            >
              Save draft
            </Button>
            {publisher && (
              <Button
                loading={busy === 'publish'}
                disabled={busy !== null || nothingNew || (pending && !dirty)}
                onClick={() => void onPublish()}
              >
                {page.published ? 'Publish changes' : 'Publish'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LandingEditorPage() {
  const { org } = useOrg();
  const { pageId } = useParams<{ pageId: string }>();
  const page = useLandingPage(org.id, pageId);
  if (!page.data) return null;
  // A saved draft comes back with a new revision; the editor starts again from it.
  return <Editor key={page.data.revision} page={page.data} />;
}
