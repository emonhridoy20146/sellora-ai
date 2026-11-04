import type { NextRequest } from 'next/server';
import { callApi, contextFrom } from '@/lib/api';
import { SHORT_CODE_RE, shortLinkLocation } from '@/lib/short-link';

export const dynamic = 'force-dynamic';

const HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

/** A relative redirect on the shop's own address (the host the shopper used). */
function goTo(location: string): Response {
  return new Response(null, { status: 302, headers: { ...HEADERS, location } });
}

/**
 * A short link from a campaign or automation text (`<store>/c/<code>`, ADR 0019): the API
 * counts the click and says which page it goes to; the shopper lands there with the SMS
 * tracking tags, which orders on that page record. A code that is not this store's goes to
 * the home page.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!SHORT_CODE_RE.test(code)) return goTo('/');
  try {
    const found = await callApi(contextFrom(req.headers, undefined), `/links/${code}`);
    return goTo(found.status === 200 ? shortLinkLocation(found.body) : '/');
  } catch {
    return goTo('/');
  }
}
