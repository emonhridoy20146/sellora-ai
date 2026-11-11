'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PasswordInput } from '@/components/auth/password-input';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { cleanPublicId, publicIdError } from '@/lib/ad-tracking';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  AdDestination,
  AdPlatformDescriptor,
  AdPurchaseWhen,
  AdTrackingSites,
} from '@/lib/api/types';

export const adTrackingKeys = {
  all: (orgId: string) => ['org', orgId, 'ad-tracking'] as const,
  events: (orgId: string, destinationId: string) =>
    ['org', orgId, 'ad-tracking', 'events', destinationId] as const,
};

/** Adds a pixel or tag of the business's own, or changes one. */
export function DestinationDialog({
  open,
  onOpenChange,
  descriptor,
  destination,
  sites,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  descriptor: AdPlatformDescriptor;
  destination?: AdDestination;
  sites: AdTrackingSites;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        title={destination ? `${destination.name}` : `Add ${descriptor.name}`}
        description={
          destination
            ? `${descriptor.publicIdLabel} ${destination.publicId}. Leave the key empty to keep the saved one.`
            : descriptor.key === 'meta'
              ? 'Your own pixel from Meta Events Manager. With the access token, Sellora checks it with Meta before saving.'
              : `Your own ${descriptor.name} from your ${descriptor.key === 'tiktok' ? 'TikTok Ads' : 'Google'} account.`
        }
      >
        {/* Mounted per opening, so the form starts from the saved values each time. */}
        {open && (
          <DestinationForm
            descriptor={descriptor}
            destination={destination}
            sites={sites}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DestinationForm({
  descriptor: d,
  destination,
  sites,
  onDone,
}: {
  descriptor: AdPlatformDescriptor;
  destination?: AdDestination;
  sites: AdTrackingSites;
  onDone: () => void;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState(destination?.name ?? '');
  const [publicId, setPublicId] = useState('');
  const [label, setLabel] = useState(destination?.conversionLabel ?? '');
  const [secret, setSecret] = useState('');
  const [dropSecret, setDropSecret] = useState(false);
  const [testCode, setTestCode] = useState(destination?.testCode ?? '');
  const [everywhere, setEverywhere] = useState(destination?.everywhere ?? true);
  const [storeIds, setStoreIds] = useState<string[]>(destination?.storeIds ?? []);
  const [pageIds, setPageIds] = useState<string[]>(destination?.landingPageIds ?? []);
  const [purchaseWhen, setPurchaseWhen] = useState<AdPurchaseWhen>(
    destination?.purchaseWhen ?? 'placed',
  );
  const [chatOrders, setChatOrders] = useState(destination?.chatOrders ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const willHaveSecret = dropSecret
    ? false
    : Boolean(secret.trim()) || Boolean(destination?.hasSecret);
  const local: Record<string, string> = {};
  if (!destination) {
    const e = publicIdError(d, publicId);
    if (e) local.publicId = e;
  }
  if (!everywhere && storeIds.length + pageIds.length === 0)
    local.where = 'Choose at least one store or landing page';
  if (purchaseWhen === 'delivered' && !willHaveSecret && d.secretLabel)
    local.purchaseWhen = `Counting purchases on delivery needs the ${d.secretLabel}`;
  if (chatOrders && !willHaveSecret)
    local.chatOrders = `Orders from the inbox need the ${d.secretLabel}`;

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const scope = {
        everywhere,
        storeIds: everywhere ? [] : storeIds,
        landingPageIds: everywhere ? [] : pageIds,
      };
      const common = {
        ...scope,
        purchaseWhen: d.secretLabel ? purchaseWhen : 'placed',
        ...(d.chatOrders ? { chatOrders } : {}),
        ...(d.testCodeLabel ? { testCode: testCode.trim() } : {}),
        ...(d.conversionLabel ? { conversionLabel: label.trim() } : {}),
      };
      if (destination)
        return api<AdDestination>(`/orgs/${org.id}/ad-tracking/destinations/${destination.id}`, {
          method: 'PATCH',
          body: {
            ...common,
            ...(name.trim() && name.trim() !== destination.name ? { name: name.trim() } : {}),
            ...(dropSecret ? { secret: '' } : secret.trim() ? { secret: secret.trim() } : {}),
          },
        });
      return api<AdDestination>(`/orgs/${org.id}/ad-tracking/destinations`, {
        body: {
          platform: d.key,
          publicId: cleanPublicId(d, publicId),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
          ...common,
        },
      });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: adTrackingKeys.all(org.id) });
      toast.success(
        `${saved.name} ${destination ? 'saved' : 'added'}. ${saved.lastCheck.summary}`.trim(),
      );
      onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      else setErrors({ _: errorMessage(err) });
    },
  });

  const shown = { ...local, ...errors };
  const [submitted, setSubmitted] = useState(false);
  const visible = submitted ? shown : errors;
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  return (
    <form
      className="grid gap-4"
      noValidate
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        setErrors({});
        if (Object.keys(local).length === 0) save.mutate();
      }}
    >
      {visible._ && <Alert tone="danger">{visible._}</Alert>}
      {!destination && (
        <Field
          label={d.publicIdLabel}
          htmlFor="ad-public-id"
          error={visible.publicId}
          hint={d.publicIdHint}
        >
          <Input
            id="ad-public-id"
            value={publicId}
            spellCheck={false}
            inputMode={d.key === 'meta' ? 'numeric' : undefined}
            placeholder={
              d.key === 'meta'
                ? '1234567890123456'
                : d.key === 'tiktok'
                  ? 'C4A1B2C3D4E5F6G7H8I9'
                  : d.key === 'ga4'
                    ? 'G-XXXXXXXXXX'
                    : 'AW-123456789'
            }
            aria-invalid={Boolean(visible.publicId) || undefined}
            onChange={(e) => setPublicId(e.target.value)}
          />
        </Field>
      )}
      {d.conversionLabel && (
        <Field
          label="Purchase conversion label"
          htmlFor="ad-label"
          optional
          error={visible.conversionLabel}
          hint="Goals › Conversions › your purchase action › Tag setup: the part after the slash in send_to. Without it the tag loads but purchases are not counted."
        >
          <Input
            id="ad-label"
            value={label}
            spellCheck={false}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
      )}
      <Field label="Name" htmlFor="ad-name" optional hint="Only you see it, to tell ids apart.">
        <Input
          id="ad-name"
          value={name}
          maxLength={80}
          placeholder={destination ? undefined : `${d.name} for my store`}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {d.secretLabel && (
        <Field
          label={d.secretLabel}
          htmlFor="ad-secret"
          optional
          error={visible.secret}
          hint={d.secretHint}
        >
          <div className="grid gap-2">
            <PasswordInput
              id="ad-secret"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              disabled={dropSecret}
              placeholder={
                destination?.hasSecret
                  ? `Saved (${destination.secretHint ?? 'hidden'}); type to replace`
                  : undefined
              }
              onChange={(e) => setSecret(e.target.value)}
            />
            {destination?.hasSecret && (
              <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Checkbox checked={dropSecret} onCheckedChange={(v) => setDropSecret(v === true)} />
                Remove the saved key (the browser tag keeps running)
              </label>
            )}
          </div>
        </Field>
      )}
      {d.testCodeLabel && (
        <Field
          label={d.testCodeLabel}
          htmlFor="ad-test-code"
          optional
          error={visible.testCode}
          hint="From Events Manager › Test events. Only the Send test event button uses it, so tests never count as shoppers."
        >
          <Input
            id="ad-test-code"
            value={testCode}
            spellCheck={false}
            className="max-w-48"
            onChange={(e) => setTestCode(e.target.value)}
          />
        </Field>
      )}

      <fieldset className="grid gap-3 rounded-lg border p-3.5">
        <legend className="px-1 text-sm font-medium">Where it loads</legend>
        <label className="flex items-start justify-between gap-4 text-sm">
          <span>
            <span className="font-medium">Everywhere</span>
            <span className="block text-muted-foreground">
              Your store and every landing page, including ones you make later.
            </span>
          </span>
          <Switch checked={everywhere} onCheckedChange={setEverywhere} aria-label="Everywhere" />
        </label>
        {!everywhere && (
          <div className="grid gap-3 text-sm">
            {sites.stores.length > 0 && (
              <div className="grid gap-1.5">
                <span className="text-[13px] text-muted-foreground">Store</span>
                {sites.stores.map((s) => (
                  <label key={s.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={storeIds.includes(s.id)}
                      onCheckedChange={(v) => setStoreIds((l) => toggle(l, s.id, v === true))}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
            {sites.landingPages.length > 0 && (
              <div className="grid gap-1.5">
                <span className="text-[13px] text-muted-foreground">Landing pages</span>
                <div className="grid max-h-44 gap-1.5 overflow-y-auto">
                  {sites.landingPages.map((p) => (
                    <label key={p.id} className="flex items-center gap-2">
                      <Checkbox
                        checked={pageIds.includes(p.id)}
                        onCheckedChange={(v) => setPageIds((l) => toggle(l, p.id, v === true))}
                      />
                      <span className="min-w-0 truncate">
                        {p.name} <span className="text-muted-foreground">/{p.slug}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {visible.where && (
              <span role="alert" className="text-[13px] text-destructive">
                {visible.where}
              </span>
            )}
          </div>
        )}
      </fieldset>

      {d.key !== 'google_ads' && (
        <fieldset className="grid gap-3 rounded-lg border p-3.5">
          <legend className="px-1 text-sm font-medium">When a purchase counts</legend>
          <Segmented
            label="When a purchase counts"
            value={purchaseWhen}
            onChange={setPurchaseWhen}
            options={[
              { value: 'placed', label: 'When the order is placed' },
              { value: 'delivered', label: 'When it is delivered' },
            ]}
          />
          <p className="text-[13px] text-muted-foreground">
            {purchaseWhen === 'placed'
              ? 'The usual choice: the ad platform learns at once. Cash on delivery orders that are cancelled or returned are not taken back, except by Analytics, which gets a refund.'
              : 'Only orders the courier delivered count, so your ads learn from shoppers who really paid. The platform hears days later, from the server only.'}
          </p>
          {visible.purchaseWhen && (
            <span role="alert" className="text-[13px] text-destructive">
              {visible.purchaseWhen}
            </span>
          )}
          {d.chatOrders && (
            <label className="flex items-start justify-between gap-4 border-t pt-3 text-sm">
              <span>
                <span className="font-medium">Also send inbox and hand-made orders</span>
                <span className="block text-muted-foreground">
                  Orders from Messenger, WhatsApp or Instagram chats go to {d.name} as
                  {d.key === 'meta' ? ' chat purchases' : ' purchases'}, from the server.
                </span>
                {visible.chatOrders && (
                  <span role="alert" className="block text-[13px] text-destructive">
                    {visible.chatOrders}
                  </span>
                )}
              </span>
              <Switch
                checked={chatOrders}
                onCheckedChange={setChatOrders}
                aria-label="Also send inbox and hand-made orders"
              />
            </label>
          )}
        </fieldset>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {d.key === 'meta' && (secret.trim() || !destination) ? 'Check and save' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
