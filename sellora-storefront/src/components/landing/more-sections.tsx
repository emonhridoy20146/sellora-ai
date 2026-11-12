import {
  BadgePercent,
  Check,
  Clock,
  CreditCard,
  Flame,
  MapPin,
  Megaphone,
  Quote as QuoteIcon,
  Wallet,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { ORDER_ANCHOR, packageCharge, videoSrc } from '@/lib/landing-offer';
import { formatNumber } from '@/lib/money';
import type { LandingImage, LandingSection, LandingSectionOf, VideoEmbed } from '@/lib/types';
import { FEATURE_ICONS } from '../icons';
import { PackageButton, UseCodeButton } from './offer-actions';
import { OrderButton, Title, type Ctx } from './parts';

/**
 * The sections added in ADR 0031. Each one shows nothing rather than an empty box when the
 * business left it without content.
 */

const MORE_TYPES = [
  'announcement',
  'video_hero',
  'features',
  'checklist',
  'comparison',
  'ingredients',
  'timeline',
  'who_for',
  'stats',
  'orders_today',
  'video_reviews',
  'quote',
  'certificates',
  'image_text',
  'about',
  'size_chart',
  'packages',
  'payment_methods',
  'coupon_banner',
  'call_to_action',
  'location',
  'spacer',
] as const;
type MoreType = (typeof MORE_TYPES)[number];
type MoreSectionT = LandingSectionOf<MoreType>;

const MORE: ReadonlySet<string> = new Set(MORE_TYPES);
export function isMoreSection(s: LandingSection): s is MoreSectionT {
  return MORE.has(s.type);
}

function Img({ image, className }: { image: LandingImage; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image.url} alt={image.alt} loading="lazy" className={className} />
  );
}

function Player({ embed, title }: { embed: VideoEmbed; title: string }) {
  return (
    <div className="aspect-video overflow-hidden rounded-store-lg bg-ink">
      <iframe
        src={videoSrc(embed)}
        title={title || 'Video'}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="size-full border-0"
      />
    </div>
  );
}

