import { NextResponse, type NextRequest } from 'next/server';
import { forward } from '@/lib/forward';
import { isLandingSlug } from '@/lib/landing-offer';

/** Starts paying what is still due online, from the thank-you page. Never from a preview. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isLandingSlug(slug))
    return NextResponse.json(
      { status: 404, code: 'not_found', detail: 'There is no such page.' },
      { status: 404 },
    );
  return forward(req, `/landing-pages/${slug}/pay`, { allowPreview: false });
}
