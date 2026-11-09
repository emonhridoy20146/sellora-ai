/**
 * For the host's health check: answers as soon as the server is up, without calling the API
 * or needing a store address (hosts check from their own address, not a shop's).
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
