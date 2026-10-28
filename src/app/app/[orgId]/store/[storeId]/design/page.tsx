'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCategories } from '@/components/commerce/hooks';
import { useOrg } from '@/components/org-context';
import { storeKeys, useStore, useThemes } from '@/components/stores/hooks';
import { ImagePicker } from '@/components/stores/image-picker';
import { PreviewButton } from '@/components/stores/preview-button';
import { SectionEditor } from '@/components/stores/section-editor';
import { ThemePicker, ThemeSketch } from '@/components/stores/theme-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  CardStyle,
  FontChoice,
  HeaderStyle,
  RadiusChoice,
  Store,
  StoreSection,
  StoreTheme,
} from '@/lib/api/types';
import { canonicalJson, primaryColourWarning, sectionProblem } from '@/lib/stores';

const HEX = /^#[0-9a-f]{6}$/i;

function ColourField({
  id,
  label,
  value,
  onChange,
  warning,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  warning?: string | null;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      error={!HEX.test(value) ? 'Use a colour like #7a1f2b' : (warning ?? undefined)}
    >
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={HEX.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded-md border bg-card p-1"
        />
        <Input
          id={id}
          value={value}
          maxLength={7}
          spellCheck={false}
          className="w-28 font-mono"
          onChange={(e) => onChange(e.target.value.trim())}
        />
      </div>
    </Field>
  );
}

function DesignForm({ store }: { store: Store }) {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const themes = useThemes(org.id);
  const categories = useCategories(org.id);
  const editable = can('stores.manage');
  const [themeKey, setThemeKey] = useState(store.themeKey);
  const [theme, setTheme] = useState<Omit<StoreTheme, 'sections'>>(() => {
    const { sections: _sections, ...rest } = store.theme;
    return rest;
  });
  const [sections, setSections] = useState<StoreSection[]>(store.theme.sections);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draft = { themeKey, theme: { ...theme, sections } };
  const dirty =
    canonicalJson(draft) !== canonicalJson({ themeKey: store.themeKey, theme: store.theme });
  const set = <K extends keyof typeof theme>(key: K, value: (typeof theme)[K]) =>
    setTheme((t) => ({ ...t, [key]: value }));
  const coloursOk = HEX.test(theme.palette.primary) && HEX.test(theme.palette.accent);
  const problem = sections.map(sectionProblem).find(Boolean) ?? null;

  const save = async () => {
    if (!coloursOk) return setError('Fix the colours first.');
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Store>(`/orgs/${org.id}/stores/${store.id}/theme`, {
        method: 'PUT',
        body: draft,
      });
      queryClient.setQueryData(storeKeys.store(org.id, store.id), saved);
      void queryClient.invalidateQueries({ queryKey: storeKeys.all(org.id), exact: true });
      toast.success(store.status === 'live' ? 'Saved. Shoppers see it now.' : 'Saved.');
    } catch (err) {
      setError(
        err instanceof ApiError && err.errors.length
          ? err.errors.map((e) => `${e.path.replace(/^theme\./, '')}: ${e.message}`).join(' ')
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 pb-20 lg:grid-cols-[1fr_280px]">
      <fieldset disabled={!editable || busy} className="grid min-w-0 content-start gap-6">
        {!editable && (
          <Alert tone="info">Only the owner and admins can change the store design.</Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Theme</CardTitle>
            <CardDescription>
              A theme sets the fonts, corners and layout. Picking one resets those to its defaults;
              your sections and pictures stay.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {themes.data ? (
              <ThemePicker
                themes={themes.data.items}
                suggested={themes.data.suggested}
                themeKey={themeKey}
                colours={theme.palette}
                storeName={store.name}
                disabled={!editable || busy}
                onPick={(t, i) => {
                  const p = t.palettes[i]!;
                  setThemeKey(t.key);
                  setTheme((x) => ({
                    ...x,
                    ...t.defaults,
                    palette: { primary: p.primary, accent: p.accent },
                  }));
                }}
              />
            ) : (
              <Skeleton className="h-64" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Colours and style</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="flex flex-wrap gap-6">
              <ColourField
                id="c-primary"
                label="Main colour"
                value={theme.palette.primary}
                warning={
                  HEX.test(theme.palette.primary)
                    ? primaryColourWarning(theme.palette.primary)
                    : null
                }
                onChange={(primary) => set('palette', { ...theme.palette, primary })}
              />
              <ColourField
                id="c-accent"
                label="Accent colour"
                value={theme.palette.accent}
                onChange={(accent) => set('palette', { ...theme.palette, accent })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Headings</span>
                <Segmented<FontChoice>
                  label="Heading font"
                  value={theme.font}
                  onChange={(v) => set('font', v)}
                  options={[
                    { value: 'sans', label: 'Clean' },
                    { value: 'serif', label: 'Elegant' },
                    { value: 'rounded', label: 'Friendly' },
                  ]}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Corners</span>
                <Segmented<RadiusChoice>
                  label="Corners"
                  value={theme.radius}
                  onChange={(v) => set('radius', v)}
                  options={[
                    { value: 'none', label: 'Square' },
                    { value: 'small', label: 'Soft' },
                    { value: 'large', label: 'Round' },
                  ]}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Header</span>
                <Segmented<HeaderStyle>
                  label="Header style"
                  value={theme.header}
                  onChange={(v) => set('header', v)}
                  options={[
                    { value: 'left', label: 'Logo left' },
                    { value: 'centered', label: 'Centred' },
                    { value: 'bold', label: 'Coloured' },
                  ]}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Product cards</span>
                <Segmented<CardStyle>
                  label="Product card style"
                  value={theme.card}
                  onChange={(v) => set('card', v)}
                  options={[
                    { value: 'plain', label: 'Plain' },
                    { value: 'bordered', label: 'Border' },
                    { value: 'soft', label: 'Shadow' },
                  ]}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Logo and announcement</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <ImagePicker
              orgId={org.id}
              label="Logo"
              aspect="square"
              maxSide={512}
              hint="Optional. A square logo shows next to the store name."
              value={theme.logo}
              disabled={!editable || busy}
              onChange={(logo) => set('logo', logo)}
            />
            <Field
              label="Announcement bar"
              htmlFor="announcement"
              optional
              hint="One line across the top of every page, like “Free delivery in Dhaka this week”."
            >
              <Input
                id="announcement"
                value={theme.announcement}
                maxLength={140}
                onChange={(e) => set('announcement', e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Home page</CardTitle>
            <CardDescription>
              Sections from top to bottom. Hidden sections keep their text for later.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SectionEditor
              sections={sections}
              setSections={setSections}
              orgId={org.id}
              language={store.language}
              storeName={store.name}
              categories={categories.data ?? []}
              disabled={!editable || busy}
            />
          </CardContent>
        </Card>
      </fieldset>

      <aside className="hidden lg:block">
        <div className="sticky top-20 grid gap-3">
          <p className="text-sm font-medium">At a glance</p>
          <ThemeSketch
            name={store.name}
            look={{
              ...theme.palette,
              font: theme.font,
              radius: theme.radius,
              header: theme.header,
              card: theme.card,
            }}
          />
          <p className="text-xs text-muted-foreground">
            A sketch of your choices. Save, then preview to see the real store.
          </p>
          <PreviewButton orgId={org.id} storeId={store.id} label="Preview saved store" />
        </div>
      </aside>

      {editable && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur lg:left-60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-3 px-4 py-3 sm:px-6">
            {error ? (
              <p role="alert" className="mr-auto text-sm text-destructive">
                {error}
              </p>
            ) : (
              <p className="mr-auto text-sm text-muted-foreground">
                {dirty ? 'You have unsaved changes.' : 'All changes saved.'}
              </p>
            )}
            <Button
              variant="ghost"
              disabled={!dirty || busy}
              onClick={() => {
                setThemeKey(store.themeKey);
                const { sections: saved, ...rest } = store.theme;
                setTheme(rest);
                setSections(saved);
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button loading={busy} disabled={!dirty} onClick={() => void save()}>
              Save design
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function StoreDesignPage() {
  const { org } = useOrg();
  const { storeId } = useParams<{ storeId: string }>();
  const store = useStore(org.id, storeId);
  if (!store.data) return null;
  // A saved design comes back as a new version; the form starts again from it.
  return <DesignForm key={store.data.updatedAt} store={store.data} />;
}
