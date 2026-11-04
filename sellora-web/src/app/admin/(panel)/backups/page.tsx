'use client';

import {
  BackupRunsCard,
  BackupSettingsCard,
  BackupSummary,
  useBackupRuns,
  useBackupSettings,
} from '@/components/backups/admin';
import { usePlatform } from '@/components/platform-context';
import { ErrorState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Admin › Backups (ADR 0020): nightly encrypted backups of the whole platform, each read back
 * and checked; the weekly copy test-restored; downloads with a fresh 2-step code. Restoring
 * one business is on that business's page.
 */
export default function PlatformBackupsPage() {
  const { can } = usePlatform();
  const allowed = can('platform.backups.manage');
  const settings = useBackupSettings();
  const runs = useBackupRuns();

  if (!allowed) return <ErrorState error={new Error('Your role cannot manage backups.')} />;
  return (
    <>
      <PageHeader
        title="Backups"
        description="To restore one business, open it under Businesses."
      />
      {settings.isPending || runs.isPending ? (
        <div className="grid gap-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      ) : (
        <div className="grid gap-6">
          <BackupSummary settings={settings.data} runs={runs.data} />
          <BackupRunsCard runs={runs.data} />
          <BackupSettingsCard
            key={`${settings.data.enabled}:${settings.data.hour}:${settings.data.timezone}`}
            settings={settings.data}
          />
        </div>
      )}
    </>
  );
}
