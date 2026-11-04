'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Monitor, ShieldCheck, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PasswordInput } from '@/components/auth/password-input';
import { RecoveryCodes, TotpCodeField, TotpQr } from '@/components/auth/totp-setup';
import { SimpleFrame } from '@/components/layout/simple-frame';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { qk, useMe } from '@/lib/api/queries';
import type { MfaStatus, Session, User } from '@/lib/api/types';
import { formatDate, formatRelative } from '@/lib/format';

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ua.slice(0, 40);
  return `${browser} on ${os}`;
}

function Profile({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? '');
  const [locale, setLocale] = useState(user.locale);
  const [timezone, setTimezone] = useState(user.timezone);
  const save = useMutation({
    mutationFn: () =>
      api<User>('/auth/me', {
        method: 'PATCH',
        body: { name, phone: phone.trim() || null, locale, timezone },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.me });
      toast.success('Profile saved.');
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Signed in as {user.email}
          {user.emailVerified ? '' : ' (not verified yet)'}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="p-name">
          <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Mobile number" htmlFor="p-phone" optional>
          <Input id="p-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Language" htmlFor="p-locale">
          <NativeSelect
            id="p-locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value as User['locale'])}
          >
            <option value="en">English</option>
            <option value="bn">বাংলা (Bangla)</option>
          </NativeSelect>
        </Field>
        <Field label="Time zone" htmlFor="p-tz">
          <NativeSelect id="p-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {Intl.supportedValuesOf('timeZone').map((tz) => (
              <option key={tz} value={tz}>
                {tz.replaceAll('_', ' ')}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </CardContent>
      <CardFooter className="justify-end">
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save profile
        </Button>
      </CardFooter>
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api('/auth/password/change', { body: { currentPassword: current, newPassword: next } }),
    meta: { silent: true },
    onSuccess: () => {
      setCurrent('');
      setNext('');
      toast.success('Password changed. Other devices were signed out.');
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error && (
            <Alert tone="danger" className="sm:col-span-2">
              {errorMessage(save.error)}
            </Alert>
          )}
          <Field label="Current password" htmlFor="pw-current">
            <PasswordInput
              id="pw-current"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password" htmlFor="pw-new" hint="At least 10 characters.">
            <PasswordInput
              id="pw-new"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              variant="outline"
              loading={save.isPending}
              disabled={!current || next.length < 10}
            >
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoStep({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['auth', 'mfa'],
    queryFn: () => api<MfaStatus>('/auth/mfa'),
  });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['auth', 'mfa'] }),
      queryClient.invalidateQueries({ queryKey: qk.me }),
    ]);
  const begin = useMutation({
    mutationFn: () =>
      api<{ secret: string; otpauthUrl: string }>('/auth/mfa/totp/setup', { method: 'POST' }),
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/auth/mfa/totp/enable', { body: { code } }),
    meta: { silent: true },
    onSuccess: async (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await refresh();
    },
  });

  if (status.isPending) return <Skeleton className="h-40" />;
  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-step verification
          {s?.enabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>}
        </CardTitle>
        <CardDescription>
          After your password, sign-in also asks for a code from an app on your phone. This stops
          someone who learns your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {codes ? (
          <>
            <Alert tone="success">Two-step verification is on.</Alert>
            <RecoveryCodes codes={codes} account={email} />
            <div>
              <Button variant="outline" onClick={() => setCodes(null)}>
                I saved them
              </Button>
            </div>
          </>
        ) : s?.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success" aria-hidden />
              On since {formatDate(s.enabledAt)} · {s.recoveryCodesRemaining} recovery codes left
            </p>
            <Button variant="ghost" size="sm" onClick={() => setDisabling(true)}>
              <ShieldOff /> Turn off
            </Button>
          </div>
        ) : setup ? (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              enable.mutate();
            }}
          >
            <TotpQr otpauthUrl={setup.otpauthUrl} secret={setup.secret} />
            {enable.error && <Alert tone="danger">{errorMessage(enable.error)}</Alert>}
            <div className="grid gap-4 sm:max-w-xs">
              <TotpCodeField value={code} onChange={setCode} />
              <Button type="submit" loading={enable.isPending} disabled={code.length !== 6}>
                Turn on
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button loading={begin.isPending} onClick={() => begin.mutate()}>
              <ShieldCheck /> Set up two-step verification
            </Button>
          </div>
        )}
      </CardContent>
      {disabling && <DisableDialog onClose={() => setDisabling(false)} onDone={refresh} />}
    </Card>
  );
}

function DisableDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const off = useMutation({
    mutationFn: () => api('/auth/mfa/totp/disable', { body: { password, code } }),
    meta: { silent: true },
    onSuccess: async () => {
      await onDone();
      toast.success('Two-step verification is off.');
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Turn off two-step verification?"
        description="Your account will be protected by your password only."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            off.mutate();
          }}
        >
          {off.error && <Alert tone="danger">{errorMessage(off.error)}</Alert>}
          <Field label="Password" htmlFor="d-pw">
            <PasswordInput
              id="d-pw"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <TotpCodeField value={code} onChange={setCode} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={off.isPending}
              disabled={!password || code.length !== 6}
            >
              Turn off
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Sessions() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => api<Session[]>('/auth/sessions'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const others = useMutation({
    mutationFn: () => api<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' }),
    onSuccess: async (r) => {
      await refresh();
      toast.success(`Signed out ${r.revoked} other ${r.revoked === 1 ? 'device' : 'devices'}.`);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where you are signed in</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {q.isPending ? (
          <Skeleton className="h-20" />
        ) : (
          q.data?.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
              <Monitor className="size-4 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {describeAgent(s.userAgent)}{' '}
                  {s.current && <Badge tone="success">This device</Badge>}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  {s.ip ?? 'Unknown IP'} · active {formatRelative(s.lastUsedAt)}
                </p>
              </div>
              {!s.current && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={revoke.isPending && revoke.variables === s.id}
                  onClick={() => revoke.mutate(s.id)}
                >
                  Sign out
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>
      {(q.data?.length ?? 0) > 1 && (
        <CardFooter>
          <Button
            variant="outline"
            size="sm"
            loading={others.isPending}
            onClick={() => others.mutate()}
          >
            Sign out everywhere else
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

export default function AccountPage() {
  const me = useMe();
  const user = me.data!.user;
  return (
    <SimpleFrame>
      <div className="grid gap-6">
        <div>
          <Button asChild variant="ghost" size="sm" className="mb-2 -ml-3">
            <Link href="/app">
              <ArrowLeft /> Back to the dashboard
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        </div>
        <Profile user={user} />
        <TwoStep email={user.email} />
        <ChangePassword />
        <Sessions />
      </div>
    </SimpleFrame>
  );
}
