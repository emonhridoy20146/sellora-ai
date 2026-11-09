import { NextResponse, type NextRequest } from 'next/server';
import { PREVIEW_COOKIE } from '@/lib/api';
import { forward } from '@/lib/forward';

/**
 * Counts one shopper step for the store's numbers (once per browser, step and day). A
 * browser holding a preview link (the business or the reviewer) is never counted.
 */
export function POST(req: NextRequest) {
  if (req.cookies.get(PREVIEW_COOKIE)?.value)
    return NextResponse.json({ counted: false }, { headers: { 'cache-control': 'no-store' } });
  return forward(req, '/events', { allowPreview: false });
}
