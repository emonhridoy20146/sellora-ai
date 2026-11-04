'use client';

import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import type {
  Category,
  FeatureIcon,
  ProductSource,
  SectionType,
  StoreLanguage,
  StoreSection,
} from '@/lib/api/types';
import {
  FEATURE_ICONS,
  MAX_SECTIONS,
  SECTION_HINT,
  SECTION_LABEL,
  moveItem,
  newSection,
  sectionProblem,
  sectionSummary,
} from '@/lib/stores';
import { cn } from '@/lib/utils';
import { ImagePicker } from './image-picker';

/** A change to one section: any of its own fields (distributes over the section kinds). */
type Patch<T> = T extends unknown ? Partial<Omit<T, 'id' | 'type'>> : never;

function SectionFields({
  section: s,
  onChange,
  orgId,
  categories,
  disabled,
}: {
  section: StoreSection;
  onChange: (patch: Patch<StoreSection>) => void;
  orgId: string;
  categories: Category[];
  disabled?: boolean;
}) {
  const fid = (name: string) => `s-${s.id}-${name}`;
  switch (s.type) {
    case 'hero':
    case 'banner':
      return (
        <div className="grid gap-4">
          <Field label="Heading" htmlFor={fid('heading')}>
            <Input
              id={fid('heading')}
              value={s.heading}
              maxLength={80}
              onChange={(e) => onChange({ heading: e.target.value })}
            />
          </Field>
          {s.type === 'hero' ? (
            <Field label="Text under the heading" htmlFor={fid('sub')} optional>
              <Textarea
                id={fid('sub')}
                rows={2}
                value={s.subheading}
                maxLength={200}
                onChange={(e) => onChange({ subheading: e.target.value })}
              />
            </Field>
          ) : (
            <Field label="Text" htmlFor={fid('text')} optional>
              <Textarea
                id={fid('text')}
                rows={2}
                value={s.text}
                maxLength={200}
                onChange={(e) => onChange({ text: e.target.value })}
              />
            </Field>
          )}
          <Field
            label="Button"
            htmlFor={fid('button')}
            optional
            hint="Opens your products. Leave empty for no button."
          >
            <Input
              id={fid('button')}
              value={s.buttonLabel}
              maxLength={30}
              className="max-w-60"
              onChange={(e) => onChange({ buttonLabel: e.target.value })}
            />
          </Field>
          <ImagePicker
            orgId={orgId}
            label="Picture"
            hint={
              s.type === 'hero'
                ? 'Optional. A wide photo, at least 1600 pixels across. Text sits on the left.'
                : 'Optional. A wide photo for the background.'
            }
            value={s.image}
            maxSide={2000}
            disabled={disabled}
            onChange={(image) => onChange({ image })}
          />
        </div>
      );
    case 'categories':
      return (
        <Field label="Title" htmlFor={fid('title')}>
          <Input
            id={fid('title')}
            value={s.title}
            maxLength={60}
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </Field>
      );
    case 'products':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" htmlFor={fid('title')} className="sm:col-span-2">
            <Input
              id={fid('title')}
              value={s.title}
              maxLength={60}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </Field>
          <Field label="Show" htmlFor={fid('source')}>
            <NativeSelect
              id={fid('source')}
              value={s.source}
              onChange={(e) => {
                const source = e.target.value as ProductSource;
                onChange({ source, categoryId: source === 'category' ? s.categoryId : null });
              }}
            >
              <option value="newest">Newest products</option>
              <option value="bestsellers">Best sellers</option>
              <option value="category">One category</option>
            </NativeSelect>
          </Field>
          {s.source === 'category' && (
            <Field
              label="Category"
              htmlFor={fid('category')}
              error={!s.categoryId ? 'Choose a category' : undefined}
            >
              <NativeSelect
                id={fid('category')}
                value={s.categoryId ?? ''}
                onChange={(e) => onChange({ categoryId: e.target.value || null })}
              >
                <option value="">Choose…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <div className="grid gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">How many</span>
            <Segmented
              label="How many products"
              value={String(s.limit) as '4' | '8' | '12'}
              onChange={(v) => onChange({ limit: Number(v) as 4 | 8 | 12 })}
              options={[
                { value: '4', label: '4' },
                { value: '8', label: '8' },
                { value: '12', label: '12' },
              ]}
            />
          </div>
        </div>
      );
    case 'features':
      return (
        <div className="grid gap-3">
          {s.items.map((item, i) => (
            <div
              key={i}
              className="grid items-start gap-3 rounded-md border p-3 sm:grid-cols-[140px_1fr_auto]"
            >
              <Field label="Icon" htmlFor={fid(`icon-${i}`)}>
                <NativeSelect
                  id={fid(`icon-${i}`)}
                  value={item.icon}
                  onChange={(e) =>
                    onChange({
                      items: s.items.map((x, j) =>
                        j === i ? { ...x, icon: e.target.value as FeatureIcon } : x,
                      ),
                    })
                  }
                >
                  {FEATURE_ICONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid gap-3">
                <Field
                  label="Title"
                  htmlFor={fid(`title-${i}`)}
                  error={!item.title.trim() ? 'Add a title' : undefined}
                >
                  <Input
                    id={fid(`title-${i}`)}
                    value={item.title}
                    maxLength={40}
                    onChange={(e) =>
                      onChange({
                        items: s.items.map((x, j) =>
                          j === i ? { ...x, title: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field label="Text" htmlFor={fid(`text-${i}`)} optional>
                  <Input
                    id={fid(`text-${i}`)}
                    value={item.text}
                    maxLength={120}
                    onChange={(e) =>
                      onChange({
                        items: s.items.map((x, j) =>
                          j === i ? { ...x, text: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="sm:mt-6"
                disabled={s.items.length <= 1}
                aria-label={`Remove ${item.title || 'reason'}`}
                onClick={() => onChange({ items: s.items.filter((_, j) => j !== i) })}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {s.items.length < 4 && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange({ items: [...s.items, { icon: 'shield', title: '', text: '' }] })
                }
              >
                <Plus /> Add reason
              </Button>
            </div>
          )}
        </div>
      );
    case 'text':
      return (
        <div className="grid gap-4">
          <Field label="Heading" htmlFor={fid('heading')}>
            <Input
              id={fid('heading')}
              value={s.heading}
              maxLength={80}
              onChange={(e) => onChange({ heading: e.target.value })}
            />
          </Field>
          <Field label="Text" htmlFor={fid('body')} hint="Leave a blank line between paragraphs.">
            <Textarea
              id={fid('body')}
              rows={5}
              value={s.body}
              maxLength={2000}
              onChange={(e) => onChange({ body: e.target.value })}
            />
          </Field>
        </div>
      );
  }
}

/**
 * The home page, top to bottom: turn sections on and off, move them, edit their words and
 * pictures, or add new ones (up to twelve).
 */
export function SectionEditor({
  sections,
  setSections,
  orgId,
  language,
  storeName,
  categories,
  disabled,
}: {
  sections: StoreSection[];
  setSections: Dispatch<SetStateAction<StoreSection[]>>;
  orgId: string;
  language: StoreLanguage;
  storeName: string;
  categories: Category[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const update = (id: string, patch: Patch<StoreSection>) =>
    setSections((list) =>
      list.map((s) => (s.id === id ? ({ ...s, ...patch } as StoreSection) : s)),
    );
  const add = (type: SectionType) => {
    const s = newSection(type, language, storeName);
    setSections((list) => [...list, s]);
    setOpen(s.id);
  };

  return (
    <div className="grid gap-2">
      {sections.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          The home page is empty. Add a section to show something.
        </p>
      )}
      <ol className="grid gap-2">
        {sections.map((s, i) => {
          const expanded = open === s.id;
          const problem = sectionProblem(s);
          return (
            <li key={s.id} className={cn('rounded-lg border bg-card', !s.enabled && 'bg-muted/40')}>
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="flex flex-col">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={disabled || i === 0}
                    aria-label={`Move ${SECTION_LABEL[s.type]} up`}
                    onClick={() => setSections((list) => moveItem(list, i, -1))}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={disabled || i === sections.length - 1}
                    aria-label={`Move ${SECTION_LABEL[s.type]} down`}
                    onClick={() => setSections((list) => moveItem(list, i, 1))}
                  >
                    <ChevronDown />
                  </Button>
                </div>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  aria-expanded={expanded}
                  aria-controls={`s-${s.id}-body`}
                  onClick={() => setOpen(expanded ? null : s.id)}
                >
                  <span className="block text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {SECTION_LABEL[s.type]}
                  </span>
                  <span
                    className={cn(
                      'block truncate text-sm font-medium',
                      !s.enabled && 'text-muted-foreground',
                    )}
                  >
                    {sectionSummary(s)}
                  </span>
                  {problem && !expanded && (
                    <span className="block text-xs text-destructive">{problem}</span>
                  )}
                </button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="hidden sm:inline">{s.enabled ? 'Shown' : 'Hidden'}</span>
                  <Switch
                    checked={s.enabled}
                    disabled={disabled}
                    aria-label={`Show ${SECTION_LABEL[s.type]} section`}
                    onCheckedChange={(enabled) => update(s.id, { enabled })}
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${SECTION_LABEL[s.type]}`}
                  aria-pressed={expanded}
                  onClick={() => setOpen(expanded ? null : s.id)}
                >
                  <Pencil />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={`Remove ${SECTION_LABEL[s.type]}`}
                  onClick={() => setSections((list) => list.filter((x) => x.id !== s.id))}
                >
                  <Trash2 />
                </Button>
              </div>
              {expanded && (
                <div id={`s-${s.id}-body`} className="border-t px-4 py-4">
                  <fieldset disabled={disabled}>
                    <SectionFields
                      section={s}
                      orgId={orgId}
                      categories={categories}
                      disabled={disabled}
                      onChange={(patch) => update(s.id, patch)}
                    />
                  </fieldset>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {sections.length < MAX_SECTIONS && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled}>
              <Plus /> Add section
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {(Object.keys(SECTION_LABEL) as SectionType[]).map((type) => (
              <DropdownMenuItem key={type} onSelect={() => add(type)}>
                <span className="grid">
                  <span className="font-medium">{SECTION_LABEL[type]}</span>
                  <span className="text-xs text-muted-foreground">{SECTION_HINT[type]}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
