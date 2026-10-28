import { NextResponse, type NextRequest } from 'next/server';
import { PATH_HEADER } from '@/lib/main-address';

/**
 * Hands the pages their own path, which a layout cannot see, so the root layout can send
 * shoppers on another address of the store to the same page on its main address. Whatever
 * the browser sent in this header is replaced.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: not the API routes, build files or the generated robots and sitemap.
  matcher: ['/((?!api/|_next/|favicon.ico|robots.txt|sitemap.xml).*)'],
};
