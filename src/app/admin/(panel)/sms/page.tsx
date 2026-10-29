'use client';

import {
  BusinessesCard,
  PlatformAccountCard,
  PlatformTestCard,
  PricesCard,
  SenderNamesCard,
  StatsCard,
  useSmsOverview,
} from '@/components/sms/admin';
import { usePlatform } from '@/components/platform-context';
import { ErrorState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Admin › SMS: Sellora's own SMS account, what businesses pay per part against what it costs,
 * sender names to review, per-business daily limits and the revenue report. Sections follow
 * the admin's permissions: billing to see, SMS to change, store approval for sender names.
 */
export default function PlatformSmsPage() {
  const { can } = usePlatform();
  const billing = can('platform.billing.view');
  const review = can('platform.stores.approve');
  const overview = useSmsOverview(billing);

  return (
    <>
      <PageHeader
        title="SMS"
        description="Sellora SMS is the SMS service businesses pay for from their wallet. Businesses can also connect their own provider account; those messages cost Sellora nothing."
      />
      <div className="grid gap-6">
        {billing &&
          (overview.isPending ? (
            <Skeleton className="h-56 w-full" />
          ) : overview.isError ? (
            <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
          ) : (
            <>
              <PlatformAccountCard overview={overview.data} />
              <PricesCard platform={overview.data.platform} />
              {can('platform.sms.manage') && overview.data.platform.provider && (
                <PlatformTestCard />
              )}
            </>
          ))}
        {review && <SenderNamesCard />}
        {billing && <StatsCard />}
        {billing && <BusinessesCard />}
        {!billing && !review && (
          <ErrorState error={new Error('Your role cannot see SMS settings.')} />
        )}
      </div>
    </>
  );
}
