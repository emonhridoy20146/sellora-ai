'use client';

import { RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { OrderSmsEvent, SmsSettings } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import {
  ORDER_EVENT_LABEL,
  lengthSummary,
  messageCost,
  renderSms,
  smsLength,
  unknownPlaceholders,
} from '@/lib/sms';
import { cn } from '@/lib/utils';
import { useSmsSettingsPatch } from './data';

type Draft = Record<OrderSmsEvent, { enabled: boolean; text: string }>;

function draftOf(s: SmsSettings): Draft {
  return Object.fromEntries(
    s.orderTemplates.map((t) => [t.event, { enabled: t.enabled, text: t.text }]),
  ) as Draft;
}

/** The order messages: which ones go out, and their words, with a live preview and cost. */
export function TemplatesCard({ s, editable }: { s: SmsSettings; editable: boolean }) {
  const { org } = useOrg();
  const patch = useSmsSettingsPatch(org.id);
  const [draft, setDraft] = useState<Draft>(() => draftOf(s));
  const [shopName, setShopName] = useState(s.shopName);
  const [contactPhone, setContactPhone] = useState(s.contactPhone);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState(false);
  const [resetLanguage, setResetLanguage] = useState(s.language);
  const saved = useMemo(() => draftOf(s), [s]);

  const changedEvents = s.orderTemplates
    .map((t) => t.event)
    .filter((e) => draft[e].enabled !== saved[e].enabled || draft[e].text.trim() !== saved[e].text);
  const dirty =
    changedEvents.length > 0 ||
    shopName.trim() !== s.shopName ||
    contactPhone.trim() !== s.contactPhone;

  // The preview uses this form's shop name and phone, not only the saved ones.
  const samples = {
    ...s.samples,
    shop: shopName.trim() || s.defaults.shopName,
    phone: contactPhone.trim() || s.samples.phone || '',
  };
  const perPart = s.route.ready
    ? s.route.pricePerPartMinor
    : (s.sellora.price?.perPartMinor ?? null);
  const currency = s.route.ready ? s.route.currency : (s.sellora.price?.currency ?? 'BDT');
  const priced = s.mode === 'sellora' || (s.mode === 'off' && !s.own);

  const save = () => {
    setErrors({});
    patch.mutate(
      {
        ...(shopName.trim() !== s.shopName ? { shopName: shopName.trim() } : {}),
        ...(contactPhone.trim() !== s.contactPhone ? { contactPhone: contactPhone.trim() } : {}),
        ...(changedEvents.length
          ? { orderTemplates: Object.fromEntries(changedEvents.map((e) => [e, draft[e]])) }
          : {}),
      },
      {
        onSuccess: (next) => {
          setDraft(draftOf(next));
          toast.success('Order messages saved.');
        },
        onError: (err) => {
          if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
          else toast.error(errorMessage(err));
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Order messages</CardTitle>
          <CardDescription>
            Sent once per order and step. Placeholders in braces are filled for each order.
          </CardDescription>
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Language of the default texts"
              value={s.language}
              onChange={(v) => {
                setResetLanguage(v);
                setResetting(true);
              }}
              options={[
                { value: 'en', label: 'English' },
                { value: 'bn', label: 'বাংলা' },
              ]}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setResetLanguage(s.language);
                setResetting(true);
              }}
            >
              <RotateCcw aria-hidden /> Default texts
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Shop name in messages"
            htmlFor="sms-shop"
            error={errors.shopName}
            hint={`{shop}. Empty uses “${s.defaults.shopName}”. Short names keep messages in one part.`}
          >
            <Input
              id="sms-shop"
              value={shopName}
              maxLength={40}
              disabled={!editable}
              placeholder={s.defaults.shopName}
              onChange={(e) => setShopName(e.target.value)}
            />
          </Field>
          <Field
            label="Phone in messages"
            htmlFor="sms-phone"
            error={errors.contactPhone}
            hint={`{phone}. Empty uses your business phone${s.defaults.contactPhone ? ` (${s.defaults.contactPhone})` : ''}.`}
          >
            <Input
              id="sms-phone"
              value={contactPhone}
              maxLength={20}
              inputMode="tel"
              disabled={!editable}
              onChange={(e) => setContactPhone(e.target.value)}
            />
          </Field>
        </div>

        <ul className="grid gap-3">
          {s.orderTemplates.map((t) => (
            <TemplateRow
              key={t.event}
              event={t.event}
              placeholders={t.placeholders}
              value={draft[t.event]}
              samples={samples}
              maxChars={s.maxTemplateChars}
              maxParts={s.maxParts}
              perPart={priced ? perPart : null}
              currency={currency}
              error={errors[`orderTemplates.${t.event}.text`]}
              editable={editable}
              onChange={(v) => setDraft((d) => ({ ...d, [t.event]: v }))}
            />
          ))}
        </ul>

        {editable && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            {dirty && <span className="text-[13px] text-muted-foreground">Unsaved changes</span>}
            <Button
              variant="outline"
              disabled={!dirty || patch.isPending}
              onClick={() => {
                setDraft(saved);
                setShopName(s.shopName);
                setContactPhone(s.contactPhone);
                setErrors({});
              }}
            >
              Undo
            </Button>
            <Button onClick={save} disabled={!dirty} loading={patch.isPending}>
              Save messages
            </Button>
          </div>
        )}
      </CardContent>

      <ResetDialog
        key={String(resetting)}
        open={resetting}
        onOpenChange={setResetting}
        initial={resetLanguage}
        onDone={(next) => {
          setDraft(draftOf(next));
        }}
      />
    </Card>
  );
}

function TemplateRow({
  event,
  placeholders,
  value,
  samples,
  maxChars,
  maxParts,
  perPart,
  currency,
  error,
  editable,
  onChange,
}: {
  event: OrderSmsEvent;
  placeholders: { key: string; label: string }[];
  value: { enabled: boolean; text: string };
  samples: Record<string, string>;
  maxChars: number;
  maxParts: number;
  perPart: number | null;
  currency: string;
  error?: string;
  editable: boolean;
  onChange: (v: { enabled: boolean; text: string }) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const label = ORDER_EVENT_LABEL[event]!;
  const preview = renderSms(value.text, samples);
  const length = smsLength(preview);
  const unknown = unknownPlaceholders(
    value.text,
    placeholders.map((p) => p.key),
  );
  const cost = messageCost(length.parts, perPart);
  const id = `sms-t-${event}`;
  const problem =
    error ??
    (unknown.length
      ? `This message cannot use ${unknown.map((u) => `{${u}}`).join(', ')}`
      : length.parts > maxParts
        ? `About ${length.parts} parts with real values; the most is ${maxParts}.`
        : value.enabled && !value.text.trim()
          ? 'Write the message or turn it off'
          : undefined);

  const insert = (key: string) => {
    const el = ref.current;
    const token = `{${key}}`;
    if (!el) return onChange({ ...value, text: `${value.text}${token}` });
    const start = el.selectionStart ?? value.text.length;
    const end = el.selectionEnd ?? start;
    const text = value.text.slice(0, start) + token + value.text.slice(end);
    onChange({ ...value, text });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <li className={cn('rounded-lg border p-4', !value.enabled && 'bg-muted/40')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{label.title}</p>
          <p className="text-[13px] text-muted-foreground">{label.when}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={value.enabled}
            disabled={!editable}
            aria-label={`Send “${label.title}”`}
            onCheckedChange={(enabled) => onChange({ ...value, enabled })}
          />
          {value.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="grid gap-2">
          <label htmlFor={id} className="sr-only">
            {label.title} text
          </label>
          <Textarea
            id={id}
            ref={ref}
            rows={3}
            value={value.text}
            maxLength={maxChars}
            disabled={!editable}
            aria-invalid={Boolean(problem)}
            aria-describedby={`${id}-meta`}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
          {editable && (
            <div className="flex flex-wrap gap-1.5" aria-label="Insert a placeholder">
              {placeholders.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  title={p.label}
                  onClick={() => insert(p.key)}
                  className="rounded-md border bg-card px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {`{${p.key}}`}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid content-start gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Preview
          </p>
          <div className="max-w-sm rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm whitespace-pre-wrap">
            {preview || <span className="text-muted-foreground">Nothing to send</span>}
          </div>
          <p
            id={`${id}-meta`}
            className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
          >
            <span>{lengthSummary(length)}</span>
            {cost !== null && length.parts > 0 && (
              <Badge tone="outline">{formatMoney(cost, currency)} per message</Badge>
            )}
          </p>
          {problem && (
            <p role="alert" className="text-[13px] text-destructive">
              {problem}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function ResetDialog({
  open,
  onOpenChange,
  initial,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: 'en' | 'bn';
  onDone: (s: SmsSettings) => void;
}) {
  const { org } = useOrg();
  const [language, setLanguage] = useState<'en' | 'bn'>(initial);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Put the default texts back?"
      description="Your own wording for every order message is replaced. Which messages are on stays as it is."
      confirmLabel="Use default texts"
      onConfirm={async () => {
        const next = await api<SmsSettings>(`/orgs/${org.id}/sms/templates/reset`, {
          body: { language },
        });
        onDone(next);
        toast.success(language === 'bn' ? 'বাংলা টেক্সট বসানো হয়েছে।' : 'English texts restored.');
      }}
    >
      <div className="grid gap-2">
        <Segmented
          label="Language"
          value={language}
          onChange={setLanguage}
          options={[
            { value: 'en', label: 'English' },
            { value: 'bn', label: 'বাংলা' },
          ]}
        />
        <Alert tone="info">
          {language === 'bn'
            ? 'Bangla messages use Unicode: 70 characters per SMS instead of 160, so most take two parts.'
            : 'English messages fit 160 characters per SMS part.'}
        </Alert>
      </div>
    </ConfirmDialog>
  );
}
