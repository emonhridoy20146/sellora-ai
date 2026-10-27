'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, KeyRound, ShieldCheck, UserCheck, UserPlus, UserX } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { usePlatform } from '@/components/platform-context';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { PlatformRole, PlatformRoleCatalogue, PlatformUser } from '@/lib/api/types';
import { formatRelative } from '@/lib/format';

const ROLE_COPY: Record<PlatformRole, { name: string; summary: string }> = {
  owner: { name: 'Owner', summary: 'Everything, including other owners.' },
  admin: { name: 'Admin', summary: 'Runs the platform day to day.' },
  finance: { name: 'Finance', summary: 'Money: payments, wallets, prices, withdrawals.' },
  support: { name: 'Support', summary: 'Helps businesses and their staff.' },
  readonly: { name: 'Read only', summary: 'Can look, cannot change anything.' },
};

type Action =
  | { kind: 'role'; user: PlatformUser }
  | { kind: 'status'; user: PlatformUser; status: 'active' | 'disabled' }
  | { kind: 'reset'; user: PlatformUser };

export default function AdminsPage() {
  const { me, can } = usePlatform();
  const manage = can('platform.admins.manage');
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const admins = useQuery({
    queryKey: ['platform', 'admins'],
    queryFn: () => api<PlatformUser[]>('/platform/admins'),
  });
  const catalogue = useQuery({
    queryKey: ['platform', 'admins', 'roles'],
    queryFn: () => api<PlatformRoleCatalogue>('/platform/admins/roles'),
    staleTime: Infinity,
  });
  // The catalogue lists roles from most to least powerful. Non-owners can only manage
  // and grant roles below their own; the API enforces the same rule.
  const order = catalogue.data?.roles.map((r) => r.key) ?? [];
  const grantable = me.role === 'owner' ? order : order.slice(order.indexOf(me.role) + 1);
  const canManage = (u: PlatformUser) =>
    manage && u.id !== me.id && (me.role === 'owner' || grantable.includes(u.role));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform', 'admins'] });

  const run = useMutation({
    meta: { silent: true },
    mutationFn: (a: Action) =>
      a.kind === 'status'
        ? api(`/platform/admins/${a.user.id}/status`, {
            method: 'PATCH',
            body: { status: a.status },
          })
        : api(`/platform/admins/${a.user.id}/reset-access`, { method: 'POST' }),
    onSuccess: async (_r, a) => {
      await refresh();
      toast.success(
        a.kind === 'reset'
          ? `A new setup link was emailed to ${a.user.email}.`
          : 'Account updated.',
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader
        title="Platform team"
        description="People who run Sellora. Everyone signs in with a password and two-step verification."
        actions={
          manage && (
            <Button onClick={() => setInviting(true)}>
              <UserPlus /> Invite
            </Button>
          )
        }
      />
      <Card>
        <CardContent className="px-0 py-0">
          {admins.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : admins.isError ? (
            <ErrorState error={admins.error} onRetry={() => void admins.refetch()} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Person</TH>
                  <TH>Role</TH>
                  <TH>Status</TH>
                  <TH>Two-step</TH>
                  <TH>Last sign-in</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {admins.data.map((u) => (
                  <TR key={u.id}>
                    <TD>
                      <span className="block font-medium">
                        {u.name}{' '}
                        {u.id === me.id && (
                          <span className="font-normal text-muted-foreground">(you)</span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">{u.email}</span>
                    </TD>
                    <TD>{ROLE_COPY[u.role]?.name ?? u.role}</TD>
                    <TD>
                      <StatusBadge status={u.status} />
                    </TD>
                    <TD>
                      {u.mfaEnabled ? (
                        <Badge tone="success">On</Badge>
                      ) : (
                        <Badge tone="warning">Not set up</Badge>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'Never'}
                    </TD>
                    <TD className="text-right">
                      {canManage(u) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${u.name}`}
                            >
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem onSelect={() => setAction({ kind: 'role', user: u })}>
                              <ShieldCheck /> Change role
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => setAction({ kind: 'reset', user: u })}
                            >
                              <KeyRound />{' '}
                              {u.status === 'invited'
                                ? 'Resend setup link'
                                : 'Reset password and two-step'}
                            </DropdownMenuItem>
                            {u.status === 'disabled' ? (
                              <DropdownMenuItem
                                onSelect={() =>
                                  setAction({ kind: 'status', user: u, status: 'active' })
                                }
                              >
                                <UserCheck /> Enable
                              </DropdownMenuItem>
                            ) : (
                              u.status === 'active' && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    destructive
                                    onSelect={() =>
                                      setAction({ kind: 'status', user: u, status: 'disabled' })
                                    }
                                  >
                                    <UserX /> Disable
                                  </DropdownMenuItem>
                                </>
                              )
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            What each role can do. Roles are fixed so permissions stay predictable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {catalogue.isPending ? (
            <Skeleton className="h-32" />
          ) : catalogue.isError ? (
            <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {catalogue.data.roles.map((r) => (
                <details key={r.key} className="group rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer list-none">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{ROLE_COPY[r.key]?.name ?? r.key}</span>
                      <span className="text-xs text-muted-foreground">
                        {r.permissions.length} of {catalogue.data.permissions.length}
                      </span>
                    </span>
                    <span className="block text-muted-foreground">{ROLE_COPY[r.key]?.summary}</span>
                  </summary>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                    {catalogue.data.permissions
                      .filter((p) => r.permissions.includes(p.key))
                      .map((p) => (
                        <li key={p.key}>{p.description}</li>
                      ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {inviting && (
        <InviteDialog roles={grantable} onClose={() => setInviting(false)} onDone={refresh} />
      )}
      {action?.kind === 'role' && (
        <RoleDialog
          user={action.user}
          roles={grantable}
          onClose={() => setAction(null)}
          onDone={refresh}
        />
      )}
      {action && action.kind !== 'role' && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setAction(null)}
          title={
            action.kind === 'reset'
              ? action.user.status === 'invited'
                ? 'Resend the setup link?'
                : 'Reset password and two-step?'
              : action.status === 'disabled'
                ? `Disable ${action.user.name}?`
                : `Enable ${action.user.name}?`
          }
          description={
            action.kind === 'reset'
              ? `${action.user.email} gets a new link, valid for 24 hours, to choose a password and set up two-step again. They are signed out now.`
              : action.status === 'disabled'
                ? 'They are signed out now and cannot sign in until enabled.'
                : 'They can sign in again with their password and two-step code.'
          }
          confirmLabel={
            action.kind === 'reset'
              ? 'Send link'
              : action.status === 'disabled'
                ? 'Disable'
                : 'Enable'
          }
          destructive={action.kind === 'status' && action.status === 'disabled'}
          onConfirm={() => run.mutateAsync(action)}
        />
      )}
    </>
  );
}

function RoleSelect({
  id,
  value,
  onChange,
  roles,
}: {
  id: string;
  value: string;
  onChange: (v: PlatformRole) => void;
  roles: PlatformRole[];
}) {
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value as PlatformRole)}>
      {roles.map((r) => (
        <option key={r} value={r}>
          {ROLE_COPY[r]?.name ?? r} – {ROLE_COPY[r]?.summary}
        </option>
      ))}
    </NativeSelect>
  );
}

function InviteDialog({
  roles,
  onClose,
  onDone,
}: {
  roles: PlatformRole[];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<PlatformRole>(
    roles.includes('support') ? 'support' : (roles.at(-1) ?? 'readonly'),
  );
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<PlatformUser>('/platform/admins', {
        body: { email: email.trim(), name: name.trim(), role },
      }),
    onSuccess: async () => {
      await onDone();
      toast.success(`Invitation emailed to ${email.trim()}.`);
      onClose();
    },
  });
  const errs: Record<string, string> =
    save.error instanceof ApiError ? save.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Invite to the platform team"
        description="They get an email link, valid for 24 hours, to choose a password and set up two-step verification."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error && !Object.keys(errs).length && (
            <Alert tone="danger">{errorMessage(save.error)}</Alert>
          )}
          <Field label="Name" htmlFor="inv-name" error={errs.name}>
            <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Work email" htmlFor="inv-email" error={errs.email}>
            <Input
              id="inv-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field label="Role" htmlFor="inv-role" error={errs.role}>
            <RoleSelect id="inv-role" value={role} onChange={setRole} roles={roles} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!email.trim() || !name.trim() || roles.length === 0}
            >
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({
  user,
  roles,
  onClose,
  onDone,
}: {
  user: PlatformUser;
  roles: PlatformRole[];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [role, setRole] = useState<PlatformRole>(user.role);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api(`/platform/admins/${user.id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: async () => {
      await onDone();
      toast.success('Role changed. They need to sign in again.');
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Change ${user.name}'s role`}
        description="They are signed out so the new role applies at once."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <Field label="Role" htmlFor="role-select">
            <RoleSelect
              id="role-select"
              value={role}
              onChange={setRole}
              roles={roles.includes(user.role) ? roles : [user.role, ...roles]}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={role === user.role}>
              Change role
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
