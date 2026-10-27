'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { commerceKeys, useShopSettings } from '@/components/commerce/hooks';
import { MoneyInput } from '@/components/commerce/money-input';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { ShopSettings } from '@/lib/api/types';
import { minorToInput, parseMoney } from '@/lib/format';

interface ZoneDraft {
  id?: string;
  name: string;
  charge: string;
}

function SellingForm({ settings }: { settings: ShopSettings }) {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const editable = can('org.settings.manage');
  const currency = org.currency;
  const [zones, setZones] = useState<ZoneDraft[]>(
    settings.deliveryZones.map((z) => ({
      id: z.id,
      name: z.name,
      charge: minorToInput(z.chargeMinor, currency),
    })),
  );
  const [defaultIndex, setDefaultIndex] = useState(
    Math.max(
      0,
      settings.deliveryZones.findIndex((z) => z.id === settings.defaultZoneId),
    ),
  );
  const [invoiceNote, setInvoiceNote] = useState(settings.invoiceNote);
  const [threshold, setThreshold] = useState(String(settings.lowStockThreshold));
  const [autoConfirm, setAutoConfirm] = useState(settings.autoConfirmManualOrders);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const charges = zones.map((z) => parseMoney(z.charge || '0', currency));
  const thresholdN = /^\d{1,6}$/.test(threshold.trim()) ? Number(threshold.trim()) : null;
  const invalid =
    zones.some((z) => !z.name.trim()) || charges.some((c) => c === null) || thresholdN === null;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return setError('Check the highlighted fields.');
        setBusy(true);
        setError(null);
        // New zones get their id here so the default can be sent in the same request.
        const withIds = zones.map((z) => ({ ...z, id: z.id ?? crypto.randomUUID().slice(0, 8) }));
        api<ShopSettings>(`/orgs/${org.id}/shop-settings`, {
          method: 'PATCH',
          body: {
            deliveryZones: withIds.map((z, i) => ({
              id: z.id,
              name: z.name.trim(),
              chargeMinor: charges[i]!,
            })),
            defaultZoneId: withIds[defaultIndex]?.id ?? null,
            invoiceNote,
            lowStockThreshold: thresholdN,
            autoConfirmManualOrders: autoConfirm,
          },
        })
          .then((saved) => {
            queryClient.setQueryData(commerceKeys.settings(org.id), saved);
            setZones(
              saved.deliveryZones.map((z) => ({
                id: z.id,
                name: z.name,
                charge: minorToInput(z.chargeMinor, currency),
              })),
            );
            toast.success('Saved.');
          })
          .catch((err: unknown) => setError(errorMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      <fieldset disabled={!editable || busy} className="grid gap-6">
        {!editable && (
          <Alert tone="info">Only the owner and admins can change these settings.</Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Card>
          <CardHeader>
            <CardTitle>Delivery charges</CardTitle>
            <CardDescription>
              Zones you pick from when creating an order, for example Inside Dhaka and Outside
              Dhaka. The default zone is chosen for new orders.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {zones.length === 0 && (
              <p className="text-sm text-muted-foreground">No delivery zones yet.</p>
            )}
            {zones.map((z, i) => (
              <div
                key={z.id ?? `new-${i}`}
                className="grid items-start gap-3 sm:grid-cols-[1fr_160px_auto_auto]"
              >
                <Field
                  label="Zone"
                  htmlFor={`z${i}-name`}
                  error={!z.name.trim() ? 'Name the zone' : undefined}
                >
                  <Input
                    id={`z${i}-name`}
                    value={z.name}
                    maxLength={60}
                    onChange={(e) =>
                      setZones((list) =>
                        list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                </Field>
                <Field
                  label="Charge"
                  htmlFor={`z${i}-charge`}
                  error={charges[i] === null ? 'Enter an amount' : undefined}
                >
                  <MoneyInput
                    id={`z${i}-charge`}
                    currency={currency}
                    value={z.charge}
                    onChange={(e) =>
                      setZones((list) =>
                        list.map((x, j) => (j === i ? { ...x, charge: e.target.value } : x)),
                      )
                    }
                  />
                </Field>
                <label className="flex h-9 items-center gap-2 text-sm sm:mt-6">
                  <input
                    type="radio"
                    name="default-zone"
                    checked={defaultIndex === i}
                    onChange={() => setDefaultIndex(i)}
                    className="accent-primary"
                  />
                  Default
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="sm:mt-6"
                  aria-label={`Remove ${z.name || 'zone'}`}
                  onClick={() => {
                    setZones((list) => list.filter((_, j) => j !== i));
                    setDefaultIndex((d) => (d === i ? 0 : d > i ? d - 1 : d));
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {zones.length < 30 && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setZones((list) => [...list, { name: '', charge: '' }])}
                >
                  <Plus /> Add zone
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Orders and stock</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={autoConfirm} onCheckedChange={setAutoConfirm} className="mt-0.5" />
              <span>
                Confirm manual orders straight away
                <span className="block text-muted-foreground">
                  Turn off if you call customers to confirm first. Pending orders do not take stock.
                </span>
              </span>
            </label>
            <Field
              label="Low stock warning at"
              htmlFor="low-stock"
              hint="Products with this many or fewer left are marked as running low."
              error={thresholdN === null ? 'Enter a whole number' : undefined}
              className="max-w-48"
            >
              <Input
                id="low-stock"
                inputMode="numeric"
                className="tabular"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invoice</CardTitle>
          </CardHeader>
          <CardContent>
            <Field
              label="Note at the bottom of invoices"
              htmlFor="invoice-note"
              optional
              hint="Return policy, thank-you message or payment details."
            >
              <Textarea
                id="invoice-note"
                value={invoiceNote}
                maxLength={1000}
                onChange={(e) => setInvoiceNote(e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        {editable && (
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

export default function SellingSettingsPage() {
  const { org } = useOrg();
  const settings = useShopSettings(org.id);
  if (settings.isPending) return <Skeleton className="h-96" />;
  if (settings.isError)
    return <PageError error={settings.error} onRetry={() => void settings.refetch()} />;
  return <SellingForm settings={settings.data} />;
}
