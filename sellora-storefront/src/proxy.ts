import { NextResponse, type NextRequest } from 'next/server';
import { AB_COOKIE, AB_HEADER, AB_MAX_AGE_S, mayBeLandingPath, newAbId, validAbId } from '@/lib/ab';
import { isLandingSlug } from '@/lib/landing-offer';
import { PATH_HEADER } from '@/lib/main-address';
import { LANDING_PREVIEW_HEADER } from '@/lib/request';

/**
 * Hands the pages what a layout cannot see: their own path, so the root layout can send
 * shoppers on another address of the store to the same page on its main address, and a
 * landing page's ?preview= token, so its layout can show the previewed version's look.
 * A landing page also gets the browser's A/B test id (ADR 0031), made on the first visit.
 * Whatever the browser sent in these headers is replaced.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const path = request.nextUrl.pathname;
  headers.set(PATH_HEADER, path + request.nextUrl.search);
  headers.delete(LANDING_PREVIEW_HEADER);
  headers.delete(AB_HEADER);
  const preview = request.nextUrl.searchParams.get('preview');
  if (preview && preview.length <= 600) headers.set(LANDING_PREVIEW_HEADER, preview);

  // A landing page lives at one path segment: /<slug>.
  const slug = /^\/([^/]+)$/.exec(path)?.[1];
  if (!slug || !isLandingSlug(slug) || !mayBeLandingPath(slug))
    return NextResponse.next({ request: { headers } });
  const known = validAbId(request.cookies.get(AB_COOKIE)?.value);
  const id = known ?? newAbId();
  headers.set(AB_HEADER, id);
  const res = NextResponse.next({ request: { headers } });
  if (!known) {
    const proto =
      request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
    res.cookies.set(AB_COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: proto === 'https',
      path: '/',
      maxAge: AB_MAX_AGE_S,
    });
  }
  return res;
}

export const config = {
  // Pages only: not the API routes, build files or the generated robots and sitemap.
  matcher: ['/((?!api/|_next/|favicon.ico|robots.txt|sitemap.xml).*)'],
};
