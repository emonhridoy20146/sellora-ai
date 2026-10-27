import Link from 'next/link';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center px-4 sm:px-8">
        <Brand />
      </header>
      <main
        id="main"
        className="flex flex-1 flex-col items-center justify-center gap-4 px-4 pb-24 text-center"
      >
        <p className="tabular text-sm font-semibold text-primary">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">This page does not exist</h1>
        <p className="max-w-sm text-muted-foreground">The link may be old or mistyped.</p>
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/">Go home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/app">Open the app</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
