import { Clock, PauseCircle, Store as StoreIcon } from 'lucide-react';
import { dictionary } from '@/lib/i18n';
import type { ClosedStore, Language } from '@/lib/types';
import { ContactList } from './footer';

/** What shoppers see at a store that is not open: being set up, paused, or closed. */
export function HoldingPage({ store }: { store: ClosedStore }) {
  const t = dictionary(store.language);
  const copy =
    store.state === 'coming_soon'
      ? { title: t.comingSoonTitle, text: t.comingSoonText, Icon: Clock }
      : store.state === 'paused'
        ? { title: t.pausedTitle, text: t.pausedText, Icon: PauseCircle }
        : { title: t.unavailableTitle, text: t.unavailableText, Icon: StoreIcon };
  const showContact = store.state !== 'unavailable' && store.contact;
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-store-lg border border-line bg-surface p-8 text-center shadow-sm">
        {store.theme?.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={store.theme.logo.url}
            alt=""
            className="mx-auto mb-4 size-16 rounded-store object-cover"
          />
        ) : (
          <copy.Icon className="mx-auto mb-4 size-10 text-primary" aria-hidden="true" />
        )}
        <p className="font-display text-2xl font-semibold">{store.name}</p>
        <h1 className="mt-4 text-lg font-semibold">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted">{copy.text}</p>
        {showContact && store.contact ? (
          <div className="mt-6 flex justify-center text-left">
            <ContactList contact={store.contact} labels={t} />
          </div>
        ) : null}
      </div>
    </main>
  );
}

/** No store at this address at all. */
export function NoShopPage({ language }: { language: Language }) {
  const t = dictionary(language);
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="max-w-md text-center">
        <StoreIcon className="mx-auto mb-4 size-10 text-muted" aria-hidden="true" />
        <h1 className="text-xl font-semibold">{t.noShopTitle}</h1>
        <p className="mt-2 text-sm text-muted">{t.noShopText}</p>
      </div>
    </main>
  );
}
