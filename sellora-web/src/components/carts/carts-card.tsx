'use client';

import { Ellipsis, Link2, MousePointerClick, Search, Send, ShoppingCart, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { StatusBadge } from '@/components/sms/messages-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { AbandonedCart, CartSummary, CartView } from '@/lib/api/types';
import {
  CART_VIEWS,
  SKIP_LABEL,
  canRemindNow,
  cartBadge,
  cartItemsLine,
  reminderLabel,
  sentCount,
} from '@/lib/carts';
import { formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import { localPhone } from '@/lib/sms';
import { cn } from '@/lib/utils';
import { useCartAction, useCarts } from './data';

function countFor(s: CartSummary | undefined, view: CartView): number | undefined {
  if (!s) return undefined;
  if (view === 'abandoned') return s.open;
  if (view === 'recovered') return s.recovered;
  if (view === 'dismissed') return s.dismissed;
  return undefined;
}

/** What is next for a cart, in one line. */
function nextLine(c: AbandonedCart, now = Date.now()): string {
  if (c.state === 'shopping') return 'Still on the page';
  if (c.status === 'ordered')
    return c.order ? `Ordered ${formatRelative(c.order.at, now)}` : 'Ordered';
  if (c.status === 'dismissed') return 'Reminders stopped';
  const skip = c.lastSkip ? SKIP_LABEL[c.lastSkip.reason] : null;
  if (!c.nextReminderAt) return skip ?? 'No reminder left to send';
  const due = new Date(c.nextReminderAt).getTime();
  const when = due <= now ? 'due now' : formatRelative(c.nextReminderAt, now);
  return skip ? `${skip} · tries again ${when}` : `Next reminder ${when}`;
}

/** Saved carts by what happened to them, with the reminders each one got. */
export function CartsCard({
  summary,
  editable,
}: {
  summary: CartSummary | undefined;
  editable: boolean;
}) {
  const { org } = useOrg();
  const [view, setView] = useState<CartView>('abandoned');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<AbandonedCart | null>(null);
  const q = useCarts(org.id, view, phone);
  const action = useCartAction(org.id);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const opened = items.find((c) => c.id === openId) ?? null;
  const current = CART_VIEWS.find((v) => v.value === view)!;
  const phoneError =
    q.isError && q.error instanceof ApiError && q.error.fieldErrors().phone
      ? q.error.fieldErrors().phone
      : null;

  const remind = (c: AbandonedCart) =>
    action.mutate(
      { id: c.id, action: 'remind' },
      {
        onSuccess: (next) => {
          const last = next.reminders.at(-1);
          if (last?.message) toast.success(`Reminder sent to ${localPhone(next.customer.phone)}.`);
          else toast.warning('Nothing was sent: SMS is off or the number asked to stop.');
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Carts</CardTitle>
          <CardDescription>
            Kept for 60 days after the last change. A cart counts as left 30 minutes after the
            shopper stops.
          </CardDescription>
        </div>
        <form
          role="search"
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPhone(phoneInput.trim());
          }}
        >
          <div className="grid gap-1">
            <label htmlFor="cart-phone" className="sr-only">
              Find carts by phone
            </label>
            <Input
              id="cart-phone"
              inputMode="tel"
              placeholder="Phone, like 01712345678"
              className="h-8 w-56"
              value={phoneInput}
              aria-invalid={Boolean(phoneError)}
              onChange={(e) => setPhoneInput(e.target.value)}
            />
            {phoneError && (
              <p role="alert" className="text-[13px] text-destructive">
                {phoneError}
              </p>
            )}
          </div>
          <Button type="submit" size="sm" variant="outline" aria-label="Find">
            <Search />
          </Button>
          {phone && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Clear the phone search"
              onClick={() => {
                setPhone('');
                setPhoneInput('');
              }}
            >
              <X />
            </Button>
          )}
        </form>
      </CardHeader>
      <nav aria-label="Cart views" className="-mt-1 overflow-x-auto px-5 pb-3">
        <ul className="flex min-w-max gap-1">
          {CART_VIEWS.map((v) => {
            const n = countFor(summary, v.value);
            return (
              <li key={v.value}>
                <button
                  type="button"
                  aria-pressed={view === v.value}
                  onClick={() => setView(v.value)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                    view === v.value
                      ? 'border-primary bg-info-soft text-primary'
                      : 'bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  {v.label}
                  {n !== undefined && <span className="tabular opacity-80">{n}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <CardContent className={cn('px-0 pb-0', q.isPlaceholderData && 'opacity-60')}>
        {q.isPending ? (
          <Skeleton className="m-5 h-40" />
        ) : q.isError && !phoneError ? (
          <PageError error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title={phone ? 'No cart from that number' : current.empty}
          />
        ) : (
          <div className="overflow-x-auto border-t">
            <Table>
              <THead>
                <TR>
                  <TH>Shopper</TH>
                  <TH>Cart</TH>
                  <TH>Reminders</TH>
                  <TH className="text-right">
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {items.map((c) => {
                  const badge = cartBadge(c);
                  const sent = sentCount(c.reminders);
                  const busy = action.isPending && action.variables?.id === c.id;
                  return (
                    <TR key={c.id}>
                      <TD className="whitespace-nowrap">
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={() => setOpenId(c.id)}
                        >
                          <span className="block font-medium">
                            {c.customer.name || 'No name given'}
                          </span>
                          <span className="tabular block text-[13px] text-muted-foreground">
                            {localPhone(c.customer.phone)}
                          </span>
                        </button>
                      </TD>
                      <TD className="min-w-56">
                        <p className="line-clamp-1 text-sm">{cartItemsLine(c.items)}</p>
                        <p className="text-[13px] text-muted-foreground">
                          <span className="tabular">{formatMoney(c.totalMinor, c.currency)}</span>
                          {' · '}
                          {c.landingPage ? c.landingPage.name : c.store.name}
                          {' · '}
                          <time
                            dateTime={c.lastActivityAt}
                            title={formatDateTime(c.lastActivityAt, org.timezone)}
                          >
                            {formatRelative(c.lastActivityAt)}
                          </time>
                        </p>
                      </TD>
                      <TD className="min-w-56">
                        <p className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                          {sent > 0 && (
                            <span className="text-[13px] text-muted-foreground">{sent} sent</span>
                          )}
                          {c.clicks > 0 && (
                            <span
                              className="inline-flex items-center gap-1 text-[13px] text-muted-foreground"
                              title={`Opened ${formatRelative(c.lastClickAt)}`}
                            >
                              <MousePointerClick className="size-3.5" aria-hidden />
                              {c.clicks}× opened
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[13px] text-muted-foreground">
                          {c.order ? (
                            <Link
                              href={`/app/${org.id}/orders/${c.order.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              Order {c.order.number} · {formatMoney(c.order.totalMinor, c.currency)}
                            </Link>
                          ) : (
                            nextLine(c)
                          )}
                        </p>
                      </TD>
                      <TD className="text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {editable && canRemindNow(c) && c.state !== 'shopping' && (
                            <Button
                              size="sm"
                              variant="outline"
                              loading={busy && action.variables?.action === 'remind'}
                              disabled={action.isPending}
                              onClick={() => remind(c)}
                            >
                              <Send aria-hidden /> Send now
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`More for the cart from ${localPhone(c.customer.phone)}`}
                              >
                                <Ellipsis />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => setOpenId(c.id)}>
                                <ShoppingCart /> Details
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  void navigator.clipboard
                                    .writeText(c.link)
                                    .then(() => toast.success('Cart link copied.'))
                                }
                              >
                                <Link2 /> Copy cart link
                              </DropdownMenuItem>
                              {editable && c.status === 'open' && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onSelect={() => setStopping(c)}
                                >
                                  <X /> Stop reminders
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
        <LoadMore
          hasMore={Boolean(q.hasNextPage)}
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        />
      </CardContent>

      <CartDialog
        cart={opened}
        editable={editable}
        busy={action.isPending}
        onRemind={remind}
        onStop={(c) => setStopping(c)}
        onOpenChange={(o) => !o && setOpenId(null)}
      />
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(o) => !o && setStopping(null)}
        title="Stop reminders for this cart?"
        description={
          stopping
            ? `${localPhone(stopping.customer.phone)} gets no more reminders for this cart. The cart stays in Stopped, and an order from it still counts.`
            : undefined
        }
        confirmLabel="Stop reminders"
        destructive
        onConfirm={async () => {
          if (!stopping) return;
          try {
            await action.mutateAsync({ id: stopping.id, action: 'dismiss' });
            toast.success('Reminders stopped for that cart.');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </Card>
  );
}

/** One cart: what is in it, every reminder and what happened to it, and the link. */
function CartDialog({
  cart,
  editable,
  busy,
  onRemind,
  onStop,
  onOpenChange,
}: {
  cart: AbandonedCart | null;
  editable: boolean;
  busy: boolean;
  onRemind: (c: AbandonedCart) => void;
  onStop: (c: AbandonedCart) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { org } = useOrg();
  if (!cart) return null;
  const badge = cartBadge(cart);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title={`Cart from ${cart.customer.name || localPhone(cart.customer.phone)}`}
        description={`${localPhone(cart.customer.phone)} · ${cart.landingPage ? `Landing page “${cart.landingPage.name}”` : cart.store.name} · last change ${formatDateTime(cart.lastActivityAt, org.timezone)}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <span className="text-[13px] text-muted-foreground">{nextLine(cart)}</span>
        </div>

        <section aria-labelledby="cart-items" className="grid gap-2">
          <h3 id="cart-items" className="text-sm font-semibold">
            In the cart
          </h3>
          <ul className="divide-y rounded-lg border">
            {cart.items.map((l) => (
              <li
                key={`${l.variantId}`}
                className="flex items-start justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="block truncate">{l.name}</span>
                  {l.variantTitle && (
                    <span className="block text-[13px] text-muted-foreground">
                      {l.variantTitle}
                    </span>
                  )}
                </span>
                <span className="tabular shrink-0 text-right">
                  {l.quantity} × {formatMoney(l.unitPriceMinor, cart.currency)}
                </span>
              </li>
            ))}
            <li className="flex justify-between px-3 py-2 text-sm font-medium">
              <span>Total</span>
              <span className="tabular">{formatMoney(cart.totalMinor, cart.currency)}</span>
            </li>
          </ul>
        </section>

        <section aria-labelledby="cart-reminders" className="grid gap-2">
          <h3 id="cart-reminders" className="text-sm font-semibold">
            Reminders
          </h3>
          {cart.reminders.length === 0 ? (
            <p className="text-sm text-muted-foreground">None sent yet.</p>
          ) : (
            <ol className="grid gap-1.5">
              {cart.reminders.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{reminderLabel(r)}</span>
                  <time className="text-[13px] text-muted-foreground" dateTime={r.at}>
                    {formatDateTime(r.at, org.timezone)}
                  </time>
                  {r.message ? (
                    <>
                      <StatusBadge m={r.message} />
                      {r.message.priceMinor > 0 && (
                        <span className="tabular text-[13px] text-muted-foreground">
                          {formatMoney(r.message.priceMinor, r.message.currency)}
                        </span>
                      )}
                      {r.message.error && (
                        <span className="text-[13px] text-destructive">{r.message.error}</span>
                      )}
                    </>
                  ) : (
                    <Badge tone="neutral">
                      {r.skipped === 'opted_out' ? 'Number stopped them' : 'Not sent: SMS off'}
                    </Badge>
                  )}
                </li>
              ))}
            </ol>
          )}
          {cart.clicks > 0 && (
            <p className="text-[13px] text-muted-foreground">
              The link was opened {cart.clicks} time{cart.clicks === 1 ? '' : 's'}, last{' '}
              {formatRelative(cart.lastClickAt)}.
            </p>
          )}
          {cart.order && (
            <p className="text-sm">
              <Link
                href={`/app/${org.id}/orders/${cart.order.id}`}
                className="font-medium text-primary hover:underline"
              >
                Order {cart.order.number}
              </Link>{' '}
              · {formatMoney(cart.order.totalMinor, cart.currency)} ·{' '}
              {formatDateTime(cart.order.at, org.timezone)}
              {cart.recovered ? ' · came within 7 days of a reminder' : ''}
            </p>
          )}
        </section>

        <section aria-labelledby="cart-link" className="grid gap-2">
          <h3 id="cart-link" className="text-sm font-semibold">
            Cart link
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[13px]">
              {cart.link}
            </code>
            <CopyButton value={cart.link} ariaLabel="Copy the cart link" />
          </div>
          <p className="text-[13px] text-muted-foreground">
            Opens the same cart with the shopper’s name and phone filled in. Every visit counts as a
            click, yours too.
          </p>
        </section>

        {editable && cart.status === 'open' && (
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button variant="outline" onClick={() => onStop(cart)}>
              <X aria-hidden /> Stop reminders
            </Button>
            {canRemindNow(cart) ? (
              <Button loading={busy} onClick={() => onRemind(cart)}>
                <Send aria-hidden /> Send reminder now
              </Button>
            ) : (
              <span className="self-center text-[13px] text-muted-foreground">
                Three reminders were sent by hand already.
              </span>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
