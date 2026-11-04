'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, ShieldCheck, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { initials } from '@/components/layout/user-menu';
import { useOrg } from '@/components/org-context';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/queries';
import type { Member, Role } from '@/lib/api/types';
import { formatDate } from '@/lib/format';

type Action = {
  kind: 'role' | 'suspend' | 'activate' | 'remove' | 'transfer' | 'leave';
  member: Member;
};

export default function MembersPage() {
  const { org, can } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ['org', org.id, 'members'],
    queryFn: () => api<Member[]>(`/orgs/${org.id}/members`),
  });
  const roles = useQuery({
    queryKey: ['org', org.id, 'roles'],
    queryFn: () => api<Role[]>(`/orgs/${org.id}/roles`),
  });
  const [action, setAction] = useState<Action | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['org', org.id] });
  const manage = can('org.members.manage');
  const isOwner = org.role.key === 'owner';

  if (members.isPending) return <Skeleton className="h-64" />;
  if (members.isError)
    return <ErrorState error={members.error} onRetry={() => void members.refetch()} />;

  return (
    <>
      {manage && (
        <div className="mb-4 flex justify-end">
          <Button asChild>
            <Link href={`/app/${org.id}/staff/invitations`}>
              <UserPlus /> Invite someone
            </Link>
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="px-0 py-0">
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH>Joined</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {members.data.map((m) => (
                <TR key={m.id}>
                  <TD>
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                        {initials(m.name)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {m.name}{' '}
                          {m.isYou && (
                            <span className="font-normal text-muted-foreground">(you)</span>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <span className="inline-flex items-center gap-1.5">
                      {m.role.name}
                      {m.mfaEnabled && (
                        <ShieldCheck
                          className="size-3.5 text-success"
                          aria-label="Two-step verification on"
                        />
                      )}
                    </span>
                  </TD>
                  <TD>
                    <StatusBadge status={m.status} />
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">
                    {formatDate(m.joinedAt)}
                  </TD>
                  <TD className="text-right">
                    {(m.isYou ? m.role.key !== 'owner' : manage && m.role.key !== 'owner') ||
                    (isOwner && !m.isYou) ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${m.name}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {m.isYou ? (
                            <DropdownMenuItem
                              destructive
                              onSelect={() => setAction({ kind: 'leave', member: m })}
                            >
                              Leave this business
                            </DropdownMenuItem>
                          ) : (
                            <>
                              {manage && m.role.key !== 'owner' && (
                                <>
                                  <DropdownMenuItem
                                    onSelect={() => setAction({ kind: 'role', member: m })}
                                  >
                                    Change role
                                  </DropdownMenuItem>
                                  {m.status === 'active' ? (
                                    <DropdownMenuItem
                                      onSelect={() => setAction({ kind: 'suspend', member: m })}
                                    >
                                      Suspend access
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      onSelect={() => setAction({ kind: 'activate', member: m })}
                                    >
                                      Restore access
                                    </DropdownMenuItem>
                                  )}
                                </>
                              )}
                              {isOwner && m.status === 'active' && (
                                <DropdownMenuItem
                                  onSelect={() => setAction({ kind: 'transfer', member: m })}
                                >
                                  Make owner
                                </DropdownMenuItem>
                              )}
                              {manage && m.role.key !== 'owner' && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    destructive
                                    onSelect={() => setAction({ kind: 'remove', member: m })}
                                  >
                                    Remove from business
                                  </DropdownMenuItem>
                                </>
                              )}
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {action?.kind === 'role' && (
        <ChangeRoleDialog
          orgId={org.id}
          member={action.member}
          roles={(roles.data ?? []).filter((r) => r.key !== 'owner')}
          onClose={() => setAction(null)}
          onDone={refresh}
        />
      )}
      {action?.kind === 'transfer' && (
        <TransferDialog
          orgId={org.id}
          member={action.member}
          onClose={() => setAction(null)}
          onDone={async () => {
            await queryClient.invalidateQueries({ queryKey: qk.me });
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={action?.kind === 'suspend' || action?.kind === 'activate'}
        onOpenChange={(o) => !o && setAction(null)}
        title={
          action?.kind === 'suspend'
            ? `Suspend ${action.member.name}?`
            : `Restore ${action?.member.name}?`
        }
        description={
          action?.kind === 'suspend'
            ? 'They are signed out of this business at once and cannot open it until you restore access.'
            : 'They can open this business again with their current role.'
        }
        confirmLabel={action?.kind === 'suspend' ? 'Suspend' : 'Restore'}
        destructive={action?.kind === 'suspend'}
        onConfirm={async () => {
          await api(`/orgs/${org.id}/members/${action!.member.id}/status`, {
            method: 'PATCH',
            body: { status: action!.kind === 'suspend' ? 'suspended' : 'active' },
          });
          await refresh();
          toast.success('Access updated.');
        }}
      />
      <ConfirmDialog
        open={action?.kind === 'remove'}
        onOpenChange={(o) => !o && setAction(null)}
        title={`Remove ${action?.member.name}?`}
        description="They lose access to this business. Their past actions stay in the activity log."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          await api(`/orgs/${org.id}/members/${action!.member.id}`, { method: 'DELETE' });
          await refresh();
          toast.success('Removed.');
        }}
      />
      <ConfirmDialog
        open={action?.kind === 'leave'}
        onOpenChange={(o) => !o && setAction(null)}
        title="Leave this business?"
        description="You will need a new invitation to come back."
        confirmLabel="Leave"
        destructive
        onConfirm={async () => {
          await api(`/orgs/${org.id}/leave`, { method: 'POST' });
          await queryClient.invalidateQueries({ queryKey: qk.me });
          router.replace('/app?choose=1');
        }}
      />
    </>
  );
}

function ChangeRoleDialog({
  orgId,
  member,
  roles,
  onClose,
  onDone,
}: {
  orgId: string;
  member: Member;
  roles: Role[];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [roleKey, setRoleKey] = useState(member.role.key);
  const save = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/members/${member.id}/role`, { method: 'PATCH', body: { roleKey } }),
    onSuccess: async () => {
      await onDone();
      toast.success(
        `${member.name} is now ${roles.find((r) => r.key === roleKey)?.name ?? roleKey}.`,
      );
      onClose();
    },
  });
  const role = roles.find((r) => r.key === roleKey);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Change ${member.name}'s role`}>
        <Field label="Role" htmlFor="role" hint={role?.description}>
          <NativeSelect id="role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={roleKey === member.role.key}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({
  orgId,
  member,
  onClose,
  onDone,
}: {
  orgId: string;
  member: Member;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/transfer-ownership`, { body: { memberId: member.id, password } }),
    onSuccess: async () => {
      await onDone();
      toast.success(`${member.name} is now the owner.`);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Make ${member.name} the owner?`}
        description="The owner controls billing and can remove anyone. You become an admin. Only the new owner can undo this."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Your password" htmlFor="tpw">
            <Input
              id="tpw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={save.isPending}
              disabled={!password}
            >
              Transfer ownership
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
