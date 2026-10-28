import type { NextRequest } from 'next/server';
import { forward } from '@/lib/forward';

export function POST(req: NextRequest) {
  return forward(req, '/orders/track', { allowPreview: false });
}
