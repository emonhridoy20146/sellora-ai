import { NextResponse, type NextRequest } from 'next/server';
import { forward } from '@/lib/forward';
import { isLandingSlug } from '@/lib/landing-offer';

/** Counts a visitor to a live landing page (once per browser and day). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isLandingSlug(slug))
    return NextResponse.json(
      { status: 404, code: 'not_found', detail: 'There is no such page.' },
      { status: 404 },
    );
  return forward(req, `/landing-pages/${slug}/visit`, { allowPreview: false });
}
