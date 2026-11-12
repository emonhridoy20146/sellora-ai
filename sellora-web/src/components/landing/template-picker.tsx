'use client';

import { Check, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { LandingTemplateCategory, LandingTemplateList } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/** What a new page starts from: a built-in template's key, or one of the business's own. */
export type TemplateChoice = { kind: 'builtin'; key: string } | { kind: 'mine'; id: string };

type Tab = LandingTemplateCategory | 'mine';

/**
 * The template gallery (ADR 0031): 30 built-in templates by kind of business, and the
 * business's own saved ones.
 */
export function TemplatePicker({
  data,
  value,
  onChange,
  onDelete,
}: {
  data: LandingTemplateList;
  value: TemplateChoice;
  onChange: (v: TemplateChoice) => void;
  onDelete?: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const tabs: { key: Tab; label: string; count: number }[] = [
    ...data.categories.map((c) => ({
      key: c.key,
      label: c.label,
      count: data.items.filter((t) => t.category === c.key).length,
    })),
    { key: 'mine', label: 'My templates', count: data.mine.items.length },
  ];
  const card = (selected: boolean) =>
    cn(
      'relative grid content-start gap-1 rounded-lg border p-4 text-left transition-colors',
      selected ? 'border-primary bg-info-soft' : 'hover:border-foreground/30',
    );

  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Kind of business" className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-sm transition-colors',
              tab === t.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'hover:border-foreground/30',
            )}
          >
            {t.label}
            <span className="ml-1 text-xs opacity-70">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'mine' ? (
        data.mine.items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No templates of your own yet. In the editor of a page you like, choose “Save as
            template” to start new pages from its sections. You can keep up to {data.mine.limit}.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="My templates">
            {data.mine.items.map((t) => {
              const selected = value.kind === 'mine' && value.id === t.id;
              return (
                <div key={t.id} className="relative">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onChange({ kind: 'mine', id: t.id })}
                    className={cn(card(selected), 'w-full pr-12')}
                  >
                    {selected && (
                      <Check className="absolute top-3 right-3 size-4 text-primary" aria-hidden />
                    )}
                    <span className="font-medium">{t.name}</span>
                    <span className="text-[13px] text-muted-foreground">
                      {t.description || 'Your own layout.'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t.sections} sections · {t.packages} packages · {t.pictures} pictures ·{' '}
                      {t.language === 'bn' ? 'বাংলা' : 'English'}
                    </span>
                  </button>
                  {onDelete && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute right-2 bottom-2"
                      aria-label={`Delete template ${t.name}`}
                      onClick={() => onDelete(t.id)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Template">
          {data.items
            .filter((t) => t.category === tab)
            .map((t) => {
              const selected = value.kind === 'builtin' && value.key === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange({ kind: 'builtin', key: t.key })}
                  className={card(selected)}
                >
                  {selected && (
                    <Check className="absolute top-3 right-3 size-4 text-primary" aria-hidden />
                  )}
                  <span className="pr-5 font-medium">{t.name}</span>
                  <span className="text-[13px] text-muted-foreground">{t.description}</span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
