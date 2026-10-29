import type { Metadata } from 'next';
import { OptOut } from './opt-out';

export const metadata: Metadata = {
  title: 'Stop SMS offers',
  robots: { index: false, follow: false },
};

/**
 * The short link at the end of marketing SMS (`/u/<code>`). Opening it changes nothing: the
 * shopper presses a button, so link previews and scanners cannot unsubscribe anyone.
 */
export default async function OptOutPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <main id="main" className="flex min-h-dvh items-start justify-center px-4 pt-16 pb-16">
      <div className="w-full max-w-sm">
        <OptOut code={code} />
      </div>
    </main>
  );
}
