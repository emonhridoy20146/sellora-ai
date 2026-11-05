'use client';

import { TabNav } from '@/components/ui/tab-nav';

export function ProductsTabs({ orgId }: { orgId: string }) {
  const base = `/app/${orgId}/products`;
  return (
    <TabNav
      tabs={[
        { href: base, label: 'Products', exact: true },
        { href: `${base}/categories`, label: 'Categories' },
        { href: `${base}/sync`, label: 'Import and sync' },
      ]}
    />
  );
}
