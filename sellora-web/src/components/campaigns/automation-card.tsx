'use client';

import { RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  Automation,
  AutomationKind,
  AutomationSettings,
  CampaignOptions,
  LinkInput,
} from '@/lib/api/types';
import {
  composeMarketing,
  linkPreviewUrl,
  marketingTextProblem,
  sentOf,
  textLanguage,
} from '@/lib/campaigns';
import { formatMoney, formatNumber } from '@/lib/format';
import { useAutomationsPatch } from './data';
import { LinkPicker, type LinkDraft } from './link-picker';
import { MessageEditor } from './message-editor';

export const AUTOMATION_COPY: Record<
  AutomationKind,
  { title: string; text: string; days: (n: number) => string; toastOn: string }
> = {
  after_delivery: {
    title: 'Thank you after delivery',
    text: 'A thank-you text some days after an order is marked delivered, once per order. Returned orders and blocked customers get none.',
    days: (n) => `${n} day${n === 1 ? '' : 's'} after delivery`,
    toastOn: 'On. Orders delivered from now on get a thank-you.',
  },
  win_back: {
    title: 'Bring back customers who stopped ordering',
    text: 'A text when a customer’s last order turns some days old, once for each last order. Customers who order again in between get none.',
    days: (n) => `when the last order is ${n} days old`,
    toastOn: 'On. Customers whose last order turns old from now on get a text.',
  },
};

interface Draft {
  days: number;
  text: string;
  link: LinkDraft;
}

const draftOf = (a: Automation): Draft => ({
  days: a.days,
  text: a.text,
  link: {
    kind: a.link.kind,
    ...(a.link.storeId ? { storeId: a.link.storeId } : {}),
    ...(a.link.targetId ? { targetId: a.link.targetId } : {}),
    label: a.link.label,
  },
});

const linkInput = (l: LinkDraft): LinkInput => ({
  kind: l.kind,
  ...(l.storeId ? { storeId: l.storeId } : {}),
  ...(l.targetId ? { targetId: l.targetId } : {}),
});

const sameLink = (a: LinkDraft, b: LinkDraft) =>
  a.kind === b.kind &&
  (a.storeId ?? '') === (b.storeId ?? '') &&
  (a.targetId ?? '') === (b.targetId ?? '');

/**
 * One automation: its switch (saves at once), when it goes out, where the link goes and the
 * text with a live preview, and what it did in the last 30 days.
 */
