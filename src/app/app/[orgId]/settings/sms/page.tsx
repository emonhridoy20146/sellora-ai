'use client';

import { useSmsSettings } from '@/components/sms/data';
import { MessagesCard, OptOutsCard, TestCard } from '@/components/sms/messages-card';
import { RouteCard, SenderNameCard } from '@/components/sms/route-card';
import { TemplatesCard } from '@/components/sms/templates-card';
import { useOrg } from '@/components/org-context';
import { ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Settings › SMS: how the business sends texts (off, Sellora SMS paid from the wallet, or its
 * own provider account), the order messages customers get, a test send, the message log and the
 * numbers that asked for no marketing texts. Staff who can see billing may look but not change.
 */
export default function SmsSettingsPage() {
  const { org, can } = useOrg();
  const editable = can('org.integrations.manage');
  const visible = editable || can('billing.view');
  const settings = useSmsSettings(org.id, visible);

  if (!visible)
    return (
      <ErrorState
        error={new Error('You need the integrations or billing permission to see SMS settings.')}
      />
    );
  if (settings.isPending)
    return (
      <div className="grid gap-6">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;

  const s = settings.data;
  const showSenderName = s.sellora.available || s.mode === 'sellora' || s.senderName !== null;
  return (
    <div className="grid gap-6">
      <RouteCard s={s} editable={editable} />
      {showSenderName && <SenderNameCard s={s} editable={editable} />}
      <TemplatesCard s={s} editable={editable} />
      {editable && s.mode !== 'off' && <TestCard s={s} />}
      <MessagesCard />
      {(editable || can('marketing.view') || can('marketing.manage')) && (
        <OptOutsCard editable={editable || can('marketing.manage')} />
      )}
    </div>
  );
}
