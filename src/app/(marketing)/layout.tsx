import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome';
import { getPlatformStatus } from '@/lib/api/public';

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const status = await getPlatformStatus();
  return (
    <div className="flex min-h-dvh flex-col">
      {status?.maintenance.enabled && status.maintenance.message && (
        <div role="status" className="bg-warning-soft px-4 py-2 text-center text-sm text-warning">
          {status.maintenance.message}
        </div>
      )}
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter supportEmail={status?.support.email} />
    </div>
  );
}
