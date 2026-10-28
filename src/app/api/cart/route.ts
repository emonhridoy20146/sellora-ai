import type { NextRequest } from 'next/server';
import { forward } from '@/lib/forward';

/** Prices the cart (previews included, so a reviewer can try the cart). */
export function POST(req: NextRequest) {
  return forward(req, '/cart', { allowPreview: true });
}
