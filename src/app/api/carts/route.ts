import type { NextRequest } from 'next/server';
import { forward } from '@/lib/forward';

/** Saves the checkout cart for reminders (never from a preview; the API decides if it keeps it). */
export function POST(req: NextRequest) {
  return forward(req, '/carts', { allowPreview: false });
}
