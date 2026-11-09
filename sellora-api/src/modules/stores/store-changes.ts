import type { Store, StoreChangeArea, StorePageKey, StoreText } from './schemas.js';

const PAGE_LABEL: Record<StorePageKey, string> = {
  about: 'About us',
  shipping: 'Delivery',
  returns: 'Returns and refunds',
  privacy: 'Privacy',
  terms: 'Terms',
};

type StoreWords = Pick<Store, 'name' | 'seo' | 'pages' | 'theme' | 'social' | 'checkout'>;

/** Every piece of text in a store a shopper reads, for the automatic check and the reviewer. */
export function storeTexts(store: StoreWords): StoreText[] {
  const texts: StoreText[] = [
    { where: 'name', label: 'Store name', text: store.name },
    {
      where: 'seo',
      label: 'Search title and description',
      text: [store.seo.title, store.seo.description].filter(Boolean).join('\n'),
    },
    { where: 'announcement', label: 'Announcement bar', text: store.theme.announcement },
    { where: 'checkout', label: 'Checkout note', text: store.checkout.note ?? '' },
    {
      where: 'social',
      label: 'Social links',
      text: (['facebook', 'instagram', 'youtube', 'tiktok'] as const)
        .flatMap((k) => (store.social[k] ? [store.social[k]] : []))
        .join('\n'),
    },
  ];
  for (const [key, text] of Object.entries(store.pages))
    if (text)
      texts.push({
        where: `page:${key}`,
        label: `Page: ${PAGE_LABEL[key as StorePageKey] ?? key}`,
        text,
      });
  store.theme.sections.forEach((s, i) => {
    const parts =
      s.type === 'hero'
        ? [s.heading, s.subheading, s.buttonLabel]
        : s.type === 'banner'
          ? [s.heading, s.text, s.buttonLabel]
          : s.type === 'text'
            ? [s.heading, s.body]
            : s.type === 'features'
              ? s.items.flatMap((f) => [f.title, f.text])
              : [s.title];
    texts.push({
      where: `section:${s.id}`,
      label: `Home section ${i + 1} (${s.type})`,
      text: parts.filter(Boolean).join('\n'),
    });
  });
  return texts.filter((t) => t.text.trim());
}

/** JSON with object keys sorted, so equal settings compare equal whatever order they came in. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** The parts a merchant's edit changed that the reviewer looks at again. */
export function changedAreas(
  before: Pick<Store, 'name' | 'seo' | 'pages' | 'social' | 'checkout' | 'themeKey' | 'theme'>,
  after: Pick<Store, 'name' | 'seo' | 'pages' | 'social' | 'checkout' | 'themeKey' | 'theme'>,
): StoreChangeArea[] {
  const areas: StoreChangeArea[] = [];
  const differs = (a: unknown, b: unknown) => stableJson(a ?? {}) !== stableJson(b ?? {});
  if (before.name !== after.name) areas.push('name');
  if (before.themeKey !== after.themeKey || differs(before.theme, after.theme))
    areas.push('design');
  if (differs(before.pages, after.pages)) areas.push('pages');
  if (differs(before.seo, after.seo)) areas.push('seo');
  if (differs(before.social, after.social)) areas.push('social');
  if ((before.checkout.note ?? '') !== (after.checkout.note ?? '')) areas.push('checkout');
  return areas;
}

/** Text that is new or different since `approved`; with no copy kept, every text counts. */
export function changedTexts(approved: StoreText[] | undefined, now: StoreText[]): StoreText[] {
  if (!approved) return now;
  const was = new Map(approved.map((t) => [t.where, t.text]));
  return now.filter((t) => was.get(t.where) !== t.text);
}

export interface TextChange {
  where: string;
  label: string;
  /** null: it is new. */
  before: string | null;
  /** null: it was removed. */
  now: string | null;
}

/** What changed in the store's words since they were approved, in page order. */
export function textChanges(approved: StoreText[], now: StoreText[]): TextChange[] {
  const was = new Map(approved.map((t) => [t.where, t]));
  const out: TextChange[] = [];
  for (const t of now) {
    const b = was.get(t.where);
    was.delete(t.where);
    if (b?.text !== t.text)
      out.push({ where: t.where, label: t.label, before: b?.text ?? null, now: t.text });
  }
  for (const b of was.values())
    out.push({ where: b.where, label: b.label, before: b.text, now: null });
  return out;
}
