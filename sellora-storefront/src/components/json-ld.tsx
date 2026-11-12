import { ldJson } from '@/lib/structured-data';

/** Structured data for search engines; renders nothing for an empty value. */
export function JsonLd({
  data,
}: {
  data: Record<string, unknown> | Record<string, unknown>[] | null;
}) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      // ldJson escapes "<", so the JSON cannot close the script element.
      dangerouslySetInnerHTML={{ __html: ldJson(data) }}
    />
  );
}
