import { Badge } from '@/components/ui/badge';
import type { StoreStatus } from '@/lib/api/types';
import { STORE_STATUS } from '@/lib/stores';

export function StoreStatusBadge({ status }: { status: StoreStatus }) {
  const s = STORE_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
