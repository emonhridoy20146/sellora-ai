'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useMe } from '@/lib/api/queries';
import type { Invitation, Role } from '@/lib/api/types';
import { formatDate } from '@/lib/format';

export default function InvitationsPage() {
  const { org, can } = useOrg();
  const me = useMe();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['org', org.id, 'invitations'],
    queryFn: () => api<Invitation[]>(`/orgs/${org.id}/invitations`),
  });
  const roles = useQuery({
    queryKey: ['org', org.id, 'roles'],
    queryFn: () => api<Role[]>(`/orgs/${org.id}/roles`),
  });
  const assignable = (roles.data ?? []).filter((r) => r.key !== 'owner');
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('sales_agent');
  const invite = useMutation({
    mutationFn: () => api<Invitation>(`/orgs/${org.id}/invitations`, { body: { email, roleKey } }),
    meta: { silent: true },
    onSuccess: async (inv) => {
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['org', org.id, 'invitations'] });
      toast.success(`Invitation sent to ${inv.email}.`);
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/orgs/${org.id}/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org', org.id, 'invitations'] }),
  });
  const role = assignable.find((r) => r.key === roleKey);

  return (
    <div className="grid gap-6">
      {can('org.members.manage') && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a team member</CardTitle>
            <CardDescription>They get an email link that works for 7 days.</CardDescription>
          </CardHeader>
          <CardContent>
            {me.data && !me.data.user.emailVerified ? (
              <Alert tone="warning">Verify your own email before inviting staff.</Alert>
            ) : (
              <form
                className="grid gap-4 sm:grid-cols-[1fr_220px_auto] sm:items-start"
                onSubmit={(e) => {
                  e.preventDefault();
                  invite.mutate();
                }}
              >
                <Field label="Email" htmlFor="inv-email">
                  <Input
                    id="inv-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Role" htmlFor="inv-role">
                  <NativeSelect
                    id="inv-role"
                    value={roleKey}
                    onChange={(e) => setRoleKey(e.target.value)}
                  >
                    {assignable.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Button
                  type="submit"
                  className="sm:mt-[22px]"
                  loading={invite.isPending}
                  disabled={!email}
                >
                  Send invitation
                </Button>
                {role?.description && (
                  <p className="text-[13px] text-muted-foreground sm:col-span-3">
                    {role.description}
                  </p>
                )}
                {invite.error && (
                  <Alert tone="danger" className="sm:col-span-3">
                    {errorMessage(invite.error)}
                  </Alert>
                )}
              </form>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="px-0 py-0">
          {list.isPending ? (
            <Skeleton className="m-5 h-24" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.length === 0 ? (
            <EmptyState icon={Mail} title="No invitations yet" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Status</TH>
                  <TH>Expires</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {list.data.map((i) => (
                  <TR key={i.id}>
                    <TD className="font-medium">{i.email}</TD>
                    <TD>{i.role.name}</TD>
                    <TD>
                      <StatusBadge status={i.status} />
                    </TD>
                    <TD className="text-muted-foreground">{formatDate(i.expiresAt)}</TD>
                    <TD className="text-right">
                      {i.status === 'pending' && can('org.members.manage') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={revoke.isPending && revoke.variables === i.id}
                          onClick={() => revoke.mutate(i.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