function Paragraphs({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  return <p className={cn('whitespace-pre-line', className)}>{text}</p>;
}

const TONE: Record<LandingSectionOf<'announcement'>['tone'], string> = {
  offer: 'bg-accent text-on-accent',
  info: 'bg-tint text-ink',
  urgent: 'bg-red-700 text-white',
};

function Announcement({ s }: { s: LandingSectionOf<'announcement'> }) {
  if (!s.text) return null;
  return (
    <div className={cn('px-4 py-2.5 text-center text-sm font-semibold', TONE[s.tone])}>
      <Megaphone className="mr-2 inline size-4 align-[-2px]" aria-hidden="true" />
      {s.text}
    </div>
  );
}

function VideoHero({ s, ctx }: { s: LandingSectionOf<'video_hero'>; ctx: Ctx }) {
  const heading = s.heading || ctx.view.product?.name || '';
  return (
    <section className="bg-surface">
      <div className="mx-auto grid max-w-4xl gap-6 px-4 py-10 text-center sm:py-14">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl">
            {heading}
          </h1>
          {s.subheading ? (
            <p className="mx-auto mt-4 max-w-2xl text-lg text-pretty text-muted">{s.subheading}</p>
          ) : null}
        </div>
        {s.embed ? <Player embed={s.embed} title={heading} /> : null}
        {s.buttonLabel && ctx.view.product ? (
          <div>
            <OrderButton label={s.buttonLabel} className="w-full sm:w-auto" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Features({ s }: { s: LandingSectionOf<'features'> }) {
  if (!s.items.length) return null;
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <Title>{s.title}</Title>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {s.items.map((f, i) => {
          const Icon = FEATURE_ICONS[f.icon];
          return (
            <li key={i} className="rounded-store-lg border border-line bg-surface p-5 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-tint text-primary">
                <Icon className="size-6" aria-hidden="true" />
              </span>
              <p className="mt-3 font-semibold">{f.title}</p>
              {f.text ? <p className="mt-1 text-sm text-muted">{f.text}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Checklist({ s }: { s: LandingSectionOf<'checklist'> }) {
  const items = s.items.filter(Boolean);
  if (!items.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <Title>{s.title}</Title>
      <ul className="grid gap-2.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-3 text-lg">
            <Check className="mt-1 size-5 shrink-0 text-primary" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Comparison({ s }: { s: LandingSectionOf<'comparison'> }) {
  if (!s.rows.length) return null;
  return (
    <section className="mx-auto max-w-3xl px-4 py-12">
      <Title>{s.title}</Title>
      <div className="overflow-x-auto rounded-store-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="p-3">
                <span className="sr-only">{s.title}</span>
              </th>
              <th scope="col" className="bg-tint p-3 font-semibold text-primary">
                {s.ourLabel}
              </th>
              <th scope="col" className="p-3 font-semibold text-muted">
                {s.otherLabel}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {s.rows.map((r, i) => (
              <tr key={i}>
                <th scope="row" className="p-3 font-medium">
                  {r.label}
                </th>
                <td className="bg-tint p-3 font-semibold">
                  <span className="flex items-start gap-1.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    {r.ours}
                  </span>
                </td>
                <td className="p-3 text-muted">
                  <span className="flex items-start gap-1.5">
                    <X className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {r.others}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Ingredients({ s }: { s: LandingSectionOf<'ingredients'> }) {
  if (!s.items.length) return null;
  return (
    <section className="bg-surface">
      <div className="mx-auto max-w-5xl px-4 py-12">
        <Title>{s.title}</Title>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {s.items.map((item, i) => (
            <li key={i} className="flex gap-3 rounded-store-lg border border-line bg-page p-4">
              {item.image ? (
                <Img image={item.image} className="size-16 shrink-0 rounded-store object-cover" />
              ) : null}
              <div>
                <p className="font-semibold">{item.name}</p>
                {item.text ? <p className="mt-1 text-sm text-muted">{item.text}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Timeline({ s }: { s: LandingSectionOf<'timeline'> }) {
  if (!s.items.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-12">
      <Title>{s.title}</Title>
      <ol className="relative grid gap-6 border-l-2 border-primary/30 pl-6">
        {s.items.map((item, i) => (
          <li key={i} className="relative">
            <span
              className="absolute top-1 -left-[33px] size-4 rounded-full border-4 border-page bg-primary"
              aria-hidden="true"
            />
            <p className="text-sm font-bold tracking-wide text-primary uppercase">{item.label}</p>
            {item.text ? <p className="mt-1">{item.text}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function WhoFor({ s }: { s: LandingSectionOf<'who_for'> }) {
  const yes = s.forItems.filter(Boolean);
  const no = s.notForItems.filter(Boolean);
  if (!yes.length && !no.length) return null;
  return (
    <section className="mx-auto max-w-4xl px-4 py-12">
      <Title>{s.title}</Title>
      <div className={cn('grid gap-4', yes.length && no.length && 'md:grid-cols-2')}>
        {yes.length ? (
          <div className="rounded-store-lg border-2 border-primary bg-tint p-5">
            {s.forTitle ? (
              <h3 className="mb-3 font-display text-lg font-bold">{s.forTitle}</h3>
            ) : null}
            <ul className="grid gap-2">
              {yes.map((x, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {no.length ? (
          <div className="rounded-store-lg border border-line bg-surface p-5">
            {s.notForTitle ? (
              <h3 className="mb-3 font-display text-lg font-bold">{s.notForTitle}</h3>
            ) : null}
            <ul className="grid gap-2 text-muted">
              {no.map((x, i) => (
                <li key={i} className="flex items-start gap-2">
                  <X className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const STAT_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-4',
};

function Stats({ s }: { s: LandingSectionOf<'stats'> }) {
  const items = s.items.filter((x) => x.value);
  if (!items.length) return null;
  return (
    <section className="bg-primary text-on-primary">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <Title className="mb-6">{s.title}</Title>
        <dl className={cn('grid gap-6 text-center', STAT_COLS[Math.min(items.length, 4)])}>
          {items.map((x, i) => (
            <div key={i}>
              <dd className="font-display text-3xl font-bold sm:text-4xl">{x.value}</dd>
              <dt className="mt-1 text-sm opacity-90">{x.label}</dt>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function OrdersToday({ s, ctx }: { s: LandingSectionOf<'orders_today'>; ctx: Ctx }) {
  // The API sends the section only once today's orders reach its minimum.
  if (s.count === undefined || !s.text) return null;
  const text = s.text.replaceAll('{count}', formatNumber(s.count, ctx.view.page.language));
  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <p className="flex items-center justify-center gap-2 rounded-store border border-line bg-surface px-4 py-3 text-center font-semibold">
        <Flame className="size-5 shrink-0 text-orange-600" aria-hidden="true" />
        {text}
      </p>
    </div>
  );
}

function VideoReviews({ s }: { s: LandingSectionOf<'video_reviews'> }) {
  const items = s.items.filter((x) => x.embed);
  if (!items.length) return null;
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <Title>{s.title}</Title>
      <ul className={cn('grid gap-4', items.length > 1 && 'sm:grid-cols-2')}>
        {items.map((x, i) => (
          <li key={i}>
            <Player embed={x.embed!} title={x.name || s.title} />
            {x.name ? <p className="mt-2 text-center text-sm font-semibold">{x.name}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuoteBlock({ s }: { s: LandingSectionOf<'quote'> }) {
  if (!s.text) return null;
  return (
    <section className="mx-auto max-w-3xl px-4 py-12">
      <figure className="rounded-store-lg bg-tint p-6 text-center sm:p-10">
        <QuoteIcon className="mx-auto size-8 text-primary" aria-hidden="true" />
        <blockquote className="mt-4 font-display text-xl font-semibold text-balance sm:text-2xl">
          {s.text}
        </blockquote>
        {s.name || s.image ? (
          <figcaption className="mt-6 flex items-center justify-center gap-3">
            {s.image ? <Img image={s.image} className="size-12 rounded-full object-cover" /> : null}
            <span className="text-left">
              {s.name ? <span className="block font-semibold">{s.name}</span> : null}
              {s.role ? <span className="block text-sm text-muted">{s.role}</span> : null}
            </span>
          </figcaption>
        ) : null}
      </figure>
    </section>
  );
}

function Certificates({ s }: { s: LandingSectionOf<'certificates'> }) {
  if (!s.items.length) return null;
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <Title>{s.title}</Title>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {s.items.map((c, i) => (
          <li key={i} className="rounded-store-lg border border-line bg-surface p-3 text-center">
            <Img image={c.image} className="mx-auto aspect-[3/4] w-full object-contain" />
            {c.caption ? <p className="mt-2 text-sm font-medium">{c.caption}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ImageText({ s }: { s: LandingSectionOf<'image_text'> }) {
  if (!s.heading && !s.body && !s.image) return null;
  return (
    <section
      className={cn(
        'mx-auto grid max-w-5xl items-center gap-8 px-4 py-12',
        s.image && 'md:grid-cols-2',
      )}
    >
      {s.image ? (
        <Img
          image={s.image}
          className={cn(
            'w-full rounded-store-lg object-cover',
            s.imageSide === 'right' && 'md:order-last',
          )}
        />
      ) : null}
      <div>
        {s.heading ? (
          <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
            {s.heading}
          </h2>
        ) : null}
        <Paragraphs text={s.body} className="mt-3 text-lg text-muted" />
      </div>
    </section>
  );
}

function About({ s }: { s: LandingSectionOf<'about'> }) {
  if (!s.heading && !s.body) return null;
  return (
    <section className="bg-surface">
      <div
        className={cn(
          'mx-auto grid max-w-4xl items-center gap-8 px-4 py-12',
          s.image && 'md:grid-cols-[240px_1fr]',
        )}
      >
        {s.image ? (
          <Img
            image={s.image}
            className="mx-auto aspect-square w-48 rounded-full object-cover md:w-full"
          />
        ) : null}
        <div className={cn(!s.image && 'text-center')}>
          {s.heading ? (
            <h2 className="font-display text-2xl font-bold tracking-tight">{s.heading}</h2>
          ) : null}
          <Paragraphs text={s.body} className="mt-3 text-muted" />
        </div>
      </div>
    </section>
  );
}

function SizeChart({ s }: { s: LandingSectionOf<'size_chart'> }) {
  if (!s.columns.length || !s.rows.length) return null;
  return (
    <section className="mx-auto max-w-3xl px-4 py-12">
      <Title>{s.title}</Title>
      <div className="overflow-x-auto rounded-store-lg border border-line bg-surface">
        <table className="w-full text-center text-sm">
          <thead className="bg-tint">
            <tr>
              {s.columns.map((c, i) => (
                <th key={i} scope="col" className="p-3 font-semibold whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {s.rows.map((r, i) => (
              <tr key={i}>
                {s.columns.map((_, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="p-3 font-semibold">
                      {r.cells[j] ?? ''}
                    </th>
                  ) : (
                    <td key={j} className="p-3">
                      {r.cells[j] ?? ''}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.note ? <p className="mt-3 text-center text-sm text-muted">{s.note}</p> : null}
    </section>
  );
}

function Packages({ s, ctx }: { s: LandingSectionOf<'packages'>; ctx: Ctx }) {
  const { view, t } = ctx;
  const sellable = view.product?.variants.filter((v) => v.available) ?? [];
  if (!view.packages.length || !sellable.length) return null;
  const unit = Math.min(...sellable.map((v) => v.priceMinor));
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <Title className="mb-2">{s.heading}</Title>
      {s.text ? <p className="mb-6 text-center text-muted">{s.text}</p> : null}
      <ul
        className={cn(
          'grid gap-4',
          view.packages.length === 2 ? 'mx-auto max-w-3xl sm:grid-cols-2' : 'sm:grid-cols-3',
        )}
      >
        {view.packages.map((p) => {
          const c = packageCharge(unit, p.quantity, p.priceMinor);
          return (
            <li
              key={p.id}
              className={cn(
                'relative flex flex-col rounded-store-lg border-2 bg-surface p-5 text-center',
                p.badge ? 'border-primary shadow-md' : 'border-line',
              )}
            >
              {p.badge ? (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-0.5 text-xs font-semibold whitespace-nowrap text-on-accent">
                  {p.badge}
                </span>
              ) : null}
              <p className="font-display text-lg font-bold">{p.label}</p>
              <p className="mt-3 text-3xl font-bold text-primary">{ctx.money(c.totalMinor)}</p>
              {c.savingMinor > 0 ? (
                <p className="mt-1 text-sm">
                  <span className="text-muted line-through">{ctx.money(c.regularMinor)}</span>{' '}
                  <span className="font-semibold text-primary">
                    {t.youSave(ctx.money(c.savingMinor))}
                  </span>
                </p>
              ) : null}
              <div className="mt-auto">
                <PackageButton id={p.id} label={t.choose} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PaymentMethods({ s, ctx }: { s: LandingSectionOf<'payment_methods'>; ctx: Ctx }) {
  const { t } = ctx;
  const p = ctx.view.payments;
  // Without payment settings the shop takes cash on delivery only.
  const cod = p ? p.cod : true;
  const gateways = p?.gateways ?? [];
  const rows: { icon: typeof Wallet; title: string; text: string }[] = [];
  if (cod)
    rows.push({ icon: Wallet, title: t.cod, text: p?.advance ? t.advanceFirst : t.payWhenArrives });
  if (gateways.length)
    rows.push({
      icon: CreditCard,
      title: t.methodOnline,
      text: t.payOnlineWith(gateways.map((g) => g.name).join(', ')),
    });
  if (!rows.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <Title className="mb-2">{s.heading}</Title>
      {s.text ? <p className="mb-5 text-center text-muted">{s.text}</p> : null}
      <ul className="grid gap-3">
        {rows.map((r) => (
          <li
            key={r.title}
            className="flex gap-3 rounded-store-lg border border-line bg-surface p-4"
          >
            <r.icon className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="font-semibold">{r.title}</p>
              <p className="text-sm text-muted">{r.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CouponBanner({ s, ctx }: { s: LandingSectionOf<'coupon_banner'>; ctx: Ctx }) {
  if (!s.code) return null;
  return (
    <section className="mx-auto max-w-3xl px-4 py-8">
      <div className="rounded-store-lg border-2 border-dashed border-primary bg-tint p-6 text-center">
        <BadgePercent className="mx-auto size-8 text-primary" aria-hidden="true" />
        {s.heading ? (
          <h2 className="mt-2 font-display text-2xl font-bold text-balance">{s.heading}</h2>
        ) : null}
        <p className="mt-3 inline-block rounded-store border border-line bg-surface px-5 py-2 font-mono text-2xl font-bold tracking-widest">
          {s.code}
        </p>
        {s.text ? <p className="mt-3 text-muted">{s.text}</p> : null}
        {ctx.view.state === 'live' && ctx.view.product ? (
          <div className="mt-4">
            <UseCodeButton code={s.code} label={ctx.t.useCode} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CallToAction({ s, ctx }: { s: LandingSectionOf<'call_to_action'>; ctx: Ctx }) {
  if (!s.heading && !s.text) return null;
  return (
    <section className="bg-primary text-on-primary">
      <div className="mx-auto max-w-3xl px-4 py-12 text-center">
        {s.heading ? (
          <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
            {s.heading}
          </h2>
        ) : null}
        {s.text ? <p className="mt-3 text-lg opacity-90">{s.text}</p> : null}
        {s.buttonLabel && ctx.view.product ? (
          <a
            href={`#${ORDER_ANCHOR}`}
            className="mt-6 inline-flex h-13 w-full items-center justify-center rounded-store bg-surface px-8 text-lg font-semibold text-primary shadow-sm hover:opacity-90 sm:w-auto"
          >
            {s.buttonLabel}
          </a>
        ) : null}
      </div>
    </section>
  );
}

function Location({ s, ctx }: { s: LandingSectionOf<'location'>; ctx: Ctx }) {
  if (!s.address) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <Title>{s.heading}</Title>
      <div className="grid gap-3 rounded-store-lg border border-line bg-surface p-5">
        <p className="flex items-start gap-3">
          <MapPin className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="whitespace-pre-line">{s.address}</span>
        </p>
        {s.hours ? (
          <p className="flex items-start gap-3 text-muted">
            <Clock className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            {s.hours}
          </p>
        ) : null}
        {s.mapUrl ? (
          // Only a link: an embedded map would load Google on every visit.
          <a
            href={s.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-store border-2 border-primary px-5 font-semibold text-primary"
          >
            <MapPin className="size-4" aria-hidden="true" /> {ctx.t.openMap}
          </a>
        ) : null}
      </div>
    </section>
  );
}

const SPACE: Record<LandingSectionOf<'spacer'>['size'], string> = {
  small: 'h-4',
  medium: 'h-10',
  large: 'h-20',
};

function Spacer({ s }: { s: LandingSectionOf<'spacer'> }) {
  return (
    <div
      className={cn('mx-auto flex max-w-3xl items-center px-4', SPACE[s.size])}
      aria-hidden="true"
    >
      {s.line ? <hr className="w-full border-line" /> : null}
    </div>
  );
}

export function MoreSection({ s, ctx }: { s: MoreSectionT; ctx: Ctx }) {
  switch (s.type) {
    case 'announcement':
      return <Announcement s={s} />;
    case 'video_hero':
      return <VideoHero s={s} ctx={ctx} />;
    case 'features':
      return <Features s={s} />;
    case 'checklist':
      return <Checklist s={s} />;
    case 'comparison':
      return <Comparison s={s} />;
    case 'ingredients':
      return <Ingredients s={s} />;
    case 'timeline':
      return <Timeline s={s} />;
    case 'who_for':
      return <WhoFor s={s} />;
    case 'stats':
      return <Stats s={s} />;
    case 'orders_today':
      return <OrdersToday s={s} ctx={ctx} />;
    case 'video_reviews':
      return <VideoReviews s={s} />;
    case 'quote':
      return <QuoteBlock s={s} />;
    case 'certificates':
      return <Certificates s={s} />;
    case 'image_text':
      return <ImageText s={s} />;
    case 'about':
      return <About s={s} />;
    case 'size_chart':
      return <SizeChart s={s} />;
    case 'packages':
      return <Packages s={s} ctx={ctx} />;
    case 'payment_methods':
      return <PaymentMethods s={s} ctx={ctx} />;
    case 'coupon_banner':
      return <CouponBanner s={s} ctx={ctx} />;
    case 'call_to_action':
      return <CallToAction s={s} ctx={ctx} />;
    case 'location':
      return <Location s={s} ctx={ctx} />;
    case 'spacer':
      return <Spacer s={s} />;
  }
}
