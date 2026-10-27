'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PermissionGroup, Role } from '@/lib/api/types';

export default function RolesPage() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const roles = useQuery({
    queryKey: ['org', org.id, 'roles'],
    queryFn: () => api<Role[]>(`/orgs/${org.id}/roles`),
  });
  const catalog = useQuery({
    queryKey: ['catalog', 'permissions'],
    queryFn: () => api<PermissionGroup[]>('/catalog/permissions'),
    staleTime: Infinity,
  });
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const manage = can('org.roles.manage');
  const describe = new Map(
    catalog.data?.flatMap((g) => g.permissions.map((p) => [p.key, p.description] as const)),
  );

  if (roles.isPending || catalog.isPending) return <Skeleton className="h-64" />;
  if (roles.isError) return <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />;
  if (catalog.isError)
    return <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Built-in roles cover most shops. Make your own when someone needs a different mix.
        </p>
        {manage && (
          <Button onClick={() => setEditing('new')}>
            <Plus /> New role
          </Button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {roles.data.map((r) => (
          <Card key={r.key}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  {r.name}
                  {r.system ? (
                    <Badge tone="outline">
                      <Lock /> Built-in
                    </Badge>
                  ) : (
                    <Badge tone="info">Custom</Badge>
                  )}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {r.memberCount} {r.memberCount === 1 ? 'person' : 'people'}
                </span>
              </div>
              {r.description && <CardDescription>{r.description}</CardDescription>}
            </CardHeader>
            <CardContent className="grid gap-3">
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  {r.permissions.length} permissions
                </summary>
                <ul className="mt-2 grid gap-1 text-[13px] text-muted-foreground">
                  {r.permissions.map((p) => (
                    <li key={p}>{describe.get(p) ?? p}</li>
                  ))}
                </ul>
              </details>
              {manage && !r.system && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleting(r)}
                    disabled={r.memberCount > 0}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {editing && (
        <RoleDialog
          orgId={org.id}
          role={editing === 'new' ? null : editing}
          catalog={catalog.data}
          own={new Set(org.permissions)}
          onClose={() => setEditing(null)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['org', org.id, 'roles'] })}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the ${deleting?.name} role?`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await api(`/orgs/${org.id}/roles/${deleting!.key}`, { method: 'DELETE' });
          await queryClient.invalidateQueries({ queryKey: ['org', org.id, 'roles'] });
          toast.success('Role deleted.');
        }}
      />
    </div>
  );
}

function RoleDialog({
  orgId,
  role,
  catalog,
  own,
  onClose,
  onDone,
}: {
  orgId: string;
  role: Role | null;
  catalog: PermissionGroup[];
  own: Set<string>;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description || undefined, permissions: [...perms] };
      return role
        ? api(`/orgs/${orgId}/roles/${role.key}`, { method: 'PATCH', body })
        : api(`/orgs/${orgId}/roles`, { body });
    },
    meta: { silent: true },
    onSuccess: async () => {
      await onDone();
      toast.success(role ? 'Role saved.' : 'Role created.');
      onClose();
    },
  });
  const toggle = (key: string, on: boolean) =>
    setPerms((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        wide
        title={role ? `Edit ${role.name}` : 'New role'}
        description="You can only give permissions you have yourself."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="role-name">
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                maxLength={60}
              />
            </Field>
            <Field label="Description" htmlFor="role-desc" optional>
              <Input
                id="role-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={300}
              />
            </Field>
          </div>
          <div className="grid max-h-[50vh] gap-4 overflow-y-auto rounded-lg border p-4">
            {catalog.map((g) => (
              <fieldset key={g.key} className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">{g.label}</legend>
                {g.permissions.map((p) => {
                  const id = `perm-${p.key}`;
                  const allowed = own.has(p.key);
                  return (
                    <div key={p.key} className="flex items-start gap-2.5">
                      <Checkbox
                        id={id}
                        className="mt-0.5"
                        checked={perms.has(p.key)}
                        disabled={!allowed}
                        onCheckedChange={(c) => toggle(p.key, c === true)}
                      />
                      <label
                        htmlFor={id}
                        className={allowed ? 'text-sm' : 'text-sm text-muted-foreground'}
                      >
                        {p.description}
                      </label>
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={name.trim().length < 2 || perms.size === 0}
            >
              {role ? 'Save role' : 'Create role'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
