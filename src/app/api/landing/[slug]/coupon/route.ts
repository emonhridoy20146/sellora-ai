import { NextResponse, type NextRequest } from 'next/server';
import { forward } from '@/lib/forward';
import { isLandingSlug } from '@/lib/landing-offer';

/** "Apply" on a coupon code in the order form: the choice priced with the code (ADR 0031). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isLandingSlug(slug))
    return NextResponse.json(
      { status: 404, code: 'not_found', detail: 'There is no such page.' },
      { status: 404 },
    );
  return forward(req, `/landing-pages/${slug}/coupon`, { allowPreview: false });
}
