import { Check, MessageCircle, Phone, Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { dictionary, type Dictionary } from '@/lib/i18n';
import {
  ORDER_ANCHOR,
  headlinePrice,
  packageCharge,
  stockText,
  videoSrc,
} from '@/lib/landing-offer';
import { formatMoney, formatNumber } from '@/lib/money';
import type { HideOn, LandingSection, LandingSectionOf, LandingView } from '@/lib/types';
import { whatsappLink } from '../footer';
import { FEATURE_ICONS } from '../icons';
import { Countdown } from './countdown';
import { LandingOrderForm } from './order-form';

const HIDE_ON: Record<HideOn, string> = {
  none: '',
  mobile: 'max-md:hidden',
  desktop: 'md:hidden',
};

interface Ctx {
  view: LandingView;
  t: Dictionary;
  money: (minor: number) => string;
}

function Title({ children, className }: { children: string; className?: string }) {
  if (!children) return null;
  return (
    <h2
      className={cn(
        'mb-6 text-center font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl',
        className,
      )}
    >
      {children}
    </h2>
  );
}

function OrderButton({ label, className }: { label: string; className?: string }) {
  return (
    <a
      href={`#${ORDER_ANCHOR}`}
      className={cn(
        'inline-flex h-13 items-center justify-center rounded-store bg-primary px-8 text-lg font-semibold text-on-primary shadow-sm hover:opacity-90',
        className,
      )}
    >
      {label}
    </a>
  );
}

function PriceTag({ ctx, size = 'lg' }: { ctx: Ctx; size?: 'lg' | 'xl' }) {
  const price = headlinePrice(ctx.view);
  if (!price) return null;
  return (
    <p className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
      <span
        className={cn(
          'font-bold text-primary',
          size === 'xl' ? 'text-4xl sm:text-5xl' : 'text-3xl',
        )}
      >
        {ctx.money(price.priceMinor)}
      </span>
      {price.regularMinor > price.priceMinor ? (
        <span className="text-lg text-muted line-through">
          <span className="sr-only">{ctx.t.regularPrice}: </span>
          {ctx.money(price.regularMinor)}
        </span>
      ) : null}
    </p>
  );
}

function Hero({ s, ctx }: { s: LandingSectionOf<'hero'>; ctx: Ctx }) {
  // An empty headline shows the product's name and no picture its first one (as the editor says).
  const product = ctx.view.product;
  const heading = s.heading || product?.name || '';
  const first = product?.images[0];
  const image =
    s.image ?? (first ? { url: first.url, alt: first.alt || product?.name || '' } : null);
  return (
    <section className="bg-surface">
      <div
        className={cn(
          'mx-auto grid max-w-5xl items-center gap-8 px-4 py-10 sm:py-14',
          image && 'md:grid-cols-2',
        )}
      >
        <div className={cn('text-center', image && 'md:text-left')}>
          {s.badge ? (
            <span className="mb-4 inline-block rounded-full bg-accent px-3 py-1 text-sm font-semibold text-on-accent">
              {s.badge}
            </span>
          ) : null}
          <h1 className="font-display text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl">
            {heading}
          </h1>
          {s.subheading ? (
            <p className="mt-4 text-lg text-pretty text-muted">{s.subheading}</p>
          ) : null}
          {s.showPrice ? (
            <div className={cn('mt-6', image && 'md:[&>p]:justify-start')}>
              <PriceTag ctx={ctx} size="xl" />
            </div>
          ) : null}
          {s.buttonLabel && product ? (
            <OrderButton label={s.buttonLabel} className="mt-6 w-full sm:w-auto" />
          ) : null}
        </div>
        {image ? (
          <div className="max-md:order-first">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.url}
              alt={image.alt}
              className="mx-auto aspect-square w-full max-w-md rounded-store-lg object-cover"
              fetchPriority="high"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ImageBlock({ s }: { s: LandingSectionOf<'image'> }) {
  if (!s.image) return null;
  return (
    <figure className="mx-auto max-w-3xl px-4 py-8">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={s.image.url}
        alt={s.image.alt}
        loading="lazy"
        className="w-full rounded-store-lg object-cover"
      />
      {s.caption ? (
        <figcaption className="mt-3 text-center text-sm text-muted">{s.caption}</figcaption>
      ) : null}
    </figure>
  );
}

function Gallery({ s, ctx }: { s: LandingSectionOf<'gallery'>; ctx: Ctx }) {
  const images =
    s.source === 'product'
      ? (ctx.view.product?.images ?? []).map((i) => ({ url: i.url, alt: i.alt }))
      : s.images;
  if (!images.length) return null;
  return (
    <section className="mx-auto max-w-5xl px-4 py-10">
      <Title>{s.title}</Title>
      <ul
        className={cn(
          'grid gap-3',
          // One or two pictures sit centred instead of leaving empty grid cells.
          images.length === 1
            ? 'mx-auto max-w-md'
            : images.length === 2
              ? 'mx-auto max-w-3xl grid-cols-2'
              : 'grid-cols-2 sm:grid-cols-3',
        )}
      >
        {images.map((img, i) => (
          <li key={`${img.url}-${i}`} className="overflow-hidden rounded-store-lg bg-tint">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url}
              alt={img.alt}
              loading="lazy"
              className="aspect-square size-full object-cover"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Video({ s }: { s: LandingSectionOf<'video'> }) {
  if (!s.embed) return null;
  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      <Title>{s.title}</Title>
      <div className="aspect-video overflow-hidden rounded-store-lg bg-ink">
        <iframe
          src={videoSrc(s.embed)}
          title={s.title || 'Video'}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="size-full border-0"
        />
      </div>
    </section>
  );
}

function Benefits({ s }: { s: LandingSectionOf<'benefits'> }) {
  if (!s.items.length) return null;
  return (
    <section className="bg-surface">
      <div className="mx-auto max-w-3xl px-4 py-12">
        <Title>{s.title}</Title>
        <ul className="grid gap-4">
          {s.items.map((item, i) => (
            <li key={i} className="flex gap-3 rounded-store-lg border border-line bg-page p-4">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
                <Check className="size-4" aria-hidden="true" />
              </span>
              <div>
                <p className="font-semibold">{item.title}</p>
                {item.text ? <p className="mt-1 text-muted">{item.text}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ProblemSolution({ s }: { s: LandingSectionOf<'problem_solution'> }) {
  return (
    <section className="mx-auto grid max-w-5xl items-center gap-8 px-4 py-12 md:grid-cols-2">
      <div className="space-y-6">
        {s.problem || s.problemTitle ? (
          <div className="rounded-store-lg border border-line bg-surface p-5">
            {s.problemTitle ? (
              <h2 className="font-display text-xl font-bold">{s.problemTitle}</h2>
            ) : null}
            {s.problem ? <p className="mt-2 whitespace-pre-line text-muted">{s.problem}</p> : null}
          </div>
        ) : null}
        {s.solution || s.solutionTitle ? (
          <div className="rounded-store-lg border-2 border-primary bg-tint p-5">
            {s.solutionTitle ? (
              <h2 className="font-display text-xl font-bold text-primary">{s.solutionTitle}</h2>
            ) : null}
            {s.solution ? <p className="mt-2 whitespace-pre-line">{s.solution}</p> : null}
          </div>
        ) : null}
      </div>
      {s.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={s.image.url}
          alt={s.image.alt}
          loading="lazy"
          className="w-full rounded-store-lg object-cover"
        />
      ) : null}
    </section>
  );
}

function Specs({ s }: { s: LandingSectionOf<'specs'> }) {
  if (!s.rows.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <Title>{s.title}</Title>
      <dl className="divide-y divide-line overflow-hidden rounded-store-lg border border-line bg-surface">
        {s.rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[40%_1fr] gap-3 px-4 py-3 text-sm">
            <dt className="text-muted">{r.label}</dt>
            <dd className="font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Steps({ s, ctx }: { s: LandingSectionOf<'steps'>; ctx: Ctx }) {
  if (!s.steps.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <Title>{s.title}</Title>
      <ol className="grid gap-3">
        {s.steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-on-primary">
              {formatNumber(i + 1, ctx.view.page.language)}
            </span>
            <p className="pt-1">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function BeforeAfter({ s, ctx }: { s: LandingSectionOf<'before_after'>; ctx: Ctx }) {
  if (!s.before && !s.after) return null;
  const pair = [
    { label: ctx.t.before, img: s.before },
    { label: ctx.t.after, img: s.after },
  ];
  return (
    <section className="mx-auto max-w-4xl px-4 py-10">
      <Title>{s.title}</Title>
      <div className="grid grid-cols-2 gap-3">
        {pair.map(({ label, img }) => (
          <figure
            key={label}
            className="overflow-hidden rounded-store-lg border border-line bg-surface"
          >
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={img.url}
                alt={img.alt}
                loading="lazy"
                className="aspect-square w-full object-cover"
              />
            ) : (
              <div className="aspect-square bg-tint" />
            )}
            <figcaption className="py-2 text-center text-sm font-semibold">{label}</figcaption>
          </figure>
        ))}
      </div>
      {s.caption ? <p className="mt-3 text-center text-sm text-muted">{s.caption}</p> : null}
    </section>
  );
}

function Stars({ rating, label }: { rating: number; label: string }) {
  return (
    <span className="flex gap-0.5" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn('size-4', n <= rating ? 'fill-amber-400 text-amber-400' : 'text-line')}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function Reviews({ s, ctx }: { s: LandingSectionOf<'reviews'>; ctx: Ctx }) {
  if (!s.items.length) return null;
  return (
    <section className="bg-surface">
      <div className="mx-auto max-w-5xl px-4 py-12">
        <Title>{s.title}</Title>
        <ul className="grid gap-4 sm:grid-cols-2">
          {s.items.map((r, i) => (
            <li key={i} className="rounded-store-lg border border-line bg-page p-5">
              <Stars
                rating={r.rating}
                label={ctx.t.stars(formatNumber(r.rating, ctx.view.page.language))}
              />
              {r.text ? <p className="mt-3 whitespace-pre-line">{r.text}</p> : null}
              {r.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.image.url}
                  alt={r.image.alt}
                  loading="lazy"
                  className="mt-3 max-h-80 w-full rounded-store object-contain"
                />
              ) : null}
              {r.name ? <p className="mt-3 text-sm font-semibold">{r.name}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CountdownBlock({ s, ctx }: { s: LandingSectionOf<'countdown'>; ctx: Ctx }) {
  if (!s.endsAt) return null;
  return (
    <section className="bg-ink text-white">
      <div className="mx-auto max-w-3xl px-4 py-8 text-center">
        {s.heading ? <p className="mb-4 text-lg font-semibold">{s.heading}</p> : null}
        <Countdown
          endsAt={s.endsAt}
          endedText={s.endedText}
          units={ctx.t.countdownUnits}
          language={ctx.view.page.language}
        />
      </div>
    </section>
  );
}

function StockLeft({ s, ctx }: { s: LandingSectionOf<'stock_left'>; ctx: Ctx }) {
  if (ctx.view.stockLeft === null || !s.text) return null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <p className="rounded-store bg-accent px-4 py-3 text-center font-semibold text-on-accent">
        {stockText(s.text, ctx.view.stockLeft, ctx.view.page.language)}
      </p>
    </div>
  );
}

function PriceBlock({ s, ctx }: { s: LandingSectionOf<'price'>; ctx: Ctx }) {
  const { view } = ctx;
  if (!view.product) return null;
  // Packages are priced against the cheapest option a shopper can buy.
  const unit = Math.min(
    ...view.product.variants.filter((v) => v.available).map((v) => v.priceMinor),
  );
  return (
    <section className="mx-auto max-w-3xl px-4 py-12 text-center">
      <Title>{s.heading}</Title>
      {view.packages.length > 1 && Number.isFinite(unit) ? (
        <ul className="mx-auto grid max-w-xl gap-3 text-left">
          {view.packages.map((p) => {
            const c = packageCharge(unit, p.quantity, p.priceMinor);
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-store-lg border border-line bg-surface p-4"
              >
                <span className="font-semibold">
                  {p.label}
                  {p.badge ? (
                    <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs text-on-accent">
                      {p.badge}
                    </span>
                  ) : null}
                </span>
                <span className="text-right">
                  <span className="block text-xl font-bold text-primary">
                    {ctx.money(c.totalMinor)}
                  </span>
                  {c.savingMinor > 0 ? (
                    <span className="text-sm text-muted line-through">
                      {ctx.money(c.regularMinor)}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <PriceTag ctx={ctx} size="xl" />
      )}
      {s.note ? <p className="mt-4 text-muted">{s.note}</p> : null}
      <OrderButton label={ctx.t.orderNow} className="mt-6 w-full sm:w-auto" />
    </section>
  );
}

function Faq({ s }: { s: LandingSectionOf<'faq'> }) {
  if (!s.items.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-12">
      <Title>{s.title}</Title>
      <div className="grid gap-3">
        {s.items.map((q, i) => (
          <details key={i} className="group rounded-store-lg border border-line bg-surface p-4">
            <summary className="cursor-pointer list-none font-semibold marker:hidden">
              <span className="flex items-start justify-between gap-3">
                {q.question}
                <span aria-hidden="true" className="text-primary transition group-open:rotate-45">
                  +
                </span>
              </span>
            </summary>
            <p className="mt-2 whitespace-pre-line text-muted">{q.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Guarantee({ s }: { s: LandingSectionOf<'guarantee'> }) {
  if (!s.items.length) return null;
  return (
    <section className="bg-tint">
      <div className="mx-auto max-w-5xl px-4 py-12">
        <Title>{s.title}</Title>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {s.items.map((g, i) => {
            const Icon = FEATURE_ICONS[g.icon];
            return (
              <li key={i} className="flex gap-3 rounded-store-lg bg-surface p-4">
                <Icon className="size-6 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <p className="font-semibold">{g.title}</p>
                  {g.text ? <p className="mt-1 text-sm text-muted">{g.text}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Delivery({ s, ctx }: { s: LandingSectionOf<'delivery'>; ctx: Ctx }) {
  const zones = s.showAreas ? ctx.view.zones : [];
  if (!s.heading && !s.text && !zones.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <Title>{s.heading}</Title>
      {s.text ? <p className="text-center whitespace-pre-line text-muted">{s.text}</p> : null}
      {zones.length ? (
        <dl className="mt-5 divide-y divide-line overflow-hidden rounded-store-lg border border-line bg-surface">
          {zones.map((z) => (
            <div key={z.id} className="flex justify-between gap-3 px-4 py-3">
              <dt>{z.name}</dt>
              <dd className="font-semibold">
                {z.chargeMinor ? ctx.money(z.chargeMinor) : ctx.t.free}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function Contact({ s, ctx }: { s: LandingSectionOf<'contact'>; ctx: Ctx }) {
  const { phone, whatsapp } = ctx.view.store.contact;
  const call = s.call && phone;
  const wa = s.whatsapp && whatsapp;
  if (!call && !wa) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10 text-center">
      <Title>{s.heading}</Title>
      {s.text ? <p className="text-muted">{s.text}</p> : null}
      <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
        {call ? (
          <a
            href={`tel:${phone}`}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-store border-2 border-primary px-6 font-semibold text-primary"
          >
            <Phone className="size-5" aria-hidden="true" /> {phone}
          </a>
        ) : null}
        {wa ? (
          <a
            href={whatsappLink(whatsapp)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-store bg-[#25d366] px-6 font-semibold text-white"
          >
            <MessageCircle className="size-5" aria-hidden="true" /> {ctx.t.whatsapp}
          </a>
        ) : null}
      </div>
    </section>
  );
}

function Text({ s }: { s: LandingSectionOf<'text'> }) {
  if (!s.heading && !s.body) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <Title>{s.heading}</Title>
      {s.body ? <p className="text-lg whitespace-pre-line">{s.body}</p> : null}
    </section>
  );
}

function OrderFormBlock({ s, ctx }: { s: LandingSectionOf<'order_form'>; ctx: Ctx }) {
  const { view, t } = ctx;
  return (
    <section id={ORDER_ANCHOR} className="scroll-mt-4 bg-tint">
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Title className="mb-2">{s.heading}</Title>
        {s.subheading ? <p className="mb-6 text-center text-muted">{s.subheading}</p> : null}
        {view.product ? (
          <LandingOrderForm
            slug={view.page.slug}
            pageId={view.page.id}
            preview={view.state === 'preview'}
            language={view.page.language}
            currency={view.currency}
            product={view.product}
            packages={view.packages}
            maxFreeQuantity={view.maxFreeQuantity}
            addOn={view.addOn}
            noteField={view.noteField}
            zones={view.zones}
            defaultZoneId={view.defaultZoneId}
            buttonLabel={s.buttonLabel || t.orderNow}
          />
        ) : (
          <p className="rounded-store-lg border border-line bg-surface p-6 text-center font-medium">
            {t.offerEnded}
          </p>
        )}
      </div>
    </section>
  );
}

function Section({ s, ctx }: { s: LandingSection; ctx: Ctx }) {
  switch (s.type) {
    case 'hero':
      return <Hero s={s} ctx={ctx} />;
    case 'image':
      return <ImageBlock s={s} />;
    case 'gallery':
      return <Gallery s={s} ctx={ctx} />;
    case 'video':
      return <Video s={s} />;
    case 'benefits':
      return <Benefits s={s} />;
    case 'problem_solution':
      return <ProblemSolution s={s} />;
    case 'specs':
      return <Specs s={s} />;
    case 'steps':
      return <Steps s={s} ctx={ctx} />;
    case 'before_after':
      return <BeforeAfter s={s} ctx={ctx} />;
    case 'reviews':
      return <Reviews s={s} ctx={ctx} />;
    case 'countdown':
      return <CountdownBlock s={s} ctx={ctx} />;
    case 'stock_left':
      return <StockLeft s={s} ctx={ctx} />;
    case 'price':
      return <PriceBlock s={s} ctx={ctx} />;
    case 'faq':
      return <Faq s={s} />;
    case 'guarantee':
      return <Guarantee s={s} />;
    case 'delivery':
      return <Delivery s={s} ctx={ctx} />;
    case 'contact':
      return <Contact s={s} ctx={ctx} />;
    case 'text':
      return <Text s={s} />;
    case 'order_form':
      return <OrderFormBlock s={s} ctx={ctx} />;
  }
}

/** The page's sections from top to bottom, each hidden on phones or computers as set. */
export function LandingSections({ view }: { view: LandingView }) {
  const ctx: Ctx = {
    view,
    t: dictionary(view.page.language),
    money: (minor) => formatMoney(minor, view.currency, view.page.language),
  };
  return (
    <>
      {view.sections.map((s) => (
        <div key={s.id} className={HIDE_ON[s.hideOn]} data-section={s.type}>
          <Section s={s} ctx={ctx} />
        </div>
      ))}
    </>
  );
}
