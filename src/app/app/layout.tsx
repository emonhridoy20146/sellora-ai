'use client';

import { SessionGate } from '@/components/auth/session-gate';
import { useMe } from '@/lib/api/queries';

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  const me = useMe();
  return (
    <SessionGate realm="merchant" query={me}>
      {children}
    </SessionGate>
  );
}
