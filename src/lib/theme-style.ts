import type { CSSProperties } from 'react';
import { readableOn } from './color';
import type { ThemeSettings } from './types';

/** The data attributes and CSS variables that give a store its look (see globals.css). */
export function themeAttributes(themeKey: string | undefined, theme: ThemeSettings | null) {
  if (!theme) return { attrs: {}, style: {} as CSSProperties };
  const { primary, accent } = theme.palette;
  return {
    attrs: {
      'data-theme': themeKey ?? 'bazaar',
      'data-font': theme.font,
      'data-radius': theme.radius,
      'data-header': theme.header,
      'data-card': theme.card,
    },
    style: {
      '--primary': primary,
      '--on-primary': readableOn(primary),
      '--accent': accent,
      '--on-accent': readableOn(accent),
    } as CSSProperties,
  };
}
