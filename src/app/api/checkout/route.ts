import type { NextRequest } from 'next/server';
import { forward } from '@/lib/forward';

/** Places the order. Never in a preview; retries with the same Idempotency-Key are safe. */
export function POST(req: NextRequest) {
  return forward(req, '/checkout', { allowPreview: false, idempotent: true });
}
