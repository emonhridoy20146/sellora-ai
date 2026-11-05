import type { Metadata } from 'next';
import { site } from '@/config/site';

export const metadata: Metadata = {
  title: 'SelloraBot',
  description: `What ${site.name}'s website reader reads, how often, and how to stop it.`,
};

/** The page SelloraBot's user agent points to (ADR 0024). */
export default function BotPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">SelloraBot</h1>
      <p className="mt-2 text-muted-foreground">
        SelloraBot is how {site.name} reads a shop&apos;s own website, so the shop&apos;s AI sales
        agent can answer customers with the right products, prices and policies.
      </p>
      <div className="mt-8 space-y-4 text-[15px] leading-7 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:space-y-1">
        <h2>Which sites it reads</h2>
        <p>
          Only a site that a business added to {site.name} and proved is its own, with a DNS record
          (<code>_sellora-verify</code>) or a <code>sellora-site-verification</code> tag on the home
          page. The proof is checked again every time the site is read; when it is gone, reading
          stops.
        </p>
        <h2>What it reads</h2>
        <ul>
          <li>
            <code>robots.txt</code> first, following the rules for <code>SelloraBot</code>, or for{' '}
            <code>*</code> when there are none. A <code>Crawl-delay</code> of up to 5 seconds is
            honoured.
          </li>
          <li>The sitemap, then pages of the same site found from it and from links.</li>
          <li>
            Page titles, descriptions and text; product data (schema.org Product or OpenGraph tags);
            and product photos.
          </li>
        </ul>
        <p>
          It does not read carts, checkout, account pages or search results, or files such as PDFs.
          It does not fill in forms, sign in or run the page&apos;s scripts. It honours{' '}
          <code>noindex</code> and <code>nofollow</code> in a robots meta tag and in the{' '}
          <code>X-Robots-Tag</code> header, for all robots or for <code>sellorabot</code>.
        </p>
        <h2>How often</h2>
        <p>
          At most as often as the business chose (hourly at the most), up to a set number of pages
          per visit, two pages at a time with a pause between requests.
        </p>
        <h2>How to stop it</h2>
        <pre>
          <code>{'User-agent: SelloraBot\nDisallow: /'}</code>
        </pre>
        <p>
          If SelloraBot reads a site you think it should not, write to{' '}
          <a href={`mailto:${site.supportEmail}`} className="text-primary hover:underline">
            {site.supportEmail}
          </a>{' '}
          with the site&apos;s address.
        </p>
      </div>
    </article>
  );
}
