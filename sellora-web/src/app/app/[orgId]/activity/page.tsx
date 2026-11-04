'use client';

import { AuditList } from '@/components/audit-list';
import { useOrg } from '@/components/org-context';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';

export default function ActivityPage() {
  const { org, can } = useOrg();
  if (!can('org.audit.view')) return <EmptyState title="Your role cannot see the activity log" />;
  return (
    <>
      <PageHeader
        title="Activity log"
        description="Every important change in this business: who did it, when and from where. Entries cannot be edited or deleted."
      />
      <Card>
        <CardContent className="px-0 py-0">
          <AuditList
            path={`/orgs/${org.id}/audit-events`}
            queryKey={['org', org.id, 'audit']}
            timeZone={org.timezone}
          />
        </CardContent>
      </Card>
    </>
  );
}
