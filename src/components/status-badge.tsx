import { Badge, type BadgeTone } from '@/components/ui/badge';
import { humanize } from '@/lib/format';

const TONES: Record<string, BadgeTone> = {
  active: 'success',
  trialing: 'info',
  past_due: 'warning',
  canceled: 'neutral',
  expired: 'neutral',
  suspended: 'danger',
  closed: 'neutral',
  pending: 'warning',
  succeeded: 'success',
  failed: 'danger',
  refunded: 'neutral',
  requested: 'warning',
  approved: 'info',
  paid: 'success',
  rejected: 'danger',
  accepted: 'success',
  revoked: 'neutral',
  locked: 'warning',
  disabled: 'neutral',
  frozen: 'danger',
  settled: 'success',
  reserved: 'info',
  released: 'neutral',
  success: 'success',
  failure: 'danger',
  invited: 'info',
};

const LABELS: Record<string, string> = { past_due: 'Payment due', trialing: 'Trial' };

/** A status word with a tone; the text always carries the meaning, color only supports it. */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={TONES[status] ?? 'neutral'}>{LABELS[status] ?? humanize(status)}</Badge>;
}
