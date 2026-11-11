'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Pencil, Plus, Radar, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adTrackingKeys, DestinationDialog } from '@/components/ad-tracking/destination-dialog';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import {
  AD_EVENT_ONE,
  destinationBadge,
  LOG_SOURCE,
  weekLine,
  whatIsSent,
  whereUsed,
} from '@/lib/ad-tracking';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type {
  AdConsentMode,
  AdDestination,
  AdEventLogEntry,
  AdPlatformDescriptor,
  AdTrackingOverview,
  AdTrackingSites,
} from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';

function useOverview(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: adTrackingKeys.all(orgId),
    queryFn: () => api<AdTrackingOverview>(`/orgs/${orgId}/ad-tracking`),
    enabled,
  });
}

function EventLog({ destination }: { destination: AdDestination }) {
  const { org } = useOrg();
  const log = useQuery({
    queryKey: adTrackingKeys.events(org.id, destination.id),
    queryFn: () =>
      api<{ items: AdEventLogEntry[] }>(
        `/orgs/${org.id}/ad-tracking/events?destinationId=${destination.id}&limit=20`,
      ),
  });
  if (log.isPending) return <Skeleton className="h-24 w-full" />;
  if (log.isError) return <ErrorState error={log.error} onRetry={() => void log.refetch()} />;
  if (!log.data.items.length)
    return (
      <p className="text-sm text-muted-foreground">
        No server events yet. They appear here as shoppers browse and order.
      </p>
    );
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>When</TH>
            <TH>Event</TH>
            <TH>From</TH>
            <TH>Answer</TH>
          </TR>
        </THead>
        <TBody>
          {log.data.items.map((e) => (
            <TR key={e.id}>
              <TD className="whitespace-nowrap">{formatDateTime(e.at, org.timezone)}</TD>
              <TD>
                {AD_EVENT_ONE[e.event]}
                {e.orderNumber && (
                  <span className="block text-[13px] text-muted-foreground">
                    Order {e.orderNumber}
                  </span>
                )}
              </TD>
              <TD>{LOG_SOURCE[e.source]}</TD>
              <TD>
                <Badge tone={e.status === 'sent' ? 'success' : 'danger'}>
                  {e.status === 'sent' ? 'Sent' : 'Failed'}
                </Badge>
                <span className="mt-0.5 block text-[13px] text-muted-foreground">{e.detail}</span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function DestinationCard({
  destination: d,
  descriptor,
  sites,
}: {
  destination: AdDestination;
  descriptor: AdPlatformDescriptor;
  sites: AdTrackingSites;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const badge = destinationBadge(d);
  const server = descriptor.serverEvents.length > 0;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<AdDestination>(`/orgs/${org.id}/ad-tracking/destinations/${d.id}`, {
        method: 'PATCH',
        body: { enabled },
      }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: adTrackingKeys.all(org.id) });
      toast.success(
        a.enabled ? `${a.name} is on again.` : `${a.name} is off. Nothing is sent to it.`,
      );
    },
  });
  const test = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<{ ok: boolean; message: string }>(
        `/orgs/${org.id}/ad-tracking/destinations/${d.id}/test`,
        { method: 'POST' },
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: adTrackingKeys.all(org.id) });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card role="group" aria-label={d.name}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Radar className="size-4 text-muted-foreground" aria-hidden />
            {d.name}
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </CardTitle>
          <CardDescription>
            {d.platformName} · {descriptor.publicIdLabel}{' '}
            <span className="font-mono">{d.publicId}</span>
            {d.conversionLabel ? (
              <>
                {' '}
                · label <span className="font-mono">{d.conversionLabel}</span>
              </>
            ) : null}
          </CardDescription>
        </div>
        <Switch
          checked={d.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(v) => toggle.mutate(v)}
          aria-label={`${d.name} on or off`}
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        {d.lastError && (
          <Alert tone="danger" title={`${descriptor.name} refused the last server event`}>
            {d.lastError.message} ({formatDateTime(d.lastError.at, org.timezone)}). The browser tag
            keeps running. Check the key, then save it again.
          </Alert>
        )}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Loads on</dt>
          <dd>{whereUsed(d, sites)}</dd>
          <dt className="text-muted-foreground">Sends</dt>
          <dd>{whatIsSent(descriptor, d)}</dd>
          {descriptor.secretLabel && (
            <>
              <dt className="text-muted-foreground">Server key</dt>
              <dd>
                {d.hasSecret ? `Saved (${d.secretHint ?? 'hidden'}). ` : 'None. '}
                {d.lastCheck.summary}{' '}
                <span className="text-muted-foreground">· {formatRelative(d.lastCheck.at)}</span>
              </dd>
            </>
          )}
          {server && d.hasSecret && (
            <>
              <dt className="text-muted-foreground">Server events</dt>
              <dd>
                {weekLine(d.week)}
                {d.lastSentAt && (
                  <span className="text-muted-foreground">
                    {' '}
                    · last {formatRelative(d.lastSentAt)}
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> Change
          </Button>
          {server && d.hasSecret && (
            <>
              <Button
                variant="outline"
                size="sm"
                loading={test.isPending}
                disabled={!d.enabled}
                onClick={() => test.mutate()}
              >
                <Send /> Send test event
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showLog}
                onClick={() => setShowLog((v) => !v)}
              >
                <ChevronDown className={showLog ? 'rotate-180' : undefined} /> What was sent
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRemoving(true)}>
            <Trash2 /> Remove
          </Button>
        </div>
        {showLog && <EventLog destination={d} />}
      </CardContent>
      <DestinationDialog
        open={editing}
        onOpenChange={setEditing}
        descriptor={descriptor}
        destination={d}
        sites={sites}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={`Remove ${d.name}?`}
        description="Its key is deleted and your store and landing pages stop loading it. What was already sent stays in your ad account."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await api(`/orgs/${org.id}/ad-tracking/destinations/${d.id}`, { method: 'DELETE' });
            await qc.invalidateQueries({ queryKey: adTrackingKeys.all(org.id) });
            toast.success(`${d.name} removed.`);
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </Card>
  );
}

function ConsentCard({ consent }: { consent: AdConsentMode }) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (c: AdConsentMode) =>
      api<{ consent: AdConsentMode }>(`/orgs/${org.id}/ad-tracking/settings`, {
        method: 'PATCH',
        body: { consent: c },
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: adTrackingKeys.all(org.id) });
      toast.success(
        s.consent === 'ask'
          ? 'Shoppers are asked first. Nothing is tracked until they accept.'
          : 'Tracking starts when a shopper opens your store.',
      );
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Asking shoppers first</CardTitle>
        <CardDescription>
          A small banner on your store and landing pages lets shoppers accept or refuse tracking.
          Until they accept, no pixel loads and nothing about them is sent from the server.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Segmented
          label="Ask shoppers before tracking"
          value={consent}
          onChange={(v) => save.mutate(v)}
          options={[
            { value: 'off', label: 'Don’t ask' },
            { value: 'ask', label: 'Ask first' },
          ]}
        />
        <p className="mt-3 text-[13px] text-muted-foreground">
          {consent === 'ask'
            ? 'Recommended if you sell to shoppers in Europe or the UK, where the law asks for it. Ads learn from fewer shoppers.'
            : 'Common for shops selling in Bangladesh. Your privacy policy should say you use these ad tags.'}
        </p>
      </CardContent>
    </Card>
  );
}

export default function AdTrackingSettingsPage() {
  const { org, can } = useOrg();
  const manage = can('org.integrations.manage');
  const overview = useOverview(org.id, manage);
  const [adding, setAdding] = useState<AdPlatformDescriptor | null>(null);

  if (!manage)
    return (
      <EmptyState icon={Radar} title="Only admins manage ad tracking">
        Ask the business owner to add your pixels and tags.
      </EmptyState>
    );
  if (overview.isPending) return <Skeleton className="h-64 w-full" />;
  if (overview.isError)
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;

  const o = overview.data;
  const byKey = new Map(o.platforms.map((p) => [p.key, p]));
  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Put your own Meta, TikTok and Google tags on your store and landing pages, so your ads
          learn who buys. With a server key, Sellora also sends each event from its server with the
          same event id, so it still counts when an ad blocker stops the browser tag, and each
          platform counts it once.
        </p>
        <div className="flex flex-wrap gap-2">
          {o.platforms.map((p) => (
            <Button
              key={p.key}
              variant={o.destinations.length ? 'outline' : 'default'}
              onClick={() => setAdding(p)}
            >
              <Plus /> {p.name}
            </Button>
          ))}
        </div>
      </div>
      {o.destinations.length === 0 ? (
        <EmptyState icon={Radar} title="No pixel or tag yet">
          Add the Meta Pixel you use for Facebook and Instagram ads, your TikTok Pixel, Google
          Analytics or a Google Ads conversion. You need the id from your own ad account; the server
          keys are optional.
        </EmptyState>
      ) : (
        o.destinations.map((d) => {
          const desc = byKey.get(d.platform);
          return desc ? (
            <DestinationCard key={d.id} destination={d} descriptor={desc} sites={o.sites} />
          ) : null;
        })
      )}
      <ConsentCard consent={o.settings.consent} />
      {adding && (
        <DestinationDialog
          open
          onOpenChange={(v) => !v && setAdding(null)}
          descriptor={adding}
          sites={o.sites}
        />
      )}
    </div>
  );
}
