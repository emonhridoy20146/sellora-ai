import { AlertTriangle, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { RiskLevel, ShipmentStatus } from '@/lib/api/types';
import { RISK, SHIPMENT_STATUS } from '@/lib/couriers';

export function ShipmentBadge({
  status,
  attention,
}: {
  status: ShipmentStatus;
  attention?: string | null;
}) {
  const s = SHIPMENT_STATUS[status];
  return (
    <Badge tone={s.tone} title={attention ?? undefined}>
      {attention && <AlertTriangle aria-hidden />}
      {s.label}
      {attention && <span className="sr-only"> (needs a look: {attention})</span>}
    </Badge>
  );
}

const RISK_ICON = {
  new: ShieldQuestion,
  low: ShieldCheck,
  medium: ShieldAlert,
  high: ShieldAlert,
} as const;

/** Risk in words with an icon; the success rate is added when there is one. */
export function RiskBadge({
  level,
  successRate,
  compact,
}: {
  level: RiskLevel;
  successRate?: number | null;
  compact?: boolean;
}) {
  const r = RISK[level];
  const Icon = RISK_ICON[level];
  const rate = successRate === null || successRate === undefined ? '' : ` · ${successRate}%`;
  return (
    <Badge tone={r.tone} title={`${r.label}${rate}. ${r.hint}`}>
      <Icon aria-hidden />
      {compact && level === 'new' ? 'New' : r.label + rate}
    </Badge>
  );
}
