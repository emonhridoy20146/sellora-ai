'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Campaign, CampaignOptions, LinkInput, SmsMessage } from '@/lib/api/types';
import {
  audienceProblem,
  canSendNow,
  composeMarketing,
  dayInZone,
  estimateLine,
  linkPreviewUrl,
  marketingTextProblem,
  scheduleProblem,
  textLanguage,
  zonedToUtc,
} from '@/lib/campaigns';
import { hourLabel } from '@/lib/carts';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { smsLength } from '@/lib/sms';
import {
  AudienceBuilder,
  audienceDraftOf,
  audienceOf,
  type AudienceDraft,
} from './audience-builder';
import { campaignKeys, useAudienceCount } from './data';
import { LinkPicker, type LinkDraft } from './link-picker';
import { MessageEditor } from './message-editor';

interface Draft {
  name: string;
  text: string;
  audience: AudienceDraft;
  link: LinkDraft;
}

const linkDraftOf = (c: Campaign | undefined): LinkDraft =>
  c
    ? {
        kind: c.link.kind,
        ...(c.link.storeId ? { storeId: c.link.storeId } : {}),
        ...(c.link.targetId ? { targetId: c.link.targetId } : {}),
        label: c.link.label,
      }
    : { kind: 'none', label: null };

function draftOf(c: Campaign | undefined, currency: string): Draft {
  return {
    name: c?.name ?? '',
    text: c?.text ?? '',
    audience: audienceDraftOf(c?.audience ?? { ordered: 'ordered' }, currency),
    link: linkDraftOf(c),
  };
}

const linkInput = (l: LinkDraft): LinkInput => ({
  kind: l.kind,
  ...(l.storeId ? { storeId: l.storeId } : {}),
  ...(l.targetId ? { targetId: l.targetId } : {}),
});

const sameLink = (a: LinkDraft, b: LinkDraft) =>
  a.kind === b.kind &&
  (a.storeId ?? '') === (b.storeId ?? '') &&
  (a.targetId ?? '') === (b.targetId ?? '');

/** Quarter hours inside the sending window, as "HH:MM". */
function slots(window: { startHour: number; endHour: number }): string[] {
  const out: string[] = [];
  for (let h = window.startHour; h < window.endHour; h += 1)
    for (const m of [0, 15, 30, 45])
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  return out;
}
const slotLabel = (slot: string) => {
  const [h, m] = slot.split(':').map(Number) as [number, number];
  return hourLabel(h).replace(' ', m ? `:${String(m).padStart(2, '0')} ` : ' ');
};

/**
 * A draft (or scheduled) campaign: its name, who gets it, where the link goes and the text,
 * then a test text and "send now" or "send at". Everything is checked again by the API.
 */
