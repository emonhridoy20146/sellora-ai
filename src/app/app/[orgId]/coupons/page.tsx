'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Pencil, Plus, Power, Ticket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { CouponDialog } from '@/components/coupons/coupon-dialog';
import { couponKeys, useCoupons } from '@/components/coupons/hooks';
import { useOrg } from '@/components/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Coupon } from '@/lib/api/types';
import { COUPON_STATE, couponValueText, couponWhereText } from '@/lib/coupons';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';

/** When it works, in a few words. */
function whenText(c: Coupon, tz: string): string | null {
  if (c.startsAt && c.endsAt)
    return `${formatDateTime(c.startsAt, tz)} to ${formatDateTime(c.endsAt, tz)}`;
  if (c.startsAt) return `From ${formatDateTime(c.startsAt, tz)}`;
  if (c.endsAt) return `Until ${formatDateTime(c.endsAt, tz)}`;
  return null;
}

/**
 * Coupons (ADR 0031): codes shoppers type at the store checkout or on a landing page. The
 * discount is always worked out by the API from the coupon's rules.
 */
export default function CouponsPage() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const list = useCoupons(org.id);
  const editable = can('marketing.manage');
  const [editing, setEditing] = useState<Coupon | 'new' | null>(null);
  const [removing, setRemoving] = useState<Coupon | null>(null);

  if (!can('marketing.view') && !editable)
    return (
      <EmptyState icon={Ticket} title="Your role does not include coupons">
        Ask the business owner to give your role access to marketing.
      </EmptyState>
    );

  const items = list.data?.items ?? [];
  const pages = list.data?.landingPages ?? [];
  const full = list.data ? items.length >= list.data.limit : false;

  const toggle = (c: Coupon) =>
    api<Coupon>(`/orgs/${org.id}/coupons/${c.id}`, {
      method: 'PATCH',
      body: { active: !c.active },
    })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: couponKeys.all(org.id) });
        toast.success(c.active ? `${c.code} is off.` : `${c.code} is on.`);
      })
      .catch((err: unknown) => toast.error(errorMessage(err)));

  const newButton = editable && (
    <Button onClick={() => setEditing('new')} disabled={full}>
      <Plus /> New coupon
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Coupons"
        description="Codes shoppers type at your store checkout or in a landing page’s order form."
        actions={items.length > 0 ? newButton : undefined}
      />
      {list.isPending ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <PageError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Ticket}
            title="No coupons yet"
            action={
              newButton || (
                <p className="text-sm text-muted-foreground">
                  Ask a marketing manager to make a coupon.
                </p>
              )
            }
          >
            Make a code such as EID20 for 20% off, a set amount off, or free delivery. Choose when
            it works, how many times, and whether it works in the store, on landing pages, or both.
          </EmptyState>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0 py-0">
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Gives</TH>
                  <TH>Where</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Used</TH>
                  <TH className="text-right">Discount given</TH>
                  {editable && <TH className="w-10" />}
                </TR>
              </THead>
              <TBody>
                {items.map((c) => {
                  const st = COUPON_STATE[c.state];
                  const when = whenText(c, org.timezone);
                  return (
                    <TR key={c.id} data-coupon={c.code}>
                      <TD>
                        <span className="font-mono font-medium">{c.code}</span>
                        {c.note && (
                          <span className="block max-w-56 truncate text-xs text-muted-foreground">
                            {c.note}
                          </span>
                        )}
                      </TD>
                      <TD className="max-w-64 text-sm">
                        {couponValueText(c, org.currency)}
                        {when && (
                          <span className="block text-xs text-muted-foreground">{when}</span>
                        )}
                      </TD>
                      <TD className="text-sm">{couponWhereText(c, pages)}</TD>
                      <TD>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {formatNumber(c.used)}
                        {c.usageLimit !== null && (
                          <span className="text-muted-foreground">
                            {' '}
                            / {formatNumber(c.usageLimit)}
                          </span>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {formatMoney(c.discountGivenMinor, org.currency)}
                      </TD>
                      {editable && (
                        <TD>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`More for ${c.code}`}
                              >
                                <Ellipsis />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => setEditing(c)}>
                                <Pencil /> Change
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => void toggle(c)}>
                                <Power /> {c.active ? 'Switch off' : 'Switch on'}
                              </DropdownMenuItem>
                              {c.used === 0 && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onSelect={() => setRemoving(c)}
                                >
                                  <Trash2 /> Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TD>
                      )}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {full && (
        <p className="mt-3 text-sm text-muted-foreground">
          You have {list.data?.limit} coupons, the most a business keeps. Delete unused ones to make
          room.
        </p>
      )}
      {editing !== null && (
        <CouponDialog
          key={editing === 'new' ? 'new' : editing.id}
          orgId={org.id}
          currency={org.currency}
          coupon={editing === 'new' ? null : editing}
          pages={pages}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete ${removing?.code ?? 'coupon'}?`}
        description="Shoppers can no longer use the code. No order used it yet."
        confirmLabel="Delete coupon"
        destructive
        onConfirm={async () => {
          try {
            await api(`/orgs/${org.id}/coupons/${removing!.id}`, { method: 'DELETE' });
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
          await queryClient.invalidateQueries({ queryKey: couponKeys.all(org.id) });
          toast.success('Coupon deleted.');
        }}
      />
    </>
  );
}
