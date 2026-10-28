import { NextResponse, type NextRequest } from 'next/server';
import { PATH_HEADER } from '@/lib/main-address';
import { LANDING_PREVIEW_HEADER } from '@/lib/request';

/**
 * Hands the pages what a layout cannot see: their own path, so the root layout can send
 * shoppers on another address of the store to the same page on its main address, and a
 * landing page's ?preview= token, so its layout can show the previewed version's look.
 * Whatever the browser sent in these headers is replaced.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  headers.delete(LANDING_PREVIEW_HEADER);
  const preview = request.nextUrl.searchParams.get('preview');
  if (preview && preview.length <= 600) headers.set(LANDING_PREVIEW_HEADER, preview);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: not the API routes, build files or the generated robots and sitemap.
  matcher: ['/((?!api/|_next/|favicon.ico|robots.txt|sitemap.xml).*)'],
};
