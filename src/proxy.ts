import { NextResponse, type NextRequest } from 'next/server';

const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const WIDGET_KEY = /^\/widget\/(wc_[A-Za-z0-9_-]{24})\/?$/;
const CACHE_MS = 60_000;
const allowedSites = new Map<string, { at: number; origins: string[] | null }>();

/**
 * Sites that may frame a chat widget: the channel's allowed sites (any site when the list
 * is empty), plus this site for previews. Cached for a minute; null when the widget is
 * unknown or off, and then nobody may frame it.
 */
async function widgetAncestors(key: string): Promise<string[] | null> {
  const hit = allowedSites.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.origins;
  let origins: string[] | null = null;
  try {
    const res = await fetch(`${apiUrl}/v1/webchat/${key}`, { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { allowedOrigins?: unknown };
      const list = Array.isArray(body.allowedOrigins) ? body.allowedOrigins : [];
      origins = list.filter(
        (o): o is string => typeof o === 'string' && /^https?:\/\/[^\s;,']+$/.test(o),
      );
    }
  } catch {
    // API unreachable: refuse framing rather than allow everyone.
  }
  allowedSites.set(key, { at: Date.now(), origins });
  if (allowedSites.size > 5_000) allowedSites.delete(allowedSites.keys().next().value!);
  return origins;
}

/**
 * A fast redirect for people who are clearly signed out. It only looks at whether the CSRF
 * cookie exists (it lives as long as the refresh token); the API still checks every request,
 * so this is a convenience, not the security boundary. Also sets who may frame the widget.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const next = encodeURIComponent(pathname + search);

  const widget = WIDGET_KEY.exec(pathname);
  if (widget) {
    const origins = await widgetAncestors(widget[1]!);
    const ancestors =
      origins === null ? "'self'" : origins.length === 0 ? '*' : ["'self'", ...origins].join(' ');
    const res = NextResponse.next();
    res.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
    return res;
  }

  if (pathname.startsWith('/app') && !request.cookies.has('sl_csrf')) {
    return NextResponse.redirect(new URL(`/login?next=${next}`, request.url));
  }
  const adminPublic = pathname === '/admin/login' || pathname.startsWith('/admin/setup');
  if (pathname.startsWith('/admin') && !adminPublic && !request.cookies.has('slp_csrf')) {
    return NextResponse.redirect(new URL(`/admin/login?next=${next}`, request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/app/:path*', '/admin/:path*', '/widget/:path*'] };
