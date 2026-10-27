'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ellipsis,
  LockKeyhole,
  LogOut,
  Search,
  ShieldOff,
  UserCheck,
  UserX,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { usePlatform } from '@/components/platform-context';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Input, NativeSelect } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantUserDetail, MerchantUserRow, OffsetPage } from '@/lib/api/types';
import { formatDate, formatDateTime, formatRelative, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

type Action =
  | { kind: 'status'; user: MerchantUserRow; status: 'active' | 'locked' | 'disabled' }
  | { kind: 'logout'; user: MerchantUserRow }
  | { kind: 'mfa'; user: MerchantUserRow };

const STATUS_COPY = {
  active: {
    title: 'Reactivate this account?',
    body: 'They can sign in again straight away.',
    cta: 'Reactivate',
  },
  locked: {
    title: 'Lock this account?',
    body: 'All their sessions end now and they cannot sign in until you reactivate the account.',
    cta: 'Lock account',
  },
  disabled: {
    title: 'Disable this account?',
    body: 'Use this for abuse or a closed account. All sessions end now and sign-in is refused.',
    cta: 'Disable account',
  },
} as const;

export default function MerchantUsersPage() {
  const { can } = usePlatform();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const q = useDebounced(search.trim());
  const list = useQuery({
    queryKey: ['platform', 'users', q, status, page],
    queryFn: () =>
      api<OffsetPage<MerchantUserRow>>('/platform/users', {
        query: { q, status, page, pageSize: 25 },
      }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform', 'users'] });

  const run = useMutation({
    meta: { silent: true },
    mutationFn: async ({ a, reason }: { a: Action; reason: string }) => {
      const base = `/platform/users/${a.user.id}`;
      if (a.kind === 'status')
        return api(`${base}/status`, { method: 'PATCH', body: { status: a.status, reason } });
      if (a.kind === 'logout')
        return api<{ revoked: number }>(`${base}/force-logout`, { method: 'POST' });
      return api(`${base}/reset-mfa`, { method: 'POST', body: { reason } });
    },
    onSuccess: async (res, { a }) => {
      await refresh();
      if (a.kind === 'logout') {
        const revoked = (res as { revoked: number }).revoked;
        toast.success(
          revoked === 1 ? 'Signed out of 1 session.' : `Signed out of ${revoked} sessions.`,
        );
      } else if (a.kind === 'mfa')
        toast.success('Two-step verification removed. They can set it up again.');
      else toast.success('Account updated.');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const manage = can('platform.users.manage');
  const security = can('platform.users.security');

  return (
    <>
      <PageHeader
        title="Merchant users"
        description="People who sign in to businesses. Locking an account ends its sessions everywhere."
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b px-5 py-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="absolute top-2.5 left-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <label htmlFor="u-search" className="sr-only">
              Search users
            </label>
            <Input
              id="u-search"
              className="h-9 pl-8"
              placeholder="Name or email"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <label htmlFor="u-status" className="sr-only">
            Status
          </label>
          <NativeSelect
            id="u-status"
            className="w-40"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="locked">Locked</option>
            <option value="disabled">Disabled</option>
          </NativeSelect>
        </div>
        <CardContent className={cn('px-0 py-0', list.isPlaceholderData && 'opacity-60')}>
          {list.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <EmptyState icon={Users} title="No users match" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>User</TH>
                  <TH>Security</TH>
                  <TH>Status</TH>
                  <TH>Last sign-in</TH>
                  <TH>Joined</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((u) => (
                  <TR key={u.id}>
                    <TD>
                      <button
                        type="button"
                        className="text-left font-medium text-primary hover:underline"
                        onClick={() => setViewing(u.id)}
                      >
                        {u.name}
                      </button>
                      <span className="block text-xs text-muted-foreground">{u.email}</span>
                    </TD>
                    <TD>
                      <span className="inline-flex flex-wrap gap-1">
                        {u.mfaEnabled ? (
                          <Badge tone="success">2-step on</Badge>
                        ) : (
                          <Badge>2-step off</Badge>
                        )}
                        {!u.emailVerified && <Badge tone="warning">Email not verified</Badge>}
                      </span>
                    </TD>
                    <TD>
                      <StatusBadge status={u.status} />
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'Never'}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {formatDate(u.createdAt)}
                    </TD>
                    <TD className="text-right">
                      {(manage || security) && (
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
                            {manage && (
                              <>
                                {u.status !== 'active' && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      setAction({ kind: 'status', user: u, status: 'active' })
                                    }
                                  >
                                    <UserCheck /> Reactivate
                                  </DropdownMenuItem>
                                )}
                                {u.status !== 'locked' && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      setAction({ kind: 'status', user: u, status: 'locked' })
                                    }
                                  >
                                    <LockKeyhole /> Lock
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onSelect={() => setAction({ kind: 'logout', user: u })}
                                >
                                  <LogOut /> Sign out everywhere
                                </DropdownMenuItem>
                              </>
                            )}
                            {security && u.mfaEnabled && (
                              <DropdownMenuItem
                                onSelect={() => setAction({ kind: 'mfa', user: u })}
                              >
                                <ShieldOff /> Reset two-step verification
                              </DropdownMenuItem>
                            )}
                            {manage && u.status !== 'disabled' && (
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
          {list.data && (
            <Pagination
              page={page}
              pageSize={list.data.pageSize}
              total={list.data.total}
              onPage={setPage}
            />
          )}
        </CardContent>
      </Card>

      {action && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setAction(null)}
          title={
            action.kind === 'status'
              ? STATUS_COPY[action.status].title
              : action.kind === 'logout'
                ? 'Sign this person out everywhere?'
                : 'Reset two-step verification?'
          }
          description={
            <>
              <span className="font-medium text-foreground">{action.user.email}</span>.{' '}
              {action.kind === 'status'
                ? STATUS_COPY[action.status].body
                : action.kind === 'logout'
                  ? 'Every browser and app they use will need to sign in again.'
                  : 'Only do this after you have confirmed who they are. They will be asked to set it up again.'}
            </>
          }
          confirmLabel={
            action.kind === 'status'
              ? STATUS_COPY[action.status].cta
              : action.kind === 'logout'
                ? 'Sign out'
                : 'Reset two-step'
          }
          destructive={action.kind !== 'status' || action.status !== 'active'}
          reason={action.kind !== 'logout'}
          reasonLabel={action.kind === 'mfa' ? 'How you confirmed who they are' : 'Reason'}
          onConfirm={(reason) => run.mutateAsync({ a: action, reason })}
        />
      )}
      {viewing && <UserDialog userId={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function UserDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const user = useQuery({
    queryKey: ['platform', 'users', 'detail', userId],
    queryFn: () => api<MerchantUserDetail>(`/platform/users/${userId}`),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide title={user.data?.name ?? 'User'} description={user.data?.email}>
        {user.isPending ? (
          <Skeleton className="h-40" />
        ) : user.isError ? (
          <ErrorState error={user.error} onRetry={() => void user.refetch()} />
        ) : (
          <div className="grid gap-5">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Item label="Status">
                <StatusBadge status={user.data.status} />
              </Item>
              <Item label="Two-step verification">{user.data.mfaEnabled ? 'On' : 'Off'}</Item>
              <Item label="Email verified">{user.data.emailVerified ? 'Yes' : 'No'}</Item>
              <Item label="Phone">{user.data.phone ?? '–'}</Item>
              <Item label="Signed-in sessions">{user.data.activeSessions}</Item>
              <Item label="Last sign-in">
                {user.data.lastLoginAt ? formatDateTime(user.data.lastLoginAt) : 'Never'}
              </Item>
              <Item label="Last IP">
                <span className="font-mono text-xs">{user.data.lastLoginIp ?? '–'}</span>
              </Item>
              <Item label="Joined">{formatDate(user.data.createdAt)}</Item>
              {user.data.statusReason && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Why the account is {user.data.status}</dt>
                  <dd className="mt-0.5">{user.data.statusReason}</dd>
                </div>
              )}
            </dl>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Businesses</h3>
              {user.data.organizations.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not a member of any business.</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {user.data.organizations.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <Link
                        href={`/admin/tenants/${o.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {o.name}
                      </Link>
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">{humanize(o.roleKey)}</span>
                        <StatusBadge status={o.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b py-1.5 sm:block sm:border-0 sm:py-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="sm:mt-0.5">{children}</dd>
    </div>
  );
}
