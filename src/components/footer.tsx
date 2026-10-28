import { Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import Link from 'next/link';
import { dictionary } from '@/lib/i18n';
import type { OpenStore, StoreContact } from '@/lib/types';
import { SocialIcon } from './icons';

/** wa.me wants the number in international form without the plus. */
export function whatsappLink(number: string): string {
  const digits = number.replace(/\D/g, '');
  const intl = digits.startsWith('880') ? digits : digits.startsWith('0') ? `88${digits}` : digits;
  return `https://wa.me/${intl}`;
}

export function ContactList({
  contact,
  labels,
}: {
  contact: StoreContact;
  labels: { call: string; whatsapp: string };
}) {
  return (
    <ul className="space-y-2 text-sm">
      {contact.phone ? (
        <li>
          <a
            href={`tel:${contact.phone}`}
            className="inline-flex items-center gap-2 hover:underline"
          >
            <Phone className="size-4" aria-hidden="true" />
            <span className="sr-only">{labels.call}: </span>
            {contact.phone}
          </a>
        </li>
      ) : null}
      {contact.whatsapp ? (
        <li>
          <a
            href={whatsappLink(contact.whatsapp)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 hover:underline"
          >
            <MessageCircle className="size-4" aria-hidden="true" />
            {labels.whatsapp}: {contact.whatsapp}
          </a>
        </li>
      ) : null}
      {contact.email ? (
        <li>
          <a
            href={`mailto:${contact.email}`}
            className="inline-flex items-center gap-2 hover:underline"
          >
            <Mail className="size-4" aria-hidden="true" />
            {contact.email}
          </a>
        </li>
      ) : null}
      {contact.address ? (
        <li className="flex gap-2">
          <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{contact.address}</span>
        </li>
      ) : null}
    </ul>
  );
}

export function Footer({ store }: { store: OpenStore }) {
  const t = dictionary(store.language);
  const socials = (['facebook', 'instagram', 'youtube', 'tiktok'] as const).filter(
    (k) => store.social[k],
  );
  return (
    <footer className="mt-16 border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <p className="font-display text-xl font-semibold">{store.name}</p>
          {store.seo.description ? (
            <p className="mt-2 max-w-md text-sm text-muted">{store.seo.description}</p>
          ) : null}
          {socials.length ? (
            <div className="mt-5">
              <p className="sr-only">{t.followUs}</p>
              <ul className="flex gap-2">
                {socials.map((s) => (
                  <li key={s}>
                    <a
                      href={store.social[s]!}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={s}
                      className="inline-flex size-10 items-center justify-center rounded-store border border-line text-muted hover:text-ink"
                    >
                      <SocialIcon name={s} />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div>
          <p className="text-sm font-semibold">{t.shop}</p>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            <li>
              <Link href="/products" className="hover:text-ink">
                {t.allProducts}
              </Link>
            </li>
            <li>
              <Link href="/track" className="hover:text-ink">
                {t.track}
              </Link>
            </li>
            {store.pages.map((p) => (
              <li key={p}>
                <Link href={`/pages/${p}`} className="hover:text-ink">
                  {t.pages[p]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold">{t.contact}</p>
          <div className="mt-3 text-muted">
            <ContactList contact={store.contact} labels={t} />
          </div>
        </div>
      </div>
      <p className="border-t border-line py-4 text-center text-xs text-muted">{t.poweredBy}</p>
    </footer>
  );
}
