'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  Eye,
  Flag,
  PencilLine,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { usePlatform } from '@/components/platform-context';
import { DomainStatusBadge } from '@/components/stores/domain-card';
import { DomainDecision } from '@/components/stores/domain-decision';
import { StoreStatusBadge } from '@/components/stores/store-status';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type {
  PlatformStoreDetail,
  StoreChanges,
  StoreReviewFlag,
  StoreStatus,
} from '@/lib/api/types';
import { formatDateTime, formatMoney, formatRelative, humanize } from '@/lib/format';
import {
  CHANGE_AREA_LABEL,
  PAGE_INFO,
  PAGE_KEYS,
  SECTION_LABEL,
  STORE_STATUS,
  sectionSummary,
} from '@/lib/stores';

type Decision = 'approve' | 'reject' | 'suspend' | 'reinstate';

/** Each status as the reviewer reads it (the merchant's wording is in STORE_STATUS). */
const REVIEWER_TEXT: Record<StoreStatus, string> = {
  draft: 'The business is still setting it up. Shoppers cannot see it.',
  pending: 'Waiting for a decision. Open the preview, read the warnings, then decide.',
  live: 'Open to shoppers.',
  rejected: 'Sent back for changes. It returns here when the business sends it again.',
  paused: 'Paused by the business. Shoppers see a closed note.',
  suspended: 'Suspended by the platform. Shoppers cannot see it or order.',
};

const DECISION: Record<
  Decision,
  { label: string; title: string; text: string; reason?: string; destructive?: boolean }
> = {
  approve: {
    label: 'Approve and open',
    title: 'Open this store to shoppers?',
    text: 'The store goes live at its address at once and the owner gets an email. Later changes to its words and design go live too, and come back here under “Changed since approval”.',
  },
  reject: {
    label: 'Ask for changes',
    title: 'Send the store back?',
    text: 'The owner reads your note in the dashboard and by email, fixes the store and sends it again.',
    reason: 'What needs to change (the owner sees this)',
    destructive: true,
  },
  suspend: {
    label: 'Suspend store',
    title: 'Suspend this store?',
    text: 'Shoppers see that the store is unavailable and cannot order. The owner cannot reopen it; only the platform can reinstate it.',
    reason: 'Why (the owner sees this)',
    destructive: true,
  },
  reinstate: {
    label: 'Reinstate',
    title: 'Reinstate this store?',
    text: 'It returns to the status it had before the suspension.',
  },
};

