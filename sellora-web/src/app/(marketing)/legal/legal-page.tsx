import { Alert } from '@/components/ui/alert';

/** Shared layout for policy pages. The draft notice stays until a lawyer has reviewed the text. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>
      <Alert tone="warning" className="mt-6" title="Draft">
        This text is a starting template and has not been reviewed by a lawyer. It must be checked
        against Bangladesh law and the laws of each country you sell to before launch.
      </Alert>
      <div className="mt-8 space-y-4 text-[15px] leading-7 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
    </article>
  );
}
