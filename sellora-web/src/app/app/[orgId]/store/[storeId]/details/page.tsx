'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { MoneyInput } from '@/components/commerce/money-input';
import { useOrg } from '@/components/org-context';
import { HandleField } from '@/components/stores/handle-field';
import { storeKeys, useStore } from '@/components/stores/hooks';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Store, StoreLanguage } from '@/lib/api/types';
import { minorToInput, parseMoney } from '@/lib/format';

const SOCIAL = [
  { key: 'facebook', label: 'Facebook page' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'tiktok', label: 'TikTok' },
] as const;

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className={value.length > max ? 'text-destructive' : ''}>
      {value.length}/{max}
    </span>
  );
}

function DetailsForm({ store }: { store: Store }) {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const editable = can('stores.manage');
  const [name, setName] = useState(store.name);
  const [handle, setHandle] = useState(store.handle);
  const [language, setLanguage] = useState<StoreLanguage>(store.language);
  const [contact, setContact] = useState(store.contact);
  const [social, setSocial] = useState(store.social);
  const [seo, setSeo] = useState(store.seo);
  const [note, setNote] = useState(store.checkout.note);
  const [minOrder, setMinOrder] = useState(
    store.checkout.minOrderMinor ? minorToInput(store.checkout.minOrderMinor, org.currency) : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const minOrderMinor = minOrder.trim() ? parseMoney(minOrder, org.currency) : 0;

  const save = async () => {
    if (minOrderMinor === null) return setErrors({ 'checkout.minOrderMinor': 'Enter an amount' });
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const saved = await api<Store>(`/orgs/${org.id}/stores/${store.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          ...(handle.trim() !== store.handle ? { handle: handle.trim() } : {}),
          language,
          contact,
          social,
          seo,
          checkout: { note, minOrderMinor },
        },
      });
      queryClient.setQueryData(storeKeys.store(org.id, store.id), saved);
      void queryClient.invalidateQueries({ queryKey: storeKeys.all(org.id), exact: true });
      toast.success('Saved.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'handle_taken')
        setErrors({ handle: err.message });
      else if (err instanceof ApiError && err.errors.length) {
        setErrors(err.fieldErrors());
        setError('Check the highlighted fields.');
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={!editable || busy} className="grid max-w-3xl gap-6">
        {!editable && (
          <Alert tone="info">Only the owner and admins can change the store details.</Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Card>
          <CardHeader>
            <CardTitle>Store</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Field label="Store name" htmlFor="d-name" error={errors.name}>
              <Input
                id="d-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <HandleField
              orgId={org.id}
              storeId={store.id}
              value={handle}
              locked={store.handleLocked}
              error={errors.handle}
              onChange={setHandle}
            />
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Store language</span>
              <Segmented
                label="Store language"
                value={language}
                onChange={setLanguage}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'bn', label: 'বাংলা' },
                ]}
              />
              <p className="text-[13px] text-muted-foreground">
                Changes buttons, checkout and dates. Your own text stays as you wrote it.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
            <CardDescription>
              Shown in the store footer. A phone or WhatsApp number is needed before the store can
              open.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <Field label="Phone" htmlFor="d-phone" error={errors['contact.phone']}>
              <Input
                id="d-phone"
                type="tel"
                inputMode="tel"
                value={contact.phone}
                maxLength={30}
                onChange={(e) => setContact({ ...contact, phone: e.target.value })}
              />
            </Field>
            <Field
              label="WhatsApp"
              htmlFor="d-whatsapp"
              optional
              error={errors['contact.whatsapp']}
            >
              <Input
                id="d-whatsapp"
                type="tel"
                inputMode="tel"
                value={contact.whatsapp}
                maxLength={30}
                onChange={(e) => setContact({ ...contact, whatsapp: e.target.value })}
              />
            </Field>
            <Field label="Email" htmlFor="d-email" optional error={errors['contact.email']}>
              <Input
                id="d-email"
                type="email"
                value={contact.email}
                onChange={(e) => setContact({ ...contact, email: e.target.value })}
              />
            </Field>
            <Field
              label="Address"
              htmlFor="d-address"
              optional
              className="sm:col-span-2"
              error={errors['contact.address']}
            >
              <Textarea
                id="d-address"
                rows={2}
                value={contact.address}
                maxLength={300}
                onChange={(e) => setContact({ ...contact, address: e.target.value })}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Social links</CardTitle>
            <CardDescription>
              Full links starting with https://, shown in the footer.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            {SOCIAL.map((s) => (
              <Field
                key={s.key}
                label={s.label}
                htmlFor={`d-${s.key}`}
                optional
                error={errors[`social.${s.key}`]}
              >
                <Input
                  id={`d-${s.key}`}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={social[s.key]}
                  maxLength={300}
                  onChange={(e) => setSocial({ ...social, [s.key]: e.target.value })}
                />
              </Field>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Search engines</CardTitle>
            <CardDescription>
              What Google and Facebook show when someone finds or shares your store.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Field
              label="Title"
              htmlFor="d-seo-title"
              hint={<Counter value={seo.title} max={70} />}
              error={errors['seo.title']}
            >
              <Input
                id="d-seo-title"
                value={seo.title}
                maxLength={70}
                onChange={(e) => setSeo({ ...seo, title: e.target.value })}
              />
            </Field>
            <Field
              label="Description"
              htmlFor="d-seo-desc"
              optional
              hint={<Counter value={seo.description} max={170} />}
              error={errors['seo.description']}
            >
              <Textarea
                id="d-seo-desc"
                rows={3}
                value={seo.description}
                maxLength={170}
                onChange={(e) => setSeo({ ...seo, description: e.target.value })}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Checkout</CardTitle>
            <CardDescription>
              Shoppers pay cash on delivery. Delivery charges come from Settings, Selling and
              delivery.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Field
              label="Note at checkout"
              htmlFor="d-note"
              optional
              hint="For example: “We call to confirm every order before sending it.”"
              error={errors['checkout.note']}
            >
              <Textarea
                id="d-note"
                rows={2}
                value={note}
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <Field
              label="Smallest order"
              htmlFor="d-min"
              optional
              className="max-w-56"
              hint="Leave empty for no minimum."
              error={
                errors['checkout.minOrderMinor'] ??
                (minOrderMinor === null ? 'Enter an amount' : undefined)
              }
            >
              <MoneyInput
                id="d-min"
                currency={org.currency}
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        {editable && (
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>
              Save details
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

export default function StoreDetailsPage() {
  const { org } = useOrg();
  const { storeId } = useParams<{ storeId: string }>();
  const store = useStore(org.id, storeId);
  if (!store.data) return null;
  return <DetailsForm key={store.data.updatedAt} store={store.data} />;
}
