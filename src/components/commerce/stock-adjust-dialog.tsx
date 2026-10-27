'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Product, Variant } from '@/lib/api/types';

type Mode = 'add' | 'remove' | 'set';

/** Receive goods, write off damage, or correct a count. Every change lands in stock history. */
export function StockAdjustDialog({
  orgId,
  product,
  variant,
  onOpenChange,
  onSaved,
}: {
  orgId: string;
  product: Product;
  variant: Variant | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (p: Product) => void;
}) {
  const [mode, setMode] = useState<Mode>('add');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<'received' | 'damaged' | 'adjustment'>('received');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = /^\d{1,7}$/.test(qty.trim()) ? Number(qty.trim()) : null;
  const current = variant?.stock ?? 0;
  const after =
    n === null ? null : mode === 'add' ? current + n : mode === 'remove' ? current - n : n;
  const invalid = n === null || (mode !== 'set' && n === 0) || (after !== null && after < 0);

  const reset = () => {
    setMode('add');
    setQty('');
    setReason('received');
    setNote('');
    setError(null);
  };

  return (
    <Dialog
      open={variant !== null}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      {variant && (
        <DialogContent
          title="Change stock"
          description={`${product.name}${variant.title !== 'Default' ? ` (${variant.title})` : ''}: ${current} in stock now.`}
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (invalid || n === null) return;
              setBusy(true);
              setError(null);
              api<Product>(`/orgs/${orgId}/products/${product.id}/stock`, {
                body: {
                  variantId: variant.id,
                  mode: mode === 'set' ? 'set' : 'add',
                  quantity: mode === 'remove' ? -n : n,
                  reason: mode === 'set' ? 'adjustment' : reason,
                  ...(note.trim() ? { note: note.trim() } : {}),
                },
              })
                .then((p) => {
                  onSaved(p);
                  reset();
                  onOpenChange(false);
                })
                .catch((err: unknown) => setError(errorMessage(err)))
                .finally(() => setBusy(false));
            }}
          >
            <Segmented<Mode>
              label="Kind of change"
              value={mode}
              onChange={(m) => {
                setMode(m);
                setReason(m === 'add' ? 'received' : m === 'remove' ? 'damaged' : 'adjustment');
              }}
              options={[
                { value: 'add', label: 'Add' },
                { value: 'remove', label: 'Remove' },
                { value: 'set', label: 'Set count' },
              ]}
            />
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={mode === 'set' ? 'New count' : 'Quantity'}
                htmlFor="adj-qty"
                hint={after !== null && after >= 0 ? `Stock after: ${after}` : undefined}
                error={after !== null && after < 0 ? `Only ${current} in stock` : undefined}
              >
                <Input
                  id="adj-qty"
                  inputMode="numeric"
                  autoFocus
                  className="tabular"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
              </Field>
              {mode !== 'set' && (
                <Field label="Reason" htmlFor="adj-reason">
                  <NativeSelect
                    id="adj-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value as typeof reason)}
                  >
                    {mode === 'add' ? (
                      <>
                        <option value="received">Goods received</option>
                        <option value="adjustment">Count correction</option>
                      </>
                    ) : (
                      <>
                        <option value="damaged">Damaged or lost</option>
                        <option value="adjustment">Count correction</option>
                      </>
                    )}
                  </NativeSelect>
                </Field>
              )}
            </div>
            <Field label="Note" htmlFor="adj-note" optional>
              <Input
                id="adj-note"
                maxLength={300}
                placeholder="Supplier invoice 1182"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={invalid}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
