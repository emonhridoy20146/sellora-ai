import { NextResponse, type NextRequest } from 'next/server';
import { PREVIEW_COOKIE } from '@/lib/api';
import { forward } from '@/lib/forward';

/**
 * The server copy of a product view, add to cart or checkout start, for the business's ad
 * tags that have a server key (ADR 0030). A browser holding a preview link sends nothing.
 */
export function POST(req: NextRequest) {
  if (req.cookies.get(PREVIEW_COOKIE)?.value)
    return NextResponse.json({ queued: 0 }, { headers: { 'cache-control': 'no-store' } });
  return forward(req, '/ad-events', { allowPreview: false });
}
