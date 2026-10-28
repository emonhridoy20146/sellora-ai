'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ChannelGlyph, MessengerGlyph } from '@/components/channel-icons';
import { inboxKeys } from '@/components/inbox/data';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Channel, MetaPageChoice, MetaSettings } from '@/lib/api/types';
import {
  defaultPick,
  pickProblem,
  readEmbeddedSignup,
  whatsAppErrors,
  type PagePick,
  type WhatsAppDraft,
} from '@/lib/channels';
import { cn } from '@/lib/utils';

export const metaKeys = {
  settings: (orgId: string) => ['org', orgId, 'channels', 'meta-settings'] as const,
  session: (orgId: string, sessionId: string) =>
    ['org', orgId, 'channels', 'meta-session', sessionId] as const,
};

export function useMetaSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: metaKeys.settings(orgId),
    queryFn: () => api<MetaSettings>(`/orgs/${orgId}/channels/meta/settings`),
    staleTime: 5 * 60_000,
    enabled,
  });
}

/** Sends the browser to Facebook Login; Facebook returns to /app/connect/meta. */
export function useStartPageLogin(orgId: string) {
  return useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/orgs/${orgId}/channels/meta/login`, { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

// ---------------------------------------------------------------- page chooser

function PageRow({
  orgId,
  sessionId,
  page,
  onConnected,
}: {
  orgId: string;
  sessionId: string;
  page: MetaPageChoice;
  onConnected: (channels: Channel[]) => void;
}) {
  const [pick, setPick] = useState<PagePick>(() => defaultPick(page));
  const [done, setDone] = useState<Channel[] | null>(null);
  const problem = pickProblem(page, pick);
  const connect = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<{ items: Channel[] }>(`/orgs/${orgId}/channels/meta/pages`, {
        method: 'POST',
        body: { sessionId, pageId: page.id, ...pick },
      }),
    onSuccess: (res) => {
      setDone(res.items);
      onConnected(res.items);
    },
  });

  const status = (where: 'here' | 'elsewhere' | null) =>
    where === 'here' ? (
      <Badge tone="success">Connected here</Badge>
    ) : where === 'elsewhere' ? (
      <Badge tone="warning">On another business</Badge>
    ) : null;

  return (
    <li className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-content-center rounded-lg bg-muted">
          <MessengerGlyph className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{page.name}</p>
          <p className="text-[13px] text-muted-foreground">
            {page.instagram
              ? `Instagram: ${page.instagram.username ? `@${page.instagram.username}` : 'linked'}`
              : 'No Instagram account linked'}
          </p>
        </div>
      </div>
      {done ? (
        <Alert tone="success">
          Connected: {done.map((c) => c.name).join(' and ')}. New messages arrive in your inbox.
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={pick.messenger}
                disabled={!page.canMessage}
                onCheckedChange={(v) => setPick({ ...pick, messenger: v === true })}
                aria-label={`Messenger for ${page.name}`}
              />
              Messenger {status(page.connected.messenger)}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={pick.instagram}
                disabled={!page.canMessage || !page.instagram}
                onCheckedChange={(v) => setPick({ ...pick, instagram: v === true })}
                aria-label={`Instagram for ${page.name}`}
              />
              Instagram {status(page.connected.instagram)}
            </label>
          </div>
          {(problem && page.canMessage === false) || connect.isError ? (
            <Alert tone="danger">{connect.isError ? errorMessage(connect.error) : problem}</Alert>
          ) : null}
          <div>
            <Button
              size="sm"
              disabled={problem !== null}
              loading={connect.isPending}
              onClick={() => connect.mutate()}
              title={problem ?? undefined}
            >
              {page.connected.messenger === 'here' || page.connected.instagram === 'here'
                ? 'Reconnect'
                : 'Connect'}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

/** The pages from a Facebook Login, to connect one by one. */
export function PageChooser({
  orgId,
  sessionId,
  pages,
}: {
  orgId: string;
  sessionId: string;
  pages: MetaPageChoice[];
}) {
  const qc = useQueryClient();
  if (pages.length === 0)
    return (
      <Alert tone="warning" title="No pages came back from Facebook">
        Log in again and, when Facebook asks, choose the pages to share with Sellora. You need a
        role on the page that allows messaging.
      </Alert>
    );
  return (
    <ul className="grid gap-3" aria-label="Facebook pages">
      {pages.map((p) => (
        <PageRow
          key={p.id}
          orgId={orgId}
          sessionId={sessionId}
          page={p}
          onConnected={(channels) => {
            void qc.invalidateQueries({ queryKey: inboxKeys.channels(orgId) });
            toast.success(`${channels.map((c) => c.name).join(' and ')} connected`);
          }}
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- WhatsApp

interface FacebookSdk {
  init: (opts: {
    appId: string;
    version: string;
    xfbml: boolean;
    autoLogAppEvents: boolean;
  }) => void;
  login: (
    cb: (res: { authResponse?: { code?: string } | null; status?: string }) => void,
    opts: Record<string, unknown>,
  ) => void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<FacebookSdk> | null = null;

/** Loads Facebook's JavaScript SDK once, for WhatsApp Embedded Signup. */
function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  sdkPromise ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, version, xfbml: false, autoLogAppEvents: false });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('Facebook could not be reached. Check your connection and try again.'));
    };
    document.body.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Runs Embedded Signup: Facebook's window creates or picks the WhatsApp Business account
 * and number, then hands back a code and the chosen ids.
 */
function runEmbeddedSignup(
  settings: MetaSettings,
): Promise<{ code: string; phoneNumberId: string; wabaId: string }> {
  return loadFacebookSdk(settings.appId!, settings.graphVersion).then(
    (FB) =>
      new Promise((resolve, reject) => {
        let ids: { phoneNumberId: string; wabaId: string } | null = null;
        let code: string | null = null;
        let settled = false;
        const finish = () => {
          if (settled || !code || !ids) return;
          settled = true;
          window.removeEventListener('message', onMessage);
          resolve({ code, ...ids });
        };
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('message', onMessage);
          reject(new Error(message));
        };
        const onMessage = (e: MessageEvent) => {
          const r = readEmbeddedSignup(e.origin, e.data);
          if (!r) return;
          if (r.kind === 'finish') {
            ids = { phoneNumberId: r.phoneNumberId, wabaId: r.wabaId };
            finish();
          } else if (r.kind === 'cancel') fail('WhatsApp signup was closed before it finished.');
          else fail(r.message);
        };
        window.addEventListener('message', onMessage);
        FB.login(
          (res) => {
            code = res.authResponse?.code ?? null;
            if (!code) return fail('WhatsApp signup was cancelled.');
            finish();
            // The window's message can arrive just after the code.
            setTimeout(
              () => fail('Facebook did not say which number you chose. Try again.'),
              5_000,
            );
          },
          {
            config_id: settings.whatsappEmbeddedSignup,
            response_type: 'code',
            override_default_response_type: true,
            extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
          },
        );
      }),
  );
}

const EMPTY_WA: WhatsAppDraft = { phoneNumberId: '', wabaId: '', accessToken: '' };

export function WhatsAppDialog({
  orgId,
  settings,
  open,
  onOpenChange,
  reconnect,
}: {
  orgId: string;
  settings: MetaSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel being reconnected: its ids are filled in. */
  reconnect?: Channel;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={reconnect ? `Reconnect ${reconnect.name}` : 'Connect WhatsApp'}
        description="Uses the WhatsApp Business Platform (Cloud API). Customers’ messages arrive in your inbox."
      >
        {open && (
          <WhatsAppForm
            orgId={orgId}
            settings={settings}
            reconnect={reconnect}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WhatsAppForm({
  orgId,
  settings,
  reconnect,
  onDone,
}: {
  orgId: string;
  settings: MetaSettings;
  reconnect?: Channel;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const embedded = Boolean(settings.whatsappEmbeddedSignup) && !reconnect;
  const [manual, setManual] = useState(!embedded);
  const [d, setD] = useState<WhatsAppDraft>(() =>
    reconnect?.account
      ? {
          phoneNumberId: reconnect.account.externalId,
          wabaId: reconnect.account.wabaId ?? '',
          accessToken: '',
        }
      : EMPTY_WA,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const done = (channel: Channel) => {
    void qc.invalidateQueries({ queryKey: inboxKeys.channels(orgId) });
    toast.success(`${channel.name} connected`);
    onDone();
  };
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
    else setErrors({ _: errorMessage(err) });
  };

  const withToken = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<Channel>(`/orgs/${orgId}/channels/meta/whatsapp`, {
        method: 'POST',
        body: {
          phoneNumberId: d.phoneNumberId.trim(),
          wabaId: d.wabaId.trim(),
          accessToken: d.accessToken.trim(),
        },
      }),
    onSuccess: done,
    onError: fail,
  });
  const withSignup = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const result = await runEmbeddedSignup(settings);
      return api<Channel>(`/orgs/${orgId}/channels/meta/whatsapp/embedded`, {
        method: 'POST',
        body: result,
      });
    },
    onSuccess: done,
    onError: fail,
  });

  return (
    <div className="grid gap-4">
      {embedded && (
        <div className="grid gap-2">
          <Button
            type="button"
            onClick={() => {
              setErrors({});
              withSignup.mutate();
            }}
            loading={withSignup.isPending}
          >
            <ChannelGlyph type="whatsapp" /> Continue with Facebook
          </Button>
          <p className="text-[13px] text-muted-foreground">
            Facebook opens a window where you choose or create your WhatsApp Business account and
            number. It takes about two minutes.
          </p>
          {!manual && (
            <button
              type="button"
              className="justify-self-start text-[13px] text-primary hover:underline"
              onClick={() => setManual(true)}
            >
              I have a system user token instead
            </button>
          )}
        </div>
      )}
      {manual && (
        <form
          className={cn('grid gap-4', embedded && 'border-t pt-4')}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const found = whatsAppErrors(d);
            setErrors(found);
            if (Object.keys(found).length === 0) withToken.mutate();
          }}
        >
          <p className="text-[13px] text-muted-foreground">
            From WhatsApp Manager and Meta Business Settings: the number’s ID, its WhatsApp Business
            Account ID, and a permanent token of a system user with the{' '}
            <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>{' '}
            permissions.
          </p>
          <Field label="Phone number ID" htmlFor="wa-phone" error={errors.phoneNumberId}>
            <Input
              id="wa-phone"
              inputMode="numeric"
              value={d.phoneNumberId}
              disabled={Boolean(reconnect)}
              onChange={(e) => setD({ ...d, phoneNumberId: e.target.value })}
            />
          </Field>
          <Field label="WhatsApp Business Account ID" htmlFor="wa-waba" error={errors.wabaId}>
            <Input
              id="wa-waba"
              inputMode="numeric"
              value={d.wabaId}
              onChange={(e) => setD({ ...d, wabaId: e.target.value })}
            />
          </Field>
          <Field
            label="Access token"
            htmlFor="wa-token"
            error={errors.accessToken}
            hint="Stored encrypted. Nobody can read it back, not even you."
          >
            <Input
              id="wa-token"
              type="password"
              autoComplete="off"
              value={d.accessToken}
              onChange={(e) => setD({ ...d, accessToken: e.target.value })}
            />
          </Field>
          {errors._ && <Alert tone="danger">{errors._}</Alert>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" loading={withToken.isPending}>
              {reconnect ? 'Reconnect' : 'Connect WhatsApp'}
            </Button>
          </DialogFooter>
        </form>
      )}
      {!manual && errors._ && <Alert tone="danger">{errors._}</Alert>}
    </div>
  );
}
