'use client';

import { Check, Unlink, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { StoreDomain } from '@/lib/api/types';

type Action = 'approve' | 'reject';

/** The super-admin's buttons for one custom domain: approve, refuse, or disconnect. */
export function DomainDecision({
  domain,
  onDone,
}: {
  domain: Pick<StoreDomain, 'id' | 'displayDomain' | 'status'>;
  onDone: (next: StoreDomain) => void;
}) {
  const [open, setOpen] = useState<Action | null>(null);
  if (domain.status !== 'review' && domain.status !== 'active') return null;
  const disconnect = domain.status === 'active';

  const run = async (action: Action, reason: string) => {
    try {
      const next = await api<StoreDomain>(`/platform/store-domains/${domain.id}/${action}`, {
        method: 'POST',
        body: action === 'reject' ? { reason } : undefined,
      });
      toast.success(
        action === 'approve'
          ? `${domain.displayDomain} connected. The owner has been told.`
          : disconnect
            ? `${domain.displayDomain} disconnected.`
            : `${domain.displayDomain} refused.`,
      );
      onDone(next);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {domain.status === 'review' && (
        <Button
          type="button"
          size="sm"
          onClick={() => setOpen('approve')}
          aria-label={`Approve ${domain.displayDomain}`}
        >
          <Check /> Approve
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="text-destructive"
        onClick={() => setOpen('reject')}
        aria-label={`${disconnect ? 'Disconnect' : 'Refuse'} ${domain.displayDomain}`}
      >
        {disconnect ? <Unlink /> : <X />} {disconnect ? 'Disconnect' : 'Refuse'}
      </Button>
      <ConfirmDialog
        open={open === 'approve'}
        onOpenChange={(o) => !o && setOpen(null)}
        title={`Connect ${domain.displayDomain}?`}
        description="The store opens at this domain at once (a certificate is issued on the first visit) and the owner gets an email. If the store has no main domain yet, this becomes it."
        confirmLabel="Approve domain"
        onConfirm={() => run('approve', '')}
      />
      <ConfirmDialog
        open={open === 'reject'}
        onOpenChange={(o) => !o && setOpen(null)}
        title={
          disconnect ? `Disconnect ${domain.displayDomain}?` : `Refuse ${domain.displayDomain}?`
        }
        description={
          disconnect
            ? 'Shoppers can no longer reach the store at this domain. The Sellora address keeps working. The owner reads your reason.'
            : 'The domain is not connected and its name is free again. The owner reads your reason.'
        }
        confirmLabel={disconnect ? 'Disconnect' : 'Refuse domain'}
        destructive
        reason
        reasonMin={5}
        reasonLabel="Why (the owner sees this)"
        onConfirm={(reason) => run('reject', reason)}
      />
    </div>
  );
}
