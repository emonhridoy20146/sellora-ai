'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, MessageCircle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ChannelGlyph } from '@/components/channel-icons';
import {
  WhatsAppDialog,
  useMetaSettings,
  useStartPageLogin,
} from '@/components/channels/meta-connect';
import { inboxKeys, useChannels } from '@/components/inbox/data';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Channel, MetaSettings } from '@/lib/api/types';
import { accountLine } from '@/lib/channels';
import { CHANNEL_LABEL, embedSnippet } from '@/lib/inbox';

interface Draft {
  name: string;
  greeting: string;
  color: string;
  sites: string;
  askContact: boolean;
  aiEnabled: boolean;
}

const EMPTY: Draft = {
  name: 'Website chat',
  greeting: 'Hi! Ask us anything about our products.',
  color: '#2563eb',
  sites: '',
  askContact: true,
  aiEnabled: true,
};

function draftOf(c: Channel): Draft {
  return {
    name: c.name,
    greeting: c.webChat?.greeting ?? '',
    color: c.webChat?.color ?? '#2563eb',
    sites: (c.webChat?.allowedOrigins ?? []).join('\n'),
    askContact: c.webChat?.askContact ?? true,
    aiEnabled: c.aiEnabled,
  };
}

function WebChatDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel?: Channel;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={channel ? 'Website chat settings' : 'Add the website chat'}
        description="A chat bubble on your website. Messages arrive in your inbox."
      >
        {/* Mounted per opening, so the form starts from the saved settings each time. */}
        {open && <WebChatForm channel={channel} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function WebChatForm({ channel, onDone }: { channel?: Channel; onDone: () => void }) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => (channel ? draftOf(channel) : EMPTY));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const allowedOrigins = d.sites
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const widget = {
        greeting: d.greeting,
        color: d.color,
        askContact: d.askContact,
        allowedOrigins,
      };
      return channel
        ? api<Channel>(`/orgs/${org.id}/channels/${channel.id}`, {
            method: 'PATCH',
            body: { name: d.name, aiEnabled: d.aiEnabled, webChat: widget },
          })
        : api<Channel>(`/orgs/${org.id}/channels/web-chat`, {
            method: 'POST',
            body: { name: d.name, aiEnabled: d.aiEnabled, ...widget },
          });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: inboxKeys.channels(org.id) });
      toast.success(channel ? 'Website chat saved' : 'Website chat added');
      onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors.length) {
        const fe = err.fieldErrors();
        // allowedOrigins.0 → the sites box
        const sites = Object.entries(fe).find(([k]) => k.includes('allowedOrigins'))?.[1];
        setErrors({ ...fe, ...(sites ? { sites } : {}) });
      } else setErrors({ _: errorMessage(err) });
    },
  });

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <Field label="Name" htmlFor="wc-name" error={errors.name} hint="Only your team sees it.">
        <Input
          id="wc-name"
          value={d.name}
          maxLength={80}
          onChange={(e) => setD({ ...d, name: e.target.value })}
        />
      </Field>
      <Field label="Greeting" htmlFor="wc-greeting" error={errors.greeting} optional>
        <Textarea
          id="wc-greeting"
          rows={2}
          maxLength={500}
          value={d.greeting}
          onChange={(e) => setD({ ...d, greeting: e.target.value })}
        />
      </Field>
      <Field label="Colour" htmlFor="wc-color" error={errors.color}>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Pick a colour"
            value={/^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#2563eb'}
            onChange={(e) => setD({ ...d, color: e.target.value })}
            className="h-9 w-12 cursor-pointer rounded-md border bg-card p-1"
          />
          <Input
            id="wc-color"
            value={d.color}
            className="w-32 font-mono"
            onChange={(e) => setD({ ...d, color: e.target.value })}
          />
        </div>
      </Field>
      <Field
        label="Websites allowed to show it"
        htmlFor="wc-sites"
        error={errors.sites}
        optional
        hint="One per line, like https://myshop.com. Leave empty to allow any site."
      >
        <Textarea
          id="wc-sites"
          rows={2}
          value={d.sites}
          placeholder="https://myshop.com"
          onChange={(e) => setD({ ...d, sites: e.target.value })}
        />
      </Field>
      <label className="flex items-start justify-between gap-4 text-sm">
        <span>
          <span className="font-medium">Ask for name and phone first</span>
          <span className="block text-[13px] text-muted-foreground">
            So you can call back and take orders.
          </span>
        </span>
        <Switch
          checked={d.askContact}
          onCheckedChange={(v) => setD({ ...d, askContact: v })}
          aria-label="Ask for name and phone first"
        />
      </label>
      <label className="flex items-start justify-between gap-4 text-sm">
        <span>
          <span className="font-medium">AI replies</span>
          <span className="block text-[13px] text-muted-foreground">
            The AI sales agent answers on this channel when your plan includes it.
          </span>
        </span>
        <Switch
          checked={d.aiEnabled}
          onCheckedChange={(v) => setD({ ...d, aiEnabled: v })}
          aria-label="AI replies"
        />
      </label>
      {errors._ && <Alert tone="danger">{errors._}</Alert>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {channel ? 'Save' : 'Add website chat'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ChannelCard({
  channel,
  origin,
  meta,
}: {
  channel: Channel;
  origin: string;
  meta: MetaSettings | undefined;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reconnectingWa, setReconnectingWa] = useState(false);
  const startLogin = useStartPageLogin(org.id);
  const refresh = () => qc.invalidateQueries({ queryKey: inboxKeys.channels(org.id) });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Channel>(`/orgs/${org.id}/channels/${channel.id}`, { method: 'PATCH', body }),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: () => api(`/orgs/${org.id}/channels/${channel.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Channel removed');
      void refresh();
    },
  });

  const on = channel.status === 'active';
  const key = channel.webChat?.publicKey;
  const social = channel.type !== 'web_chat';
  const account = accountLine(channel);
  const needsReconnect = channel.status === 'error';
  const reconnect = () =>
    channel.type === 'whatsapp' ? setReconnectingWa(true) : startLogin.mutate();

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3">
        <span className="grid size-10 shrink-0 place-content-center rounded-lg bg-muted">
          <ChannelGlyph type={channel.type} className="text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {channel.name}
            <Badge tone={on ? 'success' : channel.status === 'error' ? 'danger' : 'neutral'}>
              {on ? 'On' : channel.status === 'error' ? 'Needs attention' : 'Off'}
            </Badge>
          </CardTitle>
          <CardDescription>
            {CHANNEL_LABEL[channel.type]}
            {account && account !== channel.name ? ` · ${account}` : ''}
          </CardDescription>
        </div>
        <Switch
          checked={on}
          disabled={patch.isPending || needsReconnect}
          onCheckedChange={(v) => patch.mutate({ status: v ? 'active' : 'disabled' })}
          aria-label={`${channel.name} on or off`}
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        {needsReconnect && (
          <Alert tone="danger" title="Replies are stopped">
            {channel.statusReason ??
              'Meta stopped accepting messages from this channel. Reconnect it to reply again.'}
            {meta?.configured && (
              <div className="mt-2">
                <Button size="sm" onClick={reconnect} loading={startLogin.isPending}>
                  <RefreshCw /> Reconnect
                </Button>
              </div>
            )}
          </Alert>
        )}
        {key && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Embed code</p>
            <p className="text-[13px] text-muted-foreground">
              Paste this before <code>&lt;/body&gt;</code> on every page of your website.
            </p>
            <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 text-xs">
              {embedSnippet(origin, key)}
            </pre>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={embedSnippet(origin, key)} label="Copy code" />
              <Button variant="outline" size="sm" asChild>
                <a href={`/widget/${key}?preview=1`} target="_blank" rel="noreferrer">
                  <ExternalLink /> Try it
                </a>
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          {social ? (
            <label className="mr-auto flex items-center gap-2 text-[13px] text-muted-foreground">
              <Switch
                checked={channel.aiEnabled}
                disabled={patch.isPending}
                onCheckedChange={(v) => patch.mutate({ aiEnabled: v })}
                aria-label={`AI replies on ${channel.name}`}
              />
              AI replies {channel.aiEnabled ? 'on' : 'off'}
            </label>
          ) : (
            <span className="mr-auto text-[13px] text-muted-foreground">
              AI replies {channel.aiEnabled ? 'on' : 'off'}
              {channel.webChat?.allowedOrigins.length
                ? ` · shows on ${channel.webChat.allowedOrigins.join(', ')}`
                : ' · shows on any site'}
            </span>
          )}
          {social && !needsReconnect && meta?.configured && (
            <Button variant="ghost" size="sm" onClick={reconnect} loading={startLogin.isPending}>
              <RefreshCw /> Reconnect
            </Button>
          )}
          {channel.type === 'web_chat' && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil /> Settings
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
            <Trash2 /> Remove
          </Button>
        </div>
      </CardContent>
      {channel.type === 'web_chat' && (
        <WebChatDialog open={editing} onOpenChange={setEditing} channel={channel} />
      )}
      {channel.type === 'whatsapp' && meta?.configured && (
        <WhatsAppDialog
          orgId={org.id}
          settings={meta}
          open={reconnectingWa}
          onOpenChange={setReconnectingWa}
          reconnect={channel}
        />
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${channel.name}?`}
        description={
          social
            ? `Customers’ ${CHANNEL_LABEL[channel.type]} messages stop arriving in Sellora. Past conversations stay in the inbox as history.`
            : 'The chat stops working on your website. Its conversations stay in the inbox as history.'
        }
        confirmLabel="Remove"
        destructive
        onConfirm={() => remove.mutateAsync()}
      />
    </Card>
  );
}

const noSubscribe = () => () => undefined;

export default function ChannelsPage() {
  const { org, can } = useOrg();
  const manage = can('org.integrations.manage');
  const channels = useChannels(org.id);
  const meta = useMetaSettings(org.id, manage);
  const startLogin = useStartPageLogin(org.id);
  const [adding, setAdding] = useState(false);
  const [addingWa, setAddingWa] = useState(false);
  const origin = useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => '',
  );

  if (!manage)
    return (
      <EmptyState icon={MessageCircle} title="Only admins manage channels">
        Ask the business owner to connect your website chat or social pages.
      </EmptyState>
    );

  const metaReady = meta.data?.configured === true;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Where customers can message you. Every channel lands in the same{' '}
          <Link href={`/app/${org.id}/inbox`} className="text-primary hover:underline">
            inbox
          </Link>
          , and the AI sales agent can answer on each one.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAdding(true)}>
            <Plus /> Website chat
          </Button>
          <Button
            variant="outline"
            disabled={!metaReady}
            loading={startLogin.isPending}
            onClick={() => startLogin.mutate()}
          >
            <ChannelGlyph type="messenger" /> Facebook page &amp; Instagram
          </Button>
          <Button variant="outline" disabled={!metaReady} onClick={() => setAddingWa(true)}>
            <ChannelGlyph type="whatsapp" /> WhatsApp
          </Button>
        </div>
        {meta.data && !metaReady && (
          <Alert tone="info">
            Messenger, Instagram and WhatsApp are not switched on for this platform yet. The website
            chat works now.
          </Alert>
        )}
        {startLogin.isError && <Alert tone="danger">{errorMessage(startLogin.error)}</Alert>}
      </div>
      {channels.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : channels.isError ? (
        <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
      ) : channels.data.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No channels yet"
          action={<Button onClick={() => setAdding(true)}>Add website chat</Button>}
        >
          Add a chat bubble to your website
          {metaReady ? ', or connect your Facebook page, Instagram or WhatsApp,' : ''} and answer
          customers from the inbox.
        </EmptyState>
      ) : (
        channels.data.map((c) => (
          <ChannelCard key={c.id} channel={c} origin={origin} meta={meta.data} />
        ))
      )}
      <WebChatDialog open={adding} onOpenChange={setAdding} />
      {meta.data?.configured && (
        <WhatsAppDialog
          orgId={org.id}
          settings={meta.data}
          open={addingWa}
          onOpenChange={setAddingWa}
        />
      )}
    </div>
  );
}
