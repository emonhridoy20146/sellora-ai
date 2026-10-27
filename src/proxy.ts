import { NextResponse, type NextRequest } from 'next/server';

/**
 * A fast redirect for people who are clearly signed out. It only looks at whether the CSRF
 * cookie exists (it lives as long as the refresh token); the API still checks every request,
 * so this is a convenience, not the security boundary.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const next = encodeURIComponent(pathname + search);

  if (pathname.startsWith('/app') && !request.cookies.has('sl_csrf')) {
    return NextResponse.redirect(new URL(`/login?next=${next}`, request.url));
  }
  const adminPublic = pathname === '/admin/login' || pathname.startsWith('/admin/setup');
  if (pathname.startsWith('/admin') && !adminPublic && !request.cookies.has('slp_csrf')) {
    return NextResponse.redirect(new URL(`/admin/login?next=${next}`, request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/app/:path*', '/admin/:path*'] };
