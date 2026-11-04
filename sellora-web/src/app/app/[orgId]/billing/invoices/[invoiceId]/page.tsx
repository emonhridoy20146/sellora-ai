'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { BrandMark } from '@/components/brand';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { site } from '@/config/site';
import { api } from '@/lib/api/client';
import type { Invoice } from '@/lib/api/types';
import { formatDate, formatMoney } from '@/lib/format';

export default function InvoicePage() {
  const { org } = useOrg();
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const q = useQuery({
    queryKey: ['org', org.id, 'billing', 'invoice', invoiceId],
    queryFn: () => api<Invoice>(`/orgs/${org.id}/billing/invoices/${invoiceId}`),
  });
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const inv = q.data;
  const money = (n: number) => formatMoney(n, inv.currency);

  return (
    <div className="grid gap-4">
      <div className="flex justify-between print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/app/${org.id}/billing/invoices`}>
            <ArrowLeft /> All receipts
          </Link>
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer /> Print or save as PDF
        </Button>
      </div>
      <article className="mx-auto w-full max-w-2xl rounded-lg border bg-card p-8 shadow-xs print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
          <div className="flex items-center gap-2">
            <BrandMark />
            <span className="font-semibold">{site.name}</span>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">Receipt</p>
            <p className="font-mono text-sm">{inv.number}</p>
            <p className="text-sm text-muted-foreground">
              {formatDate(inv.issuedAt, org.timezone)}
            </p>
          </div>
        </header>
        <section className="py-6 text-sm">
          <p className="text-muted-foreground">Billed to</p>
          <p className="font-medium">{inv.billTo.legalName || inv.billTo.name}</p>
          {inv.billTo.email && <p>{inv.billTo.email}</p>}
          {inv.billTo.address && <p className="whitespace-pre-line">{inv.billTo.address}</p>}
        </section>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Qty</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i} className="border-b">
                <td className="py-2">{l.description}</td>
                <td className="tabular py-2 text-right">{l.quantity}</td>
                <td className="tabular py-2 text-right">{money(l.unitMinor * l.quantity)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {inv.taxMinor > 0 && (
              <>
                <tr>
                  <td colSpan={2} className="pt-3 text-right text-muted-foreground">
                    Subtotal
                  </td>
                  <td className="tabular pt-3 text-right">{money(inv.subtotalMinor)}</td>
                </tr>
                <tr>
                  <td colSpan={2} className="text-right text-muted-foreground">
                    {inv.taxLabel} ({(inv.taxRateBps / 100).toFixed(2)}%, included)
                  </td>
                  <td className="tabular text-right">{money(inv.taxMinor)}</td>
                </tr>
              </>
            )}
            <tr>
              <td colSpan={2} className="pt-3 text-right font-semibold">
                Total paid
              </td>
              <td className="tabular pt-3 text-right font-semibold">{money(inv.totalMinor)}</td>
            </tr>
          </tfoot>
        </table>
        <p className="mt-8 text-xs text-muted-foreground">
          Paid with {inv.paidWith}. Thank you for your business.
        </p>
      </article>
    </div>
  );
}