export function CampaignEditor({
  campaign,
  options,
  editable,
}: {
  campaign?: Campaign;
  options: CampaignOptions;
  editable: boolean;
}) {
  const { org, can } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const currency = options.currency;
  const saved = useMemo(() => draftOf(campaign, currency), [campaign, currency]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'start' | 'delete' | 'cancel'>(null);
  const [testTo, setTestTo] = useState('');
  const [mode, setMode] = useState<'now' | 'later'>(campaign?.scheduledAt ? 'later' : 'now');
  const tz = options.timezone;
  const window = options.sendWindow;
  const times = useMemo(() => slots(window), [window]);
  const initialAt = campaign?.scheduledAt ? new Date(campaign.scheduledAt) : null;
  const [day, setDay] = useState(() =>
    dayInZone(initialAt ?? new Date(Date.now() + 24 * 3600_000), tz),
  );
  const [time, setTime] = useState(() => {
    if (!initialAt) return '10:00';
    const hm = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(initialAt);
    return times.includes(hm) ? hm : '10:00';
  });
  const [confirm, setConfirm] = useState<null | 'start' | 'delete' | 'cancel'>(null);
  // Campaigns can be scheduled up to 59 days ahead (the API allows 60).
  const [dayRange] = useState(() => ({
    min: dayInZone(new Date(), tz),
    max: dayInZone(new Date(Date.now() + 59 * 24 * 3600_000), tz),
  }));

  const { audience, problem: numberProblem } = audienceOf(draft.audience, currency);
  const audienceIssue = numberProblem ?? audienceProblem(audience);
  const debounced = useDebounced(audience, 400);
  const count = useAudienceCount(org.id, debounced, !audienceIssue);
  const recipients = count.data?.recipients ?? 0;

  const language = textLanguage(draft.text);
  const savedUrl = campaign && sameLink(draft.link, saved.link) ? campaign.link.url : null;
  const values = {
    name: options.sampleNames[language],
    shop: options.shopName,
    link: linkPreviewUrl(draft.link, options, savedUrl),
  };
  const composed = composeMarketing(draft.text, values, language, options.stopSuffix[language]);
  const parts = smsLength(draft.text.trim() ? composed : '').parts;
  const placeholderKeys = options.placeholders.map((p) => p.key);
  const textIssue = (required: boolean) =>
    marketingTextProblem(draft.text, {
      placeholders: placeholderKeys,
      maxChars: options.maxChars,
      maxParts: options.maxParts,
      composed,
      link: draft.link.kind,
      required,
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
    !campaign ||
    draft.name.trim() !== saved.name ||
    draft.text.trim() !== saved.text.trim() ||
    JSON.stringify(audience) !== JSON.stringify(audienceOf(saved.audience, currency).audience) ||
    !sameLink(draft.link, saved.link);

  const sms = options.sms;
  const perPart = sms.ready ? sms.pricePerPartMinor : null;
  const total = perPart !== null ? recipients * Math.max(1, parts) * perPart : null;
  const cash = options.wallet.cashMinor;
  const shortOfCash = total !== null && total > 0 && cash < total;
  const nowOk = canSendNow(tz, window);
  const at = zonedToUtc(day, Number(time.slice(0, 2)), Number(time.slice(3)), tz);
  const atIssue = mode === 'later' ? scheduleProblem(at, tz, window) : null;
  const sendIssue =
    textIssue(true) ??
    linkIssue ??
    audienceIssue ??
    (!sms.ready
      ? sms.message
      : recipients === 0
        ? 'No customer matches who you chose.'
        : shortOfCash
          ? 'Top up your wallet first.'
          : mode === 'now' && !nowOk
            ? `Texts go out ${hourLabel(window.startHour)}–${hourLabel(window.endHour)}. Schedule it for a time in those hours.`
            : atIssue);

  const set = (v: Partial<Draft>) => setDraft((d) => ({ ...d, ...v }));

  const body = () => ({
    name: draft.name.trim() || 'New campaign',
    text: draft.text.trim(),
    audience,
    link: linkInput(draft.link),
  });

  /** Saves the draft and returns it (created the first time). */
  const save = async (quiet = false): Promise<Campaign | null> => {
    setErrors({});
    try {
      const next = campaign
        ? await api<Campaign>(`/orgs/${org.id}/campaigns/${campaign.id}`, {
            method: 'PATCH',
            body: body(),
          })
        : await api<Campaign>(`/orgs/${org.id}/campaigns`, { body: body() });
      qc.setQueryData(campaignKeys.one(org.id, next.id), next);
      void qc.invalidateQueries({ queryKey: campaignKeys.lists(org.id) });
      if (!quiet) toast.success('Draft saved.');
      if (!campaign) router.replace(`/app/${org.id}/marketing/campaigns/${next.id}`);
      return next;
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      else toast.error(errorMessage(err));
      return null;
    }
  };

  const onSave = () => {
    setBusy('save');
    void save().finally(() => setBusy(null));
  };

  const sendTest = async () => {
    setBusy('test');
    try {
      const c = dirty ? await save(true) : campaign!;
      if (!c) return;
      const m = await api<SmsMessage>(`/orgs/${org.id}/campaigns/${c.id}/test`, {
        body: { to: testTo.trim() },
      });
      void qc.invalidateQueries({ queryKey: campaignKeys.one(org.id, c.id) });
      if (m.status === 'failed') toast.error(m.error ?? 'The test text could not be sent.');
      else toast.success(`Test text sent to ${testTo.trim()}.`);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      else toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy('start');
    try {
      const c = dirty ? await save(true) : campaign!;
      if (!c) throw new Error('not saved');
      const next = await api<Campaign>(`/orgs/${org.id}/campaigns/${c.id}/start`, {
        body: mode === 'later' ? { at: at.toISOString() } : {},
      });
      qc.setQueryData(campaignKeys.one(org.id, next.id), next);
      void qc.invalidateQueries({ queryKey: campaignKeys.lists(org.id) });
      void qc.invalidateQueries({ queryKey: campaignKeys.options(org.id) });
      toast.success(
        next.status === 'scheduled'
          ? `Scheduled for ${formatDateTime(next.scheduledAt, tz)}.`
          : 'Sending. Texts go out in batches over the next minutes.',
      );
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      else if (!(err instanceof Error && err.message === 'not saved'))
        toast.error(errorMessage(err));
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!campaign) return;
    try {
      await api(`/orgs/${org.id}/campaigns/${campaign.id}`, { method: 'DELETE' });
      void qc.invalidateQueries({ queryKey: campaignKeys.lists(org.id) });
      toast.success('Draft deleted.');
      router.push(`/app/${org.id}/marketing/campaigns`);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const cancel = async () => {
    if (!campaign) return;
    try {
      const next = await api<Campaign>(`/orgs/${org.id}/campaigns/${campaign.id}/cancel`, {
        body: {},
      });
      qc.setQueryData(campaignKeys.one(org.id, next.id), next);
      void qc.invalidateQueries({ queryKey: campaignKeys.lists(org.id) });
      toast.success('Campaign cancelled. Nobody gets it.');
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  return (
    <div className="grid gap-6">
      {campaign?.status === 'scheduled' && (
        <Alert
          tone="info"
          title={`Scheduled for ${formatDateTime(campaign.scheduledAt, tz)}`}
          action={
            editable && (
              <Button variant="outline" size="sm" onClick={() => setConfirm('cancel')}>
                Cancel campaign
              </Button>
            )
          }
        >
          It starts by itself then. You can still change it until it starts; save to keep the
          changes.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Campaign</CardTitle>
          <CardDescription>
            Only your team sees the name. It also tags the visits the link brings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field label="Name" htmlFor="campaign-name" error={errors.name} className="max-w-md">
            <Input
              id="campaign-name"
              value={draft.name}
              maxLength={80}
              placeholder="Eid collection 2026"
              disabled={!editable}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Who gets it</CardTitle>
          <CardDescription>
            Your customers, chosen by what they did. Blocked customers and numbers that asked to
            stop never get it, and each number gets the campaign once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AudienceBuilder
            value={draft.audience}
            onChange={(a) => set({ audience: a })}
            tags={options.tags}
            sources={options.sources}
            currency={currency}
            count={count.data}
            counting={count.isFetching}
            problem={audienceIssue ?? errors.audience}
            editable={editable}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The message</CardTitle>
          <CardDescription>
            {'{link}'} becomes a short link to the page you choose, so the text stays short. Clicks
            and orders after the text are counted for the campaign.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <LinkPicker
            id="campaign-link"
            orgId={org.id}
            value={draft.link}
            onChange={(link) => {
              // Picking a page for a text without {link} adds it at the end.
              const text =
                link.kind !== 'none' && draft.link.kind === 'none' && !draft.text.includes('{link}')
                  ? `${draft.text.trimEnd()}${draft.text.trim() ? ' ' : ''}{link}`
                  : draft.text;
              set({ link, text });
            }}
            options={options}
            editable={editable}
            error={errors.link ?? linkIssue}
          />
          <MessageEditor
            id="campaign-text"
            label="Text"
            value={draft.text}
            onChange={(text) => set({ text })}
            placeholders={options.placeholders}
            preview={composed}
            maxChars={options.maxChars}
            perPartMinor={perPart}
            currency={sms.ready ? sms.currency : currency}
            problem={errors.text ?? textIssue(false)}
            editable={editable}
          />
        </CardContent>
      </Card>

      {editable && (
        <Card>
          <CardHeader>
            <CardTitle>Send</CardTitle>
            <CardDescription>
              Texts go out between {hourLabel(window.startHour)} and {hourLabel(window.endHour)} (
              {tz}), in batches. Outside those hours the campaign waits for the morning.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {!sms.ready && (
              <Alert
                tone="warning"
                title="SMS is not ready"
                action={
                  can('org.integrations.manage') && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/app/${org.id}/settings/sms`}>Settings › SMS</Link>
                    </Button>
                  )
                }
              >
                {sms.message}
              </Alert>
            )}
            {sms.ready && (
              <div className="grid gap-1 text-sm" data-testid="campaign-estimate">
                {perPart && perPart > 0 ? (
                  <>
                    <p>
                      <span className="font-medium">
                        About {formatMoney(total ?? 0, sms.currency)}
                      </span>{' '}
                      <span className="text-muted-foreground">
                        ({estimateLine(recipients, parts, perPart, sms.currency)})
                      </span>
                    </p>
                    <p className="text-[13px] text-muted-foreground">
                      Paid from wallet cash: you have {formatMoney(cash, options.wallet.currency)}.
                      If cash runs out half-way, the campaign pauses and you get an email.
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    Sent through your own {sms.providerName} account; Sellora charges nothing.
                  </p>
                )}
                {options.daily.left < recipients && (
                  <p className="text-[13px] text-muted-foreground">
                    {formatNumber(options.daily.left)} of today’s{' '}
                    {formatNumber(options.daily.limit)} texts are left; the rest go out tomorrow
                    morning.
                  </p>
                )}
              </div>
            )}
            {shortOfCash && (
              <Alert
                tone="warning"
                title="Not enough wallet cash"
                action={
                  can('billing.view') && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/app/${org.id}/billing/wallet`}>Top up</Link>
                    </Button>
                  )
                }
              >
                This campaign needs about{' '}
                {formatMoney(total ?? 0, sms.ready ? sms.currency : currency)}; your wallet has{' '}
                {formatMoney(cash, options.wallet.currency)} in cash. Free credit pays for AI only.
              </Alert>
            )}

            <div className="grid gap-2 rounded-lg border p-4">
              <p className="text-sm font-medium">Send a test first</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field
                  label="Phone number"
                  htmlFor="campaign-test-to"
                  error={errors.to}
                  className="w-56"
                >
                  <Input
                    id="campaign-test-to"
                    inputMode="tel"
                    placeholder="01XXXXXXXXX"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                  />
                </Field>
                <Button
                  variant="outline"
                  onClick={() => void sendTest()}
                  loading={busy === 'test'}
                  disabled={
                    !testTo.trim() ||
                    !sms.ready ||
                    Boolean(textIssue(true) ?? linkIssue) ||
                    (campaign ? campaign.testsLeft <= 0 : false)
                  }
                >
                  <Send aria-hidden /> Send test
                </Button>
              </div>
              <p className="text-[13px] text-muted-foreground">
                {campaign ? campaign.testsLeft : options.maxTests} of {options.maxTests} tests left.
                The test uses the real short link and costs the same as one text.
              </p>
            </div>

            <div className="grid gap-3">
              <Segmented
                label="When to send"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'now', label: 'Send now' },
                  { value: 'later', label: 'Schedule' },
                ]}
              />
              {mode === 'later' && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Day" htmlFor="campaign-day">
                    <Input
                      id="campaign-day"
                      type="date"
                      value={day}
                      min={dayRange.min}
                      max={dayRange.max}
                      onChange={(e) => setDay(e.target.value)}
                    />
                  </Field>
                  <Field label="Time" htmlFor="campaign-time">
                    <NativeSelect
                      id="campaign-time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                    >
                      {times.map((s) => (
                        <option key={s} value={s}>
                          {slotLabel(s)}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <p className="pb-2 text-[13px] text-muted-foreground">{tz}</p>
                </div>
              )}
              {(sendIssue || errors.at) && (
                <p role="alert" className="text-[13px] text-destructive">
                  {errors.at ?? sendIssue}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <div>
                {campaign?.status === 'draft' && (
                  <Button variant="ghost" onClick={() => setConfirm('delete')}>
                    <Trash2 aria-hidden /> Delete draft
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {dirty && campaign && (
                  <span className="text-[13px] text-muted-foreground">Unsaved changes</span>
                )}
                <Button
                  variant="outline"
                  onClick={onSave}
                  loading={busy === 'save'}
                  disabled={!dirty || busy !== null}
                >
                  {campaign?.status === 'scheduled' ? 'Save changes' : 'Save draft'}
                </Button>
                <Button
                  onClick={() => setConfirm('start')}
                  disabled={Boolean(sendIssue) || busy !== null || count.isFetching}
                >
                  {mode === 'later' ? (
                    <>
                      <CalendarClock aria-hidden />
                      {campaign?.status === 'scheduled' ? 'Change time' : 'Schedule'}
                    </>
                  ) : (
                    <>
                      <Send aria-hidden /> Send now
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirm === 'start'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          mode === 'later'
            ? `Send to ${formatNumber(recipients)} customers on ${formatDateTime(at.toISOString(), tz)}?`
            : `Send to ${formatNumber(recipients)} customers now?`
        }
        description={
          total !== null && total > 0
            ? `About ${formatMoney(total, sms.ready ? sms.currency : currency)} from your wallet cash. Who gets it is written down when it starts.`
            : 'Who gets it is written down when it starts.'
        }
        confirmLabel={mode === 'later' ? 'Schedule' : 'Send now'}
        onConfirm={start}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        destructive
        onConfirm={remove}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this campaign?"
        description="It will not start. To send it later, duplicate it."
        confirmLabel="Cancel campaign"
        destructive
        onConfirm={cancel}
      />
    </div>
  );
}
