'use client';

import { Eye } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PreviewLink } from '@/lib/api/types';

/**
 * Opens the store as shoppers will see it, even while it is a draft. The link is signed and
 * short-lived, so it is fetched on each click. The tab opens first (inside the click, so
 * pop-up blockers allow it) and is pointed at the link once it arrives.
 */
export function PreviewButton({
  orgId,
  storeId,
  label = 'Preview',
  variant = 'outline',
}: {
  orgId: string;
  storeId: string;
  label?: string;
  variant?: 'outline' | 'default' | 'ghost';
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      loading={busy}
      onClick={() => {
        const tab = window.open('about:blank', '_blank');
        setBusy(true);
        api<PreviewLink>(`/orgs/${orgId}/stores/${storeId}/preview-link`, { method: 'POST' })
          .then((link) => {
            if (tab) {
              tab.opener = null;
              tab.location.href = link.url;
            } else window.location.assign(link.url);
          })
          .catch((err: unknown) => {
            tab?.close();
            toast.error(errorMessage(err));
          })
          .finally(() => setBusy(false));
      }}
    >
      <Eye /> {label}
    </Button>
  );
}
