import type { NextRequest } from 'next/server';
import { forward } from '@/lib/forward';

/** Starts paying what is still due online on an order, from its receipt. Never in a preview. */
export function POST(req: NextRequest) {
  return forward(req, '/orders/pay', { allowPreview: false });
}
