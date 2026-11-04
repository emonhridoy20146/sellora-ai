'use client';

import {
  DriveCard,
  ExportCard,
  RestoreCard,
  useDriveResult,
  useMerchantBackups,
} from '@/components/backups/merchant';
import { useOrg } from '@/components/org-context';
import { ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Settings › Backups (ADR 0021): download all of the business's data, daily copies to its own
 * Google Drive, and restore points the owner or an admin can restore from with their password.
 */
export default function BackupsSettingsPage() {
  const { org, can } = useOrg();
  const allowed = can('org.backups.manage');
  const data = useMerchantBackups(org.id, allowed);
  useDriveResult();

  if (!allowed)
    return <ErrorState error={new Error('Only the owner and admins can manage backups.')} />;
  if (data.isPending)
    return (
      <div className="grid gap-6">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  if (data.isError) return <ErrorState error={data.error} onRetry={() => void data.refetch()} />;
  return (
    <div className="grid gap-6">
      <ExportCard orgId={org.id} data={data.data} />
      <DriveCard orgId={org.id} data={data.data} />
      <RestoreCard orgId={org.id} name={org.name} data={data.data} />
    </div>
  );
}
