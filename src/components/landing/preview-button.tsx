'use client';

import { Eye } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PreviewLink } from '@/lib/api/types';

/**
 * Opens the saved draft as shoppers would see it. The link is signed and lasts an hour, so it
 * is fetched on each click; the tab opens inside the click so pop-up blockers allow it.
 */
export function LandingPreviewButton({
  orgId,
  pageId,
  label = 'Preview',
  variant = 'outline',
  size,
}: {
  orgId: string;
  pageId: string;
  label?: string;
  variant?: 'outline' | 'default' | 'ghost';
  size?: 'sm';
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      loading={busy}
      onClick={() => {
        const tab = window.open('about:blank', '_blank');
        setBusy(true);
        api<PreviewLink>(`/orgs/${orgId}/landing-pages/${pageId}/preview`, {
          method: 'POST',
          body: { kind: 'draft' },
        })
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
