'use client';

import {
  ChevronDown,
  ChevronUp,
  Copy,
  Ellipsis,
  Monitor,
  Pencil,
  Plus,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { HideOn, LandingLanguage, LandingSection, LandingSectionType } from '@/lib/api/types';
import {
  HIDE_ON_LABEL,
  LANDING_SECTION_HINT,
  LANDING_SECTION_LABEL,
  LANDING_SECTION_TYPES,
  MAX_LANDING_SECTIONS,
  landingSectionProblem,
  landingSectionSummary,
  newLandingSection,
} from '@/lib/landing';
import { moveItem, newSectionId } from '@/lib/stores';
import { cn } from '@/lib/utils';
import { LandingSectionFields, type LandingPatch } from './section-fields';

/**
 * The page, top to bottom: show or hide sections (also per device), move, copy, edit and
 * remove them, or add new ones (up to thirty; one order form).
 */
export function LandingSectionList({
  sections,
  setSections,
  orgId,
  language,
  disabled,
}: {
  sections: LandingSection[];
  setSections: Dispatch<SetStateAction<LandingSection[]>>;
  orgId: string;
  language: LandingLanguage;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const update = (id: string, patch: LandingPatch) =>
    setSections((list) =>
      list.map((s) => (s.id === id ? ({ ...s, ...patch } as LandingSection) : s)),
    );
  const add = (type: LandingSectionType) => {
    const s = newLandingSection(type, language);
    setSections((list) => {
      // New sections go above the order form, which usually closes the page.
      const form = list.findIndex((x) => x.type === 'order_form');
      if (type === 'order_form' || form === -1) return [...list, s];
      return [...list.slice(0, form), s, ...list.slice(form)];
    });
    setOpen(s.id);
  };
  const hasForm = sections.some((s) => s.type === 'order_form');
  const addable = LANDING_SECTION_TYPES.filter((t) => t !== 'order_form' || !hasForm);

  return (
    <div className="grid gap-2">
      {sections.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          The page is empty. Add sections, and an order form at the end.
        </p>
      )}
      <ol className="grid gap-2">
        {sections.map((s, i) => {
          const expanded = open === s.id;
          const problem = landingSectionProblem(s);
          const label = LANDING_SECTION_LABEL[s.type];
          return (
            <li
              key={s.id}
              data-section={s.type}
              className={cn('rounded-lg border bg-card', !s.enabled && 'bg-muted/40')}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="flex flex-col">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={disabled || i === 0}
                    aria-label={`Move ${label} up`}
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
                    aria-label={`Move ${label} down`}
                    onClick={() => setSections((list) => moveItem(list, i, 1))}
                  >
                    <ChevronDown />
                  </Button>
                </div>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  aria-expanded={expanded}
                  aria-controls={`ls-${s.id}-body`}
                  onClick={() => setOpen(expanded ? null : s.id)}
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {label}
                    {s.hideOn === 'mobile' && (
                      <Monitor className="size-3" aria-label="Computers only" />
                    )}
                    {s.hideOn === 'desktop' && (
                      <Smartphone className="size-3" aria-label="Phones only" />
                    )}
                  </span>
                  <span
                    className={cn(
                      'block truncate text-sm font-medium',
                      !s.enabled && 'text-muted-foreground',
                    )}
                  >
                    {landingSectionSummary(s)}
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
                    aria-label={`Show ${label} section`}
                    onCheckedChange={(enabled) => update(s.id, { enabled })}
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${label}`}
                  aria-pressed={expanded}
                  onClick={() => setOpen(expanded ? null : s.id)}
                >
                  <Pencil />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      aria-label={`More for ${label}`}
                    >
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {s.type !== 'order_form' && sections.length < MAX_LANDING_SECTIONS && (
                      <DropdownMenuItem
                        onSelect={() =>
                          setSections((list) => {
                            const copy = { ...structuredClone(s), id: newSectionId() };
                            return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
                          })
                        }
                      >
                        <Copy /> Copy section
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => setSections((list) => list.filter((x) => x.id !== s.id))}
                    >
                      <Trash2 /> Remove section
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {expanded && (
                <div id={`ls-${s.id}-body`} className="grid gap-4 border-t px-4 py-4">
                  <fieldset disabled={disabled} className="grid gap-4">
                    <LandingSectionFields
                      section={s}
                      orgId={orgId}
                      disabled={disabled}
                      onChange={(patch) => update(s.id, patch)}
                    />
                    <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
                      <label htmlFor={`ls-${s.id}-hide`} className="text-muted-foreground">
                        Show on
                      </label>
                      <NativeSelect
                        id={`ls-${s.id}-hide`}
                        className="h-8 w-auto"
                        value={s.hideOn}
                        onChange={(e) => update(s.id, { hideOn: e.target.value as HideOn })}
                      >
                        {(Object.keys(HIDE_ON_LABEL) as HideOn[]).map((k) => (
                          <option key={k} value={k}>
                            {HIDE_ON_LABEL[k]}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  </fieldset>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {sections.length < MAX_LANDING_SECTIONS && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled}>
              <Plus /> Add section
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-96 w-80 overflow-y-auto">
            {addable.map((type) => (
              <DropdownMenuItem key={type} onSelect={() => add(type)}>
                <span className="grid">
                  <span className="font-medium">{LANDING_SECTION_LABEL[type]}</span>
                  <span className="text-xs text-muted-foreground">
                    {LANDING_SECTION_HINT[type]}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
