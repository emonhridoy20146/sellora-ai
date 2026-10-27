'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/queries';
import type { Subscription } from '@/lib/api/types';
import { formatDate } from '@/lib/format';

/** Cancel at period end, or undo that. Paid plans only; trials simply end. */
export function SubscriptionActions({ orgId, sub }: { orgId: string; sub: Subscription }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const done = () => queryClient.invalidateQueries({ queryKey: qk.billing(orgId) });
  const resume = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/billing/subscription/resume`, { method: 'POST' }),
    onSuccess: async () => {
      await done();
      toast.success('Your plan will renew as usual.');
    },
  });
  const paid = sub.status === 'active' || sub.status === 'past_due';
  if (!paid || sub.interval === 'lifetime' || sub.priceMinor === 0) return null;

  return sub.cancelAtPeriodEnd ? (
    <Button variant="outline" size="sm" loading={resume.isPending} onClick={() => resume.mutate()}>
      Keep my plan
    </Button>
  ) : (
    <>
      <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
        Cancel plan
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cancel your plan?"
        description={`You keep every feature until ${formatDate(sub.currentPeriodEnd)}. After that the business moves to the Free plan. You can undo this before then.`}
        confirmLabel="Cancel at period end"
        destructive
        onConfirm={async () => {
          await api(`/orgs/${orgId}/billing/subscription/cancel`, { method: 'POST' });
          await done();
          toast.success('Your plan will not renew.');
        }}
      />
    </>
  );
}
