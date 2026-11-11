import { Phone } from 'lucide-react';
import { AdTagsProvider } from '../ad-tags';
import { dictionary } from '@/lib/i18n';
import type { LandingBrand, LandingHead, LandingView } from '@/lib/types';
import { ContactList } from '../footer';
import { LandingSections } from './sections';
import { StickyOrder } from './sticky-order';
import { LandingVisit } from './visit';

function Brand({ store }: { store: LandingBrand }) {
  const inner = (
    <>
      {store.theme.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={store.theme.logo.url} alt="" className="size-9 rounded-store object-cover" />
      ) : null}
      <span className="font-display text-lg font-semibold">{store.name}</span>
    </>
  );
  // The rest of the shop is linked only while it is open.
  return store.open ? (
    <a href={store.url} className="flex min-w-0 items-center gap-2">
      {inner}
    </a>
  ) : (
    <span className="flex min-w-0 items-center gap-2">{inner}</span>
  );
}

function PageFooter({
  store,
  language,
}: {
  store: LandingBrand;
  language: LandingHead['page']['language'];
}) {
  const t = dictionary(language);
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-5xl gap-4 px-4 py-8 text-sm sm:grid-cols-2">
        <div>
          <p className="font-display text-base font-semibold">{store.name}</p>
          {store.open ? (
            <a href={store.url} className="mt-2 inline-block text-primary hover:underline">
              {t.visitShop}
            </a>
          ) : null}
        </div>
        <ContactList contact={store.contact} labels={t} />
      </div>
      <p className="pb-6 text-center text-xs text-muted">{t.madeWith}</p>
    </footer>
  );
}

/** A landing page as shoppers see it: a slim header, the sections, and the order form. */
export function LandingPageView({ view }: { view: LandingView }) {
  const t = dictionary(view.page.language);
  const form = view.sections.find((s) => s.type === 'order_form');
  const sticky = view.settings.stickyButton && Boolean(form) && Boolean(view.product);
  const stickyLabel =
    view.settings.stickyLabel ||
    (form?.type === 'order_form' ? form.buttonLabel : '') ||
    t.orderNow;
  return (
    <AdTagsProvider
      // Previews load no tags (the API sends none for them either).
      tags={view.state === 'live' ? view.tracking : null}
      endpoint={`/api/landing/${encodeURIComponent(view.page.slug)}/ad-events`}
      currency={view.currency}
      language={view.page.language}
    >
      {view.state === 'preview' ? (
        <div className="bg-ink px-4 py-2 text-center text-sm font-medium text-white">
          {t.previewLanding}
        </div>
      ) : null}
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <Brand store={view.store} />
          {view.store.contact.phone ? (
            <a
              href={`tel:${view.store.contact.phone}`}
              className="inline-flex shrink-0 items-center gap-2 rounded-store border border-line px-3 py-2 text-sm font-medium"
            >
              <Phone className="size-4 text-primary" aria-hidden="true" />
              <span className="max-sm:sr-only">{view.store.contact.phone}</span>
              <span className="sm:sr-only">{t.call}</span>
            </a>
          ) : null}
        </div>
      </header>
      <main id="main" className={sticky ? 'pb-20 md:pb-0' : undefined}>
        <LandingSections view={view} />
      </main>
      <PageFooter store={view.store} language={view.page.language} />
      {sticky ? <StickyOrder label={stickyLabel} /> : null}
      <LandingVisit
        slug={view.page.slug}
        pageId={view.page.id}
        live={view.state === 'live'}
        product={view.product}
      />
    </AdTagsProvider>
  );
}

/** What shoppers see on a paused page, or one that is not available. */
export function LandingHolding({ landing }: { landing: LandingHead }) {
  const t = dictionary(landing.page.language);
  const { store } = landing;
  const paused = landing.state === 'paused';
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-store-lg border border-line bg-surface p-8 text-center shadow-sm">
        <div className="flex justify-center">
          <Brand store={store} />
        </div>
        <h1 className="mt-6 text-xl font-semibold">
          {paused ? t.offerPausedTitle : t.offerUnavailableTitle}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {paused ? t.offerPausedText : t.offerUnavailableText}
        </p>
        {paused ? (
          <div className="mt-6 flex justify-center text-left">
            <ContactList contact={store.contact} labels={t} />
          </div>
        ) : null}
        {store.open ? (
          <a
            href={store.url}
            className="mt-6 inline-flex h-11 items-center rounded-store bg-primary px-5 font-medium text-on-primary"
          >
            {t.visitShop}
          </a>
        ) : null}
      </div>
    </main>
  );
}
