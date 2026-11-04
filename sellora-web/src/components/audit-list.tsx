'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useDebounced } from '@/hooks/use-debounced';
import { StatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { AuditEvent, Page } from '@/lib/api/types';
import { formatDateTime, humanize } from '@/lib/format';

const ACTIONS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login.failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.signup': 'Created an account',
  'auth.email_verified': 'Verified email',
  'auth.password_changed': 'Changed password',
  'auth.password_reset': 'Reset password',
  'auth.mfa.enabled': 'Turned on two-step verification',
  'auth.mfa.disabled': 'Turned off two-step verification',
  'org.created': 'Created the business',
  'org.updated': 'Changed business settings',
  'org.ownership_transferred': 'Transferred ownership',
  'invitation.created': 'Invited a team member',
  'invitation.accepted': 'Joined the team',
  'invitation.revoked': 'Revoked an invitation',
  'member.role_changed': 'Changed a role',
  'member.removed': 'Removed a team member',
  'member.left': 'Left the business',
  'role.created': 'Created a role',
  'role.updated': 'Edited a role',
  'role.deleted': 'Deleted a role',
  'billing.subscription.started': 'Started a plan',
  'billing.subscription.changed': 'Changed plan',
  'billing.subscription.renewed': 'Plan renewed',
  'billing.subscription.canceled': 'Canceled plan renewal',
  'billing.subscription.resumed': 'Kept plan renewal',
  'billing.subscription.past_due': 'Plan payment overdue',
  'billing.subscription.downgraded': 'Moved to the Free plan',
  'billing.payment.succeeded': 'Payment received',
  'billing.manual_payment.submitted': 'Reported a bank or mobile transfer',
  'billing.withdrawal.requested': 'Requested a withdrawal',
  'billing.withdrawal.canceled': 'Canceled a withdrawal',
};

export function describeAction(action: string): string {
  return ACTIONS[action] ?? humanize(action.replace(/^platform\./, ''));
}

/** Read-only, cursor-paged audit trail (merchant activity or the platform log). */
export function AuditList({
  path,
  queryKey,
  timeZone,
  showOrg,
  filters,
}: {
  path: string;
  queryKey: readonly unknown[];
  timeZone?: string;
  showOrg?: boolean;
  /** Extra query parameters, such as the platform log's scope or business. */
  filters?: Record<string, string | undefined>;
}) {
  const [actionInput, setActionInput] = useState('');
  const action = useDebounced(actionInput.trim());
  const q = useInfiniteQuery({
    queryKey: [...queryKey, action, filters],
    queryFn: ({ pageParam }) =>
      api<Page<AuditEvent>>(path, {
        query: { ...filters, limit: 50, cursor: pageParam, action: action || undefined },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div>
      <div className="border-b px-5 py-3">
        <label htmlFor="audit-action" className="sr-only">
          Filter by action
        </label>
        <Input
          id="audit-action"
          placeholder="Filter by action code, e.g. auth.login"
          className="h-8 max-w-xs"
          value={actionInput}
          onChange={(e) => setActionInput(e.target.value)}
        />
      </div>
      {q.isPending ? (
        <Skeleton className="m-5 h-40" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title="Nothing recorded yet" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>When</TH>
              <TH>Who</TH>
              <TH>What</TH>
              {showOrg && <TH>Business</TH>}
              <TH>Result</TH>
              <TH>IP</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((e) => (
              <TR key={e.id}>
                <TD className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(e.at, timeZone)}
                </TD>
                <TD className="max-w-48 truncate">{e.actor.label ?? `${e.actor.type}`}</TD>
                <TD>
                  <span className="block">{describeAction(e.action)}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {e.action}
                    {e.target?.label ? ` · ${e.target.label}` : ''}
                  </span>
                </TD>
                {showOrg && (
                  <TD className="font-mono text-xs text-muted-foreground">
                    {e.orgId ? (
                      <Link
                        href={`/admin/tenants/${e.orgId}`}
                        className="hover:text-primary hover:underline"
                      >
                        {e.orgId}
                      </Link>
                    ) : (
                      'Platform'
                    )}
                  </TD>
                )}
                <TD>
                  <StatusBadge status={e.outcome} />
                </TD>
                <TD className="font-mono text-xs text-muted-foreground">{e.ip ?? '–'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <LoadMore
        hasMore={Boolean(q.hasNextPage)}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </div>
  );
}
