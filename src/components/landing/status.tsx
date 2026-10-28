import { Badge } from '@/components/ui/badge';
import type { LandingStatus } from '@/lib/api/types';
import { LANDING_STATUS } from '@/lib/landing';

export function LandingStatusBadge({ status }: { status: LandingStatus }) {
  const s = LANDING_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