function FlagList({ flags }: { flags: StoreReviewFlag[] }) {
  return (
    <ul className="grid gap-2">
      {flags.map((f, i) => (
        <li key={`${f.where}-${f.term}-${i}`} className="rounded-md border bg-card p-3 text-sm">
          <span className="font-medium">{f.label}</span>
          <span className="text-muted-foreground"> contains </span>
          <span className="rounded bg-warning-soft px-1 font-mono text-[13px]">{f.term}</span>
          <span className="block text-xs text-muted-foreground">{f.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function TextChange({
  label,
  before,
  now,
}: {
  label: string;
  before: string | null;
  now: string | null;
}) {
  return (
    <li className="grid gap-1.5 rounded-md border p-3 text-sm">
      <span className="font-medium">{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0">
          <span className="text-xs text-muted-foreground">Before</span>
          <p className="break-words whitespace-pre-line text-muted-foreground">
            {before ?? <em>Not there</em>}
          </p>
        </div>
        <div className="min-w-0">
          <span className="text-xs text-muted-foreground">Now</span>
          <p className="break-words whitespace-pre-line">{now ?? <em>Removed</em>}</p>
        </div>
      </div>
    </li>
  );
}

/** Changes the business made after approval: live already, waiting for a look. */
function ChangesCard({
  changes,
  timezone,
  editable,
  busy,
  onAccept,
  onAsk,
}: {
  changes: StoreChanges;
  timezone?: string;
  editable: boolean;
  busy: boolean;
  onAccept: () => void;
  onAsk: () => void;
}) {
  const changedAfterAsk = changes.askedAt && changes.lastAt > changes.askedAt;
  return (
    <Card className="border-warning/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PencilLine className="size-4" aria-hidden /> Changed since approval
        </CardTitle>
        <CardDescription>
          The business changed{' '}
          {changes.areas.map((a) => CHANGE_AREA_LABEL[a].toLowerCase()).join(', ')} after the store
          was approved. Shoppers already see it. Look, then mark it fine or ask for a fix (the store
          stays open); suspend the store if shoppers must not see it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <p className="text-muted-foreground">
          First change {formatDateTime(changes.since, timezone)}
          {changes.lastAt !== changes.since
            ? `, last ${formatDateTime(changes.lastAt, timezone)}`
            : ''}
          .
        </p>
        {changes.askedAt && (
          <Alert tone="info" title={`You asked for a fix ${formatRelative(changes.askedAt)}`}>
            <p>{changes.reason}</p>
            <p className="mt-1 text-muted-foreground">
              {changedAfterAsk
                ? 'The business saved the store after that.'
                : 'Nothing has changed since.'}
            </p>
          </Alert>
        )}
        {changes.flags.length ? (
          <FlagList flags={changes.flags} />
        ) : (
          <p className="flex items-center gap-2 text-success">
            <CircleCheck className="size-4" aria-hidden /> No warnings in what changed.
          </p>
        )}
        {changes.texts === null ? (
          <p className="text-muted-foreground">
            This store was approved before Sellora kept a copy of its words, so the earlier version
            cannot be shown. The words as they are now are below.
          </p>
        ) : changes.texts.length ? (
          <ul className="grid gap-2" aria-label="Words changed">
            {changes.texts.map((t) => (
              <TextChange key={t.where} label={t.label} before={t.before} now={t.now} />
            ))}
          </ul>
        ) : null}
        {(changes.areas.includes('design') || changes.areas.includes('products')) && (
          <p className="text-muted-foreground">
            {changes.areas.includes('design')
              ? 'Pictures, colours and layout are not compared: open the store to see them. '
              : ''}
            {changes.areas.includes('products')
              ? 'Products saved since approval are checked one by one; only warnings bring them here.'
              : ''}
          </p>
        )}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={onAccept}>
              <CircleCheck /> Looks fine
            </Button>
            <Button variant="outline" onClick={onAsk}>
              Ask for a fix
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[160px_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">
        {children || <span className="text-muted-foreground">–</span>}
      </dd>
    </div>
  );
}

export default function PlatformStorePage() {
  const { storeId } = useParams<{ storeId: string }>();
  const { can } = usePlatform();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [asking, setAsking] = useState(false);
  const key = ['platform', 'stores', 'detail', storeId];
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api<PlatformStoreDetail>(`/platform/stores/${storeId}`),
  });
  const recheck = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<{ flags: StoreReviewFlag[] }>(`/platform/stores/${storeId}/recheck`, { method: 'POST' }),
    onSuccess: ({ flags }) => {
      queryClient.setQueryData<PlatformStoreDetail>(key, (d) => (d ? { ...d, flags } : d));
      toast.success(flags.length ? `${flags.length} warning(s) found.` : 'No warnings found.');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const accept = useMutation({
    meta: { silent: true },
    mutationFn: (lastChangeAt: string) =>
      api<PlatformStoreDetail>(`/platform/stores/${storeId}/changes/accept`, {
        method: 'POST',
        body: { lastChangeAt },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'stores'] });
      toast.success('Marked as looked at.');
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      void detail.refetch();
    },
  });
  const askForFix = async (reason: string) => {
    const next = await api<PlatformStoreDetail>(`/platform/stores/${storeId}/changes/ask`, {
      method: 'POST',
      body: { reason },
    }).catch((err: unknown) => {
      toast.error(errorMessage(err));
      throw err;
    });
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: ['platform', 'stores'] });
    toast.success('The owner has been asked by email and in the dashboard.');
  };

  if (detail.isPending) return <Skeleton className="h-96" />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const s = detail.data;
  const editable = can('platform.stores.approve');
  const decisions: Decision[] =
    s.status === 'pending'
      ? ['approve', 'reject', 'suspend']
      : s.status === 'suspended'
        ? ['reinstate']
        : ['suspend'];

  const decide = async (d: Decision, reason: string) => {
    const body = d === 'approve' ? {} : d === 'reinstate' ? undefined : { reason };
    const next = await api<PlatformStoreDetail>(`/platform/stores/${storeId}/${d}`, {
      method: 'POST',
      body,
    }).catch((err: unknown) => {
      toast.error(errorMessage(err));
      throw err;
    });
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: ['platform', 'stores'] });
    toast.success(
      d === 'approve'
        ? 'Store approved. The owner has been told.'
        : d === 'reject'
          ? 'Sent back to the owner.'
          : d === 'suspend'
            ? 'Store suspended.'
            : 'Store reinstated.',
    );
  };

  const sections = s.theme.sections.filter((x) => x.enabled);
  const pages = PAGE_KEYS.filter((k) => s.pages[k].trim());

  return (
    <>
      <Link
        href="/admin/stores"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Online stores
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.name} <StoreStatusBadge status={s.status} />
          </span>
        }
        description={
          <>
            {s.org ? (
              <Link href={`/admin/tenants/${s.org.id}`} className="text-primary hover:underline">
                {s.org.name}
              </Link>
            ) : (
              'Unknown business'
            )}{' '}
            · <span className="break-all">{s.host}</span>
          </>
        }
        actions={
          <>
            {s.preview && (
              <Button asChild variant="outline">
                <a href={s.preview.url} target="_blank" rel="noreferrer">
                  <Eye /> Open preview
                </a>
              </Button>
            )}
            {(s.status === 'live' || s.status === 'paused') && (
              <Button asChild variant="outline">
                <a href={s.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Visit store
                </a>
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid min-w-0 content-start gap-6">
          {s.changes && (
            <ChangesCard
              changes={s.changes}
              editable={editable}
              busy={accept.isPending}
              onAccept={() => accept.mutate(s.changes!.lastAt)}
              onAsk={() => setAsking(true)}
            />
          )}
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Flag className="size-4" aria-hidden /> Automatic check
                </CardTitle>
                <CardDescription>
                  Words often used for banned or misleading products, found in the store and its
                  newest products. A warning is a reason to look, not a verdict.
                </CardDescription>
              </div>
              {editable && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={recheck.isPending}
                  onClick={() => recheck.mutate()}
                >
                  <RefreshCw /> Check again
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {s.flags.length ? (
                <FlagList flags={s.flags} />
              ) : (
                <p className="flex items-center gap-2 text-sm text-success">
                  <CircleCheck className="size-4" aria-hidden /> No warnings.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Store</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm">
                <Row label="Address">{s.url}</Row>
                <Row label="Theme">
                  <span className="inline-flex items-center gap-2">
                    {humanize(s.themeKey)}
                    <span
                      className="size-4 rounded-full border"
                      style={{ background: s.theme.palette.primary }}
                      title={s.theme.palette.primary}
                    />
                    <span
                      className="size-4 rounded-full border"
                      style={{ background: s.theme.palette.accent }}
                      title={s.theme.palette.accent}
                    />
                  </span>
                </Row>
                <Row label="Language">{s.language === 'bn' ? 'Bangla' : 'English'}</Row>
                <Row label="Phone">{s.contact.phone}</Row>
                <Row label="WhatsApp">{s.contact.whatsapp}</Row>
                <Row label="Email">{s.contact.email}</Row>
                <Row label="Address">{s.contact.address}</Row>
                <Row label="Search title">{s.seo.title}</Row>
                <Row label="Search description">{s.seo.description}</Row>
                <Row label="Announcement">{s.theme.announcement}</Row>
                <Row label="Checkout note">{s.checkout.note}</Row>
                <Row label="Smallest order">
                  {s.checkout.minOrderMinor && s.org
                    ? formatMoney(s.checkout.minOrderMinor, s.org.currency)
                    : ''}
                </Row>
                <Row label="Social links">
                  {(['facebook', 'instagram', 'youtube', 'tiktok'] as const)
                    .filter((k) => s.social[k])
                    .map((k) => (
                      <a
                        key={k}
                        href={s.social[k]}
                        target="_blank"
                        rel="noreferrer nofollow"
                        className="mr-3 text-primary hover:underline"
                      >
                        {humanize(k)}
                      </a>
                    ))}
                </Row>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Home page and pages</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              <ol className="grid gap-1.5">
                {sections.map((x) => (
                  <li key={x.id}>
                    <span className="text-muted-foreground">{SECTION_LABEL[x.type]}: </span>
                    {sectionSummary(x)}
                  </li>
                ))}
                {sections.length === 0 && (
                  <li className="text-muted-foreground">No sections shown.</li>
                )}
              </ol>
              {pages.map((k) => (
                <details key={k} className="rounded-md border p-3">
                  <summary className="cursor-pointer font-medium">{PAGE_INFO[k].label}</summary>
                  <p className="mt-2 whitespace-pre-line text-muted-foreground">{s.pages[k]}</p>
                </details>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Decision</CardTitle>
              <CardDescription>{REVIEWER_TEXT[s.status]}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <ul className="grid gap-1.5">
                <li className="flex items-center gap-2">
                  {s.readiness?.activeProducts ? (
                    <CircleCheck className="size-4 text-success" aria-hidden />
                  ) : (
                    <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
                  )}
                  {s.readiness?.activeProducts ?? 0} active products
                </li>
                <li className="flex items-center gap-2">
                  {s.readiness?.hasContact ? (
                    <CircleCheck className="size-4 text-success" aria-hidden />
                  ) : (
                    <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
                  )}
                  {s.readiness?.hasContact ? 'Has a contact number' : 'No contact number'}
                </li>
              </ul>
              {s.review.submittedAt && (
                <p className="text-muted-foreground">Sent {formatDateTime(s.review.submittedAt)}</p>
              )}
              {s.review.decidedAt && (
                <p className="text-muted-foreground">
                  Last decision {formatDateTime(s.review.decidedAt)}
                  {s.review.autoApproved ? ' (automatic)' : ''}
                </p>
              )}
              {s.review.reason && (
                <Alert tone={s.status === 'live' ? 'info' : 'warning'} title="Note to the owner">
                  {s.review.reason}
                </Alert>
              )}
              {s.status === 'suspended' && s.statusBeforeSuspension && (
                <p className="text-muted-foreground">
                  Before the suspension it was{' '}
                  {STORE_STATUS[s.statusBeforeSuspension].label.toLowerCase()}.
                </p>
              )}
              {editable && (
                <div className="grid gap-2 pt-1">
                  {decisions.map((d) => (
                    <Button
                      key={d}
                      variant={d === 'approve' || d === 'reinstate' ? 'default' : 'outline'}
                      className={d === 'suspend' ? 'text-destructive' : undefined}
                      onClick={() => setDecision(d)}
                    >
                      {DECISION[d].label}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Custom domains</CardTitle>
              <CardDescription>
                {s.domains.length
                  ? 'Domains the business has added for this store.'
                  : 'The business has not added a domain. The store uses its Sellora address.'}
              </CardDescription>
            </CardHeader>
            {s.domains.length > 0 && (
              <CardContent>
                <ul className="grid gap-3 text-sm">
                  {s.domains.map((d) => (
                    <li
                      key={d.id}
                      className="grid gap-2 rounded-md border p-3"
                      data-domain={d.domain}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium break-all">{d.displayDomain}</span>
                        <DomainStatusBadge status={d.status} />
                        {d.primary && <span className="text-xs text-muted-foreground">Main</span>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {d.status === 'pending'
                          ? `Added ${formatRelative(d.createdAt)}, waiting for its DNS records.`
                          : d.status === 'rejected'
                            ? `Not approved${d.review.reason ? `: ${d.review.reason}` : '.'}`
                            : d.verifiedAt
                              ? `DNS proven ${formatRelative(d.verifiedAt)}.`
                              : null}
                        {d.status === 'active' && d.dns?.routing === false
                          ? ' Its DNS no longer points here.'
                          : ''}
                      </p>
                      {editable && (
                        <DomainDecision
                          domain={d}
                          onDone={() => {
                            void queryClient.invalidateQueries({ queryKey: key });
                            void queryClient.invalidateQueries({
                              queryKey: ['platform', 'store-domains'],
                            });
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            )}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(o) => !o && setDecision(null)}
        title={decision ? DECISION[decision].title : ''}
        description={decision ? DECISION[decision].text : undefined}
        confirmLabel={decision ? DECISION[decision].label : 'Confirm'}
        destructive={decision ? DECISION[decision].destructive : false}
        reason={Boolean(decision && DECISION[decision].reason)}
        reasonLabel={decision ? DECISION[decision].reason : undefined}
        reasonMin={5}
        onConfirm={(reason) => (decision ? decide(decision, reason) : undefined)}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Ask the business to fix this?"
        description="The owner gets an email and sees your note on the store page. The store stays open; it stays in this list until you mark the changes fine."
        confirmLabel="Ask for a fix"
        reason
        reasonLabel="What to fix (the owner sees this)"
        reasonMin={5}
        onConfirm={(reason) => askForFix(reason)}
      />
    </>
  );
}
