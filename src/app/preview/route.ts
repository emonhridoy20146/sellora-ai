import { NextResponse, type NextRequest } from 'next/server';
import { PREVIEW_COOKIE } from '@/lib/api';

/**
 * Opens a store preview: the signed link from the dashboard (…/__preview?token=…, rewritten
 * here) leaves its token in a cookie for this store's address only, then shows the shop.
 * The API checks the token on every request; this app never trusts it on its own.
 */
export function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
  // A relative Location keeps the shopper on the address they used.
  const res = new NextResponse(null, { status: 303, headers: { location: '/' } });
  if (token && token.length <= 600)
    res.cookies.set(PREVIEW_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: proto === 'https',
      path: '/',
      maxAge: 3600,
    });
  return res;
}
