'use client';

import { ExternalLink, RefreshCw, Star, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import type { StoreDomain } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';
import { DOMAIN_STATUS, domainNextStep } from '@/lib/stores';

export function DomainStatusBadge({ status }: { status: StoreDomain['status'] }) {
  const s = DOMAIN_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** The DNS records a domain needs, laid out the way DNS providers ask for them. */
export function DnsRecordsTable({ domain }: { domain: StoreDomain }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="sr-only">DNS records for {domain.displayDomain}</caption>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Type
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Host / Name
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Value / Points to
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Copy</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {domain.records.map((r) => {
            const done =
              domain.dns &&
              (r.type === 'TXT' ? domain.dns.ownership : domain.dns.routing) &&
              domain.status !== 'rejected';
            return (
              <tr key={`${r.type}-${r.value}`} className="border-t align-top">
                <td className="px-3 py-2 font-mono text-xs">
                  {r.type}
                  {done && <span className="ml-1 text-success">✓</span>}
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs break-all">{r.host}</span>
                  <span className="block text-xs break-all text-muted-foreground">{r.name}</span>
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs break-all">{r.value}</span>
                  <span className="block text-xs text-muted-foreground">{r.purpose}</span>
                </td>
                <td className="px-3 py-2 text-right">
                  <CopyButton value={r.value} label="Copy" ariaLabel={`Copy the ${r.type} value`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One custom domain: where it stands, what to fix, and what can be done with it. */
export function DomainCard({
  domain: d,
  canManage,
  busy,
  onCheck,
  onPrimary,
  onRemove,
}: {
  domain: StoreDomain;
  canManage: boolean;
  busy: boolean;
  onCheck: () => void;
  onPrimary: () => void;
  onRemove: () => void;
}) {
  const showRecords = d.status === 'pending' || (d.status === 'active' && d.dns?.routing === false);
  return (
    <section
      aria-labelledby={`domain-${d.id}`}
      className="grid gap-3 rounded-lg border p-4"
      data-domain={d.domain}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`domain-${d.id}`} className="font-medium break-all">
          {d.status === 'active' ? (
            <a href={d.url} target="_blank" rel="noreferrer" className="hover:underline">
              {d.displayDomain}
            </a>
          ) : (
            d.displayDomain
          )}
        </h3>
        <DomainStatusBadge status={d.status} />
        {d.primary && (
          <Badge tone="info">
            <Star aria-hidden /> Main address
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {d.status === 'pending' ? DOMAIN_STATUS.pending.text : domainNextStep(d)}
      </p>

      {d.status === 'rejected' && d.review.reason && (
        <Alert tone="danger" title="The reviewer said">
          {d.review.reason}
        </Alert>
      )}
      {d.status === 'review' && <Alert tone="info">{DOMAIN_STATUS.review.text}</Alert>}
      {d.dns && d.dns.problems.length > 0 && d.status !== 'rejected' && d.status !== 'review' && (
        <Alert tone="warning" title={d.status === 'pending' ? 'Still to do' : 'DNS changed'}>
          <ul className="list-disc pl-4">
            {d.dns.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {showRecords && <DnsRecordsTable domain={d} />}
      {d.status === 'pending' && (
        <p className="text-xs text-muted-foreground">
          {d.dns ? (
            <span title={formatDateTime(d.dns.checkedAt)}>
              Last checked {formatRelative(d.dns.checkedAt)}.
            </span>
          ) : null}{' '}
          {d.nextCheckAt
            ? `Next automatic check ${formatRelative(d.nextCheckAt)}.`
            : 'Automatic checks have stopped; press Check now after you add the records.'}
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {(d.status === 'pending' || d.status === 'active') && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCheck}>
              <RefreshCw /> Check now
            </Button>
          )}
          {d.status === 'active' && !d.primary && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onPrimary}>
              <Star /> Make main address
            </Button>
          )}
          {d.status === 'active' && (
            <Button asChild variant="outline" size="sm">
              <a href={d.url} target="_blank" rel="noreferrer">
                <ExternalLink /> Visit
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive"
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 /> Remove
          </Button>
        </div>
      )}
    </section>
  );
}