export function AutomationCard({
  kind,
  settings,
  options,
  editable,
}: {
  kind: AutomationKind;
  settings: AutomationSettings;
  options: CampaignOptions;
  editable: boolean;
}) {
  const { org } = useOrg();
  const a = settings[kind];
  const copy = AUTOMATION_COPY[kind];
  const patch = useAutomationsPatch(org.id);
  const toggle = useAutomationsPatch(org.id);
  const saved = useMemo(() => draftOf(a), [a]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const id = kind.replace('_', '-');

  const language = textLanguage(draft.text);
  const values = {
    name: options.sampleNames[language],
    shop: options.shopName,
    order: `${org.settings.orderNumberPrefix || 'SL'}-1042`,
    link: linkPreviewUrl(draft.link, options, sameLink(draft.link, saved.link) ? a.link.url : null),
  };
  const composed = composeMarketing(draft.text, values, language, options.stopSuffix[language]);
  const textIssue = marketingTextProblem(draft.text, {
    placeholders: a.placeholders.map((p) => p.key),
    maxChars: settings.maxChars,
    maxParts: settings.maxParts,
    composed,
    link: draft.link.kind,
    required: true,
  });
  const linkIssue =
    draft.link.kind === 'none'
      ? null
      : options.stores.length === 0
        ? 'Make your online store first: links go to a page of your store.'
        : draft.link.kind === 'product' && !draft.link.targetId
          ? 'Choose the product'
          : draft.link.kind === 'landing_page' && !draft.link.targetId
            ? 'Choose the landing page'
            : null;
  const dirty =
    draft.days !== saved.days ||
    draft.text.trim() !== saved.text.trim() ||
    !sameLink(draft.link, saved.link);
  const sms = settings.sms;
  const perPart = sms.ready ? sms.pricePerPartMinor : null;
  const stats = a.last30Days;
  const k = (field: string) => errors[`${kind}.${field}`];

  const save = () => {
    setErrors({});
    patch.mutate(
      {
        [kind]: {
          ...(draft.days !== saved.days ? { days: draft.days } : {}),
          ...(draft.text.trim() !== saved.text.trim() ? { text: draft.text.trim() } : {}),
          ...(!sameLink(draft.link, saved.link) ? { link: linkInput(draft.link) } : {}),
        },
      },
      {
        onSuccess: (next) => {
          setDraft(draftOf(next[kind]));
          toast.success(`${copy.title}: saved.`);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
          else toast.error(errorMessage(err));
        },
      },
    );
  };

  const setEnabled = (enabled: boolean) =>
    toggle.mutate(
      { [kind]: { enabled } },
      {
        onSuccess: () =>
          toast.success(
            enabled ? copy.toastOn : 'Off. Planned texts that are not sent yet are skipped.',
          ),
        onError: (err) => {
          if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
          toast.error(errorMessage(err));
        },
      },
    );

  return (
    <Card data-testid={`automation-${id}`}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription className="max-w-2xl">{copy.text}</CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch
            checked={a.enabled}
            disabled={!editable || toggle.isPending || (!a.enabled && dirty)}
            aria-label={`Send “${copy.title}”`}
            onCheckedChange={setEnabled}
          />
          {a.enabled ? 'On' : 'Off'}
        </label>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!a.enabled && dirty && editable && (
          <p className="text-[13px] text-muted-foreground">Save your changes, then switch it on.</p>
        )}
        {a.link.problem && (
          <Alert tone="warning" title="The link does not work now">
            {a.link.problem} Texts that fall due while it is broken are skipped. Choose another
            page, or put this one back online.
          </Alert>
        )}
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Sent</span>
          <NativeSelect
            id={`${id}-days`}
            className="h-8 w-auto"
            value={draft.days}
            disabled={!editable}
            aria-invalid={Boolean(k('days'))}
            onChange={(e) => setDraft((d) => ({ ...d, days: Number(e.target.value) }))}
          >
            {a.dayChoices.map((n) => (
              <option key={n} value={n}>
                {copy.days(n)}
              </option>
            ))}
          </NativeSelect>
          {k('days') && (
            <span role="alert" className="text-[13px] text-destructive">
              {k('days')}
            </span>
          )}
        </label>
        <LinkPicker
          id={`${id}-link`}
          orgId={org.id}
          value={draft.link}
          onChange={(link) => {
            const text =
              link.kind !== 'none' && draft.link.kind === 'none' && !draft.text.includes('{link}')
                ? `${draft.text.trimEnd()}${draft.text.trim() ? ' ' : ''}{link}`
                : draft.text;
            setDraft((d) => ({ ...d, link, text }));
          }}
          options={options}
          editable={editable}
          error={k('link') ?? linkIssue}
        />
        <MessageEditor
          id={`${id}-text`}
          label="Text"
          value={draft.text}
          onChange={(text) => setDraft((d) => ({ ...d, text }))}
          placeholders={a.placeholders}
          preview={composed}
          maxChars={settings.maxChars}
          perPartMinor={perPart}
          currency={sms.ready ? sms.currency : options.currency}
          problem={k('text') ?? textIssue}
          editable={editable}
          rows={3}
        />

        <dl
          className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-4"
          data-testid={`automation-${id}-stats`}
        >
          <div>
            <dt className="text-[13px] text-muted-foreground">Sent, 30 days</dt>
            <dd className="font-semibold">{formatNumber(stats.sent)}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted-foreground">Waiting</dt>
            <dd className="font-semibold">{formatNumber(stats.planned)}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted-foreground">Orders after</dt>
            <dd className="font-semibold">
              {formatNumber(stats.orders.count)}
              <span className="ml-1 font-normal text-muted-foreground">
                {formatMoney(stats.orders.revenueMinor, options.currency)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted-foreground">SMS cost</dt>
            <dd className="font-semibold">
              {formatMoney(stats.messages.spentMinor, sms.ready ? sms.currency : options.currency)}
              <span className="ml-1 font-normal text-muted-foreground">
                {formatNumber(sentOf(stats.messages.byStatus))} texts
              </span>
            </dd>
          </div>
        </dl>

        {editable && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={draft.text.trim() === a.defaultText}
              onClick={() => setDraft((d) => ({ ...d, text: a.defaultText }))}
            >
              <RotateCcw aria-hidden /> Default text
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {dirty && <span className="text-[13px] text-muted-foreground">Unsaved changes</span>}
              <Button
                variant="outline"
                disabled={!dirty || patch.isPending}
                onClick={() => {
                  setDraft(saved);
                  setErrors({});
                }}
              >
                Undo
              </Button>
              <Button
                onClick={save}
                disabled={!dirty || Boolean(textIssue ?? linkIssue)}
                loading={patch.isPending}
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
