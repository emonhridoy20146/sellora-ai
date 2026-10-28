'use client';

import { Check, Sparkles } from 'lucide-react';
import type {
  CardStyle,
  FontChoice,
  HeaderStyle,
  RadiusChoice,
  ThemeManifest,
} from '@/lib/api/types';
import { cn } from '@/lib/utils';

const FONT_FAMILY: Record<FontChoice, string> = {
  sans: 'var(--font-sans), system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
};
const RADIUS: Record<RadiusChoice, string> = { none: '0px', small: '3px', large: '8px' };

export interface ThemeLook {
  primary: string;
  accent: string;
  font: FontChoice;
  radius: RadiusChoice;
  header: HeaderStyle;
  card: CardStyle;
}

/**
 * A small drawing of a store with these choices: header, a hero and two product cards.
 * It is a sketch to compare themes, not the real store (the preview link shows that).
 */
export function ThemeSketch({ look, name }: { look: ThemeLook; name: string }) {
  const r = RADIUS[look.radius];
  const bold = look.header === 'bold';
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-md border bg-white text-[8px] text-stone-800"
      style={{ fontFamily: FONT_FAMILY[look.font] }}
    >
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-1.5',
          look.header === 'centered' ? 'justify-center' : 'justify-between',
        )}
        style={bold ? { background: look.primary, color: '#fff' } : undefined}
      >
        <span className="truncate text-[9px] font-semibold">{name}</span>
        {look.header !== 'centered' && (
          <span className="flex gap-1 opacity-70">
            <span className="h-1 w-3 rounded-full bg-current" />
            <span className="h-1 w-3 rounded-full bg-current" />
          </span>
        )}
      </div>
      <div
        className="px-2 py-3"
        style={{ background: `color-mix(in oklab, ${look.primary} 10%, white)` }}
      >
        <div className="mb-1 h-1.5 w-2/3 rounded-full" style={{ background: '#292524' }} />
        <div className="mb-2 h-1 w-1/2 rounded-full bg-stone-400" />
        <span
          className="inline-block px-2 py-0.5 text-[7px] font-semibold text-white"
          style={{ background: look.primary, borderRadius: r }}
        >
          Shop
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 p-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            style={{
              borderRadius: r,
              border: look.card === 'bordered' ? '1px solid #e7e5e4' : undefined,
              boxShadow: look.card === 'soft' ? '0 2px 6px rgb(0 0 0 / 0.12)' : undefined,
            }}
            className="overflow-hidden"
          >
            <div
              className="aspect-[4/3]"
              style={{
                background:
                  i === 0
                    ? `color-mix(in oklab, ${look.accent} 35%, white)`
                    : `color-mix(in oklab, ${look.primary} 25%, white)`,
                borderRadius: look.card === 'plain' ? r : undefined,
              }}
            />
            <div className={cn('space-y-0.5 py-1', look.card !== 'plain' && 'px-1')}>
              <div className="h-1 w-3/4 rounded-full bg-stone-300" />
              <div className="h-1 w-1/3 rounded-full" style={{ background: look.primary }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Theme cards with their colour palettes. Picking a palette also picks its theme. The
 * themes that suit the business come first, marked as suggested.
 */
export function ThemePicker({
  themes,
  suggested,
  themeKey,
  colours,
  storeName,
  onPick,
  disabled,
}: {
  themes: ThemeManifest[];
  suggested: string[];
  themeKey: string;
  colours: { primary: string; accent: string };
  storeName: string;
  onPick: (theme: ThemeManifest, paletteIndex: number) => void;
  disabled?: boolean;
}) {
  const ordered = [
    ...suggested.flatMap((k) => themes.filter((t) => t.key === k)),
    ...themes.filter((t) => !suggested.includes(t.key)),
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Theme">
      {ordered.map((t) => {
        const selected = t.key === themeKey;
        const paletteIndex = selected
          ? t.palettes.findIndex(
              (p) =>
                p.primary.toLowerCase() === colours.primary.toLowerCase() &&
                p.accent.toLowerCase() === colours.accent.toLowerCase(),
            )
          : -1;
        const shown = t.palettes[Math.max(0, paletteIndex)]!;
        const look: ThemeLook = selected
          ? { ...t.defaults, ...colours }
          : { ...t.defaults, primary: shown.primary, accent: shown.accent };
        return (
          <div
            key={t.key}
            className={cn(
              'flex flex-col gap-3 rounded-lg border bg-card p-3 transition-shadow',
              selected ? 'border-primary ring-2 ring-primary/30' : 'hover:shadow-sm',
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onPick(t, Math.max(0, paletteIndex))}
              className="grid gap-3 text-left disabled:cursor-not-allowed"
            >
              <ThemeSketch look={look} name={storeName || t.name} />
              <span className="flex items-start justify-between gap-2">
                <span>
                  <span className="flex items-center gap-1.5 font-medium">
                    {t.name}
                    {suggested.includes(t.key) && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-info-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        <Sparkles className="size-3" aria-hidden /> Suggested
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t.tagline}</span>
                </span>
                {selected && <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
              </span>
            </button>
            <div className="flex flex-wrap gap-1.5" aria-label={`${t.name} colours`}>
              {t.palettes.map((p, i) => {
                const on = selected && paletteIndex === i;
                return (
                  <button
                    key={p.name}
                    type="button"
                    disabled={disabled}
                    title={p.name}
                    aria-label={`${t.name}: ${p.name}`}
                    aria-pressed={on}
                    onClick={() => onPick(t, i)}
                    className={cn(
                      'flex h-7 items-center gap-1 rounded-full border px-1.5 text-[11px]',
                      on ? 'border-primary bg-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    <span className="size-3.5 rounded-full" style={{ background: p.primary }} />
                    <span className="size-3.5 rounded-full" style={{ background: p.accent }} />
                    <span className="sr-only">{p.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
