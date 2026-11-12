'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Coupon, CouponKind, CouponLandingScope, CouponList } from '@/lib/api/types';
import {
  COUPON_KIND_LABEL,
  couponChanges,
  couponFormToBody,
  couponToForm,
  emptyCouponForm,
  type CouponForm,
} from '@/lib/coupons';
import { normalizeCouponCode } from '@/lib/landing';
import { couponKeys } from './hooks';

/**
 * Makes or changes a coupon. A coupon orders already used keeps its code readable on those
 * orders, so the API refuses to delete it; it can still be changed or switched off.
 */
export function CouponDialog({
  orgId,
  currency,
  coupon,
  pages,
  open,
  onOpenChange,
}: {
  orgId: string;
  currency: string;
  /** The coupon to change; null makes a new one. */
  coupon: Coupon | null;
  pages: CouponList['landingPages'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CouponForm>(() =>
    coupon ? couponToForm(coupon, currency) : emptyCouponForm(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<CouponForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    const { body, errors: problems } = couponFormToBody(form, currency, {
      savedEndsAt: coupon?.endsAt ?? null,
    });
    setErrors(problems);
    if (!body) return;
    setBusy(true);
    try {
      if (coupon) {
        const changes = couponChanges(coupon, body);
        if (Object.keys(changes).length > 0)
          await api<Coupon>(`/orgs/${orgId}/coupons/${coupon.id}`, {
            method: 'PATCH',
            body: changes,
          });
      } else await api<Coupon>(`/orgs/${orgId}/coupons`, { body });
      await queryClient.invalidateQueries({ queryKey: couponKeys.all(orgId) });
      toast.success(coupon ? 'Coupon saved.' : `Coupon ${body.code} is ready.`);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      else setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const money = `(${currency})`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title={coupon ? `Change ${coupon.code}` : 'New coupon'}
        description="Shoppers type the code at the store checkout or in a landing page’s order form. Sellora works out the discount; the shopper’s browser never does."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Code"
            htmlFor="cp-code"
            error={errors.code}
            hint="3 to 20 letters and numbers, such as EID20. Upper and lower case are the same."
          >
            <Input
              id="cp-code"
              value={form.code}
              maxLength={20}
              autoComplete="off"
              className="font-mono uppercase"
              onChange={(e) => set({ code: e.target.value })}
              onBlur={() => set({ code: normalizeCouponCode(form.code) })}
            />
          </Field>
          <Field
            label="Note for your team"
            htmlFor="cp-note"
            optional
            hint="Shoppers do not see it."
            error={errors.note}
          >
            <Input
              id="cp-note"
              value={form.note}
              maxLength={120}
              onChange={(e) => set({ note: e.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3">
          <span className="text-sm font-medium">What it gives</span>
          <Segmented<CouponKind>
            label="What it gives"
            value={form.kind}
            onChange={(kind) => set({ kind })}
            options={(Object.keys(COUPON_KIND_LABEL) as CouponKind[]).map((k) => ({
              value: k,
              label: COUPON_KIND_LABEL[k],
            }))}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            {form.kind === 'percent' && (
              <>
                <Field label="Percent off" htmlFor="cp-percent" error={errors.percent}>
                  <Input
                    id="cp-percent"
                    inputMode="numeric"
                    value={form.percent}
                    onChange={(e) => set({ percent: e.target.value })}
                  />
                </Field>
                <Field
                  label={`Most it takes off ${money}`}
                  htmlFor="cp-cap"
                  optional
                  error={errors.maxDiscountMinor}
                >
                  <Input
                    id="cp-cap"
                    inputMode="decimal"
                    value={form.maxDiscount}
                    onChange={(e) => set({ maxDiscount: e.target.value })}
                  />
                </Field>
              </>
            )}
            {form.kind === 'amount' && (
              <Field label={`Amount off ${money}`} htmlFor="cp-amount" error={errors.amountMinor}>
                <Input
                  id="cp-amount"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                />
              </Field>
            )}
            <Field
              label={`Smallest order ${money}`}
              htmlFor="cp-min"
              optional
              error={errors.minOrderMinor}
              hint="Items only, before delivery."
            >
              <Input
                id="cp-min"
                inputMode="decimal"
                value={form.minOrder}
                onChange={(e) => set({ minOrder: e.target.value })}
              />
            </Field>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Starts"
            htmlFor="cp-start"
            optional
            error={errors.startsAt}
            hint="Empty: right away."
          >
            <Input
              id="cp-start"
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => set({ startsAt: e.target.value })}
            />
          </Field>
          <Field
            label="Ends"
            htmlFor="cp-end"
            optional
            error={errors.endsAt}
            hint="Empty: until you switch it off."
          >
            <Input
              id="cp-end"
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => set({ endsAt: e.target.value })}
            />
          </Field>
          <Field
            label="Uses in total"
            htmlFor="cp-limit"
            optional
            error={errors.usageLimit}
            hint={
              coupon ? `Used ${coupon.used} times so far. Empty: no limit.` : 'Empty: no limit.'
            }
          >
            <Input
              id="cp-limit"
              inputMode="numeric"
              value={form.usageLimit}
              onChange={(e) => set({ usageLimit: e.target.value })}
            />
          </Field>
          <Field
            label="Uses per customer"
            htmlFor="cp-per"
            optional
            error={errors.perCustomerLimit}
            hint="Counted by phone number. Empty: no limit."
          >
            <Input
              id="cp-per"
              inputMode="numeric"
              value={form.perCustomerLimit}
              onChange={(e) => set({ perCustomerLimit: e.target.value })}
            />
          </Field>
        </div>

        <fieldset className="grid gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Where it works</legend>
          <label className="flex items-center gap-3 text-sm">
            <Switch checked={form.store} onCheckedChange={(store) => set({ store })} />
            Online store checkout
          </label>
          <Field label="Landing pages" htmlFor="cp-landing" error={errors.store}>
            <NativeSelect
              id="cp-landing"
              className="w-full sm:w-72"
              value={form.landing}
              onChange={(e) => set({ landing: e.target.value as CouponLandingScope })}
            >
              <option value="all">All landing pages</option>
              <option value="chosen">Only the pages I choose</option>
              <option value="none">No landing pages</option>
            </NativeSelect>
          </Field>
          {form.landing === 'chosen' && (
            <div className="grid gap-2">
              {pages.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">You have no landing pages yet.</p>
              ) : (
                <ul className="grid max-h-48 gap-2 overflow-y-auto" aria-label="Landing pages">
                  {pages.map((p) => {
                    const checked = form.landingPageIds.includes(p.id);
                    return (
                      <li key={p.id}>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(on) =>
                              set({
                                landingPageIds: on
                                  ? [...form.landingPageIds, p.id]
                                  : form.landingPageIds.filter((x) => x !== p.id),
                              })
                            }
                          />
                          <span className="min-w-0 truncate">{p.name}</span>
                          <span className="truncate text-xs text-muted-foreground">/{p.slug}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {errors.landingPageIds && (
                <p role="alert" className="text-[13px] text-destructive">
                  {errors.landingPageIds}
                </p>
              )}
            </div>
          )}
        </fieldset>

        <label className="flex items-center gap-3 text-sm">
          <Switch checked={form.active} onCheckedChange={(active) => set({ active })} />
          On: shoppers can use it
        </label>

        {errors.form && (
          <p role="alert" className="text-sm text-destructive">
            {errors.form}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {coupon ? 'Save coupon' : 'Create coupon'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
