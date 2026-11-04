'use client';

import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MoneyInput } from '@/components/commerce/money-input';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { CartQuietHours, CartSettings, Locale } from '@/lib/api/types';
import {
  composeReminder,
  delayLabel,
  hourLabel,
  reminderProblem,
  stepOrderProblem,
} from '@/lib/carts';
import { formatMoney, minorToInput, parseMoney } from '@/lib/format';
import { lengthSummary, smsLength } from '@/lib/sms';
import { cn } from '@/lib/utils';
import { useCartSettingsPatch } from './data';

interface StepDraft {
  enabled: boolean;
  delayMinutes: number;
  text: string;
}

interface Draft {
  language: Locale;
  steps: StepDraft[];
  minTotal: string;
  quietHours: CartQuietHours;
}

function draftOf(s: CartSettings): Draft {
  return {
    language: s.language,
    steps: s.steps.map((x) => ({ enabled: x.enabled, delayMinutes: x.delayMinutes, text: x.text })),
    minTotal: s.minTotalMinor ? minorToInput(s.minTotalMinor, s.currency) : '',
    quietHours: { ...s.quietHours },
  };
}

const sameSteps = (a: StepDraft[], b: StepDraft[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.enabled === b[i]!.enabled &&
      x.delayMinutes === b[i]!.delayMinutes &&
      x.text.trim() === b[i]!.text.trim(),
  );

const STEP_TITLE = ['First reminder', 'Second reminder'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Whether reminders go out, after how long, what they say, and when they never go out (small
 * carts, quiet hours). The on/off switch saves at once; everything else saves together.
 */
export function CartSettingsCard({ s, editable }: { s: CartSettings; editable: boolean }) {
  const { org, can } = useOrg();
  const patch = useCartSettingsPatch(org.id);
  const toggle = useCartSettingsPatch(org.id);
  const [draft, setDraft] = useState<Draft>(() => draftOf(s));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saved = useMemo(() => draftOf(s), [s]);

  const minTotalMinor = draft.minTotal.trim() ? parseMoney(draft.minTotal, s.currency) : 0;
  const stepsChanged = !sameSteps(draft.steps, saved.steps);
  const changed = {
    language: draft.language !== s.language,
    steps: stepsChanged,
    minTotal: minTotalMinor !== s.minTotalMinor,
    quietHours:
      draft.quietHours.enabled !== s.quietHours.enabled ||
      draft.quietHours.startHour !== s.quietHours.startHour ||
      draft.quietHours.endHour !== s.quietHours.endHour,
  };
  const dirty = Object.values(changed).some(Boolean);

  const samples = s.samples[draft.language];
  const stop = s.stopSuffix[draft.language];
  const perPart = s.sms.ready ? s.sms.pricePerPartMinor : null;
  const priceCurrency = s.sms.ready ? s.sms.currency : s.currency;
  const placeholderKeys = s.placeholders.map((p) => p.key);
  const composed = draft.steps.map((x) => composeReminder(x.text, samples, draft.language, stop));
  const problems = draft.steps.map((x, i) =>
    reminderProblem(x, {
      placeholders: placeholderKeys,
      maxChars: s.maxChars,
      maxParts: s.maxParts,
      composed: composed[i]!,
    }),
  );
  const orderProblem = stepOrderProblem(draft.steps);
  const noneOn = !draft.steps.some((x) => x.enabled);
  const minTotalProblem = minTotalMinor === null ? 'Write an amount, like 500' : null;
  const quietProblem =
    draft.quietHours.enabled && draft.quietHours.startHour === draft.quietHours.endHour
      ? 'Quiet hours must end at another hour'
      : null;
  const blocked =
    problems.some(Boolean) ||
    Boolean(orderProblem) ||
    Boolean(minTotalProblem) ||
    Boolean(quietProblem) ||
    (s.enabled && noneOn);

  const setStep = (i: number, v: Partial<StepDraft>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((x, j) => (j === i ? { ...x, ...v } : x)) }));

  const applyDefaults = (language: Locale) =>
    setDraft((d) => ({
      ...d,
      language,
      steps: d.steps.map((x, i) => ({ ...x, text: s.defaults[language][i] ?? x.text })),
    }));

  // Texts still as Sellora wrote them follow the language; the business's own words stay.
  const setLanguage = (language: Locale) => {
    const untouched = draft.steps.every(
      (x, i) => x.text.trim() === s.defaults[draft.language][i] || !x.text.trim(),
    );
    if (untouched) applyDefaults(language);
    else setDraft((d) => ({ ...d, language }));
  };

  const save = () => {
    setErrors({});
    patch.mutate(
      {
        ...(changed.language ? { language: draft.language } : {}),
        ...(changed.steps || changed.language
          ? { steps: draft.steps.map((x) => ({ ...x, text: x.text.trim() })) }
          : {}),
        ...(changed.minTotal ? { minTotalMinor } : {}),
        ...(changed.quietHours ? { quietHours: draft.quietHours } : {}),
      },
      {
        onSuccess: (next) => {
          setDraft(draftOf(next));
          toast.success('Reminder settings saved.');
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
      { enabled },
      {
        onSuccess: () =>
          toast.success(
            enabled
              ? 'Reminders are on. Carts left from now on get a text.'
              : 'Reminders are off. Waiting carts get no more texts.',
          ),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Reminders</CardTitle>
          <CardDescription className="max-w-2xl">
            When a shopper types a phone number at checkout or on a landing page order form and
            leaves without ordering, Sellora texts them a link back to the same cart. Every reminder
            ends with a link to stop them.
          </CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch
            checked={s.enabled}
            disabled={!editable || toggle.isPending}
            aria-label="Send cart reminders"
            onCheckedChange={setEnabled}
          />
          {s.enabled ? 'On' : 'Off'}
        </label>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!s.sms.ready ? (
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
            {s.sms.message} Carts are still saved; their reminders wait until SMS works, and are
            skipped once they are more than 12 hours late.
          </Alert>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            {s.sms.pricePerPartMinor > 0
              ? `Sent with ${s.sms.providerName} for ${formatMoney(s.sms.pricePerPartMinor, s.sms.currency)} per SMS part, from your wallet cash.`
              : `Sent through your own ${s.sms.providerName} account.`}{' '}
            A number gets at most one cart reminder a day.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Language of the reminders"
            value={draft.language}
            onChange={editable ? setLanguage : () => undefined}
            options={[
              { value: 'en', label: 'English' },
              { value: 'bn', label: 'বাংলা' },
            ]}
          />
          {editable && (
            <Button variant="ghost" size="sm" onClick={() => applyDefaults(draft.language)}>
              <RotateCcw aria-hidden /> Default texts
            </Button>
          )}
        </div>

        <ul className="grid gap-3">
          {draft.steps.map((step, i) => (
            <StepRow
              key={i}
              index={i}
              step={step}
              delays={s.delays}
              placeholders={s.placeholders}
              preview={composed[i]!}
              maxChars={s.maxChars}
              perPart={perPart}
              currency={priceCurrency}
              problem={errors[`steps.${i}.text`] ?? problems[i] ?? undefined}
              delayProblem={
                errors[`steps.${i}.delayMinutes`] ??
                (i === 1 ? (orderProblem ?? undefined) : undefined)
              }
              editable={editable}
              onChange={(v) => setStep(i, v)}
            />
          ))}
        </ul>
        {(errors.steps || (s.enabled && noneOn)) && (
          <p role="alert" className="text-[13px] text-destructive">
            {errors.steps ?? 'Turn on at least one reminder, or switch reminders off above.'}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Smallest cart to remind"
            htmlFor="cart-min-total"
            error={errors.minTotalMinor ?? minTotalProblem ?? undefined}
            hint="Carts below this total get no reminder. Empty reminds every cart."
          >
            <MoneyInput
              id="cart-min-total"
              currency={s.currency}
              value={draft.minTotal}
              disabled={!editable}
              placeholder="0"
              onChange={(e) => setDraft((d) => ({ ...d, minTotal: e.target.value }))}
            />
          </Field>
          <QuietHoursField
            value={draft.quietHours}
            timezone={s.timezone}
            editable={editable}
            error={errors['quietHours.endHour'] ?? quietProblem ?? undefined}
            onChange={(quietHours) => setDraft((d) => ({ ...d, quietHours }))}
          />
        </div>

        {editable && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
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
            <Button onClick={save} disabled={!dirty || blocked} loading={patch.isPending}>
              Save reminders
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StepRow({
  index,
  step,
  delays,
  placeholders,
  preview,
  maxChars,
  perPart,
  currency,
  problem,
  delayProblem,
  editable,
  onChange,
}: {
  index: number;
  step: StepDraft;
  delays: number[];
  placeholders: { key: string; label: string }[];
  preview: string;
  maxChars: number;
  perPart: number | null;
  currency: string;
  problem?: string;
  delayProblem?: string;
  editable: boolean;
  onChange: (v: Partial<StepDraft>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const title = STEP_TITLE[index] ?? `Reminder ${index + 1}`;
  const id = `cart-step-${index + 1}`;
  const length = smsLength(step.text.trim() ? preview : '');
  const cost = perPart ? perPart * length.parts : null;

  const insert = (key: string) => {
    const el = ref.current;
    const token = `{${key}}`;
    if (!el) return onChange({ text: `${step.text}${token}` });
    const start = el.selectionStart ?? step.text.length;
    const end = el.selectionEnd ?? start;
    onChange({ text: step.text.slice(0, start) + token + step.text.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <li className={cn('rounded-lg border p-4', !step.enabled && 'bg-muted/40')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <p className="font-medium">{title}</p>
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            Sent
            <NativeSelect
              id={`${id}-delay`}
              className="h-8 w-auto"
              value={step.delayMinutes}
              disabled={!editable}
              aria-invalid={Boolean(delayProblem)}
              onChange={(e) => onChange({ delayMinutes: Number(e.target.value) })}
            >
              {delays.map((d) => (
                <option key={d} value={d}>
                  {delayLabel(d)}
                </option>
              ))}
            </NativeSelect>
            after the shopper stops
          </label>
          {delayProblem && (
            <p role="alert" className="text-[13px] text-destructive">
              {delayProblem}
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={step.enabled}
            disabled={!editable}
            aria-label={`Send the ${title.toLowerCase()}`}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
          {step.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="grid content-start gap-2">
          <label htmlFor={id} className="sr-only">
            {title} text
          </label>
          <Textarea
            id={id}
            ref={ref}
            rows={3}
            value={step.text}
            maxLength={maxChars}
            disabled={!editable}
            aria-invalid={Boolean(problem)}
            aria-describedby={`${id}-meta`}
            onChange={(e) => onChange({ text: e.target.value })}
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
          <div className="max-w-sm rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap">
            {step.text.trim() ? (
              preview
            ) : (
              <span className="text-muted-foreground">Nothing to send</span>
            )}
          </div>
          <p
            id={`${id}-meta`}
            className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
          >
            <span>{lengthSummary(length)}</span>
            {cost !== null && length.parts > 0 && (
              <Badge tone="outline">{formatMoney(cost, currency)} per reminder</Badge>
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

function QuietHoursField({
  value,
  timezone,
  editable,
  error,
  onChange,
}: {
  value: CartQuietHours;
  timezone: string;
  editable: boolean;
  error?: string;
  onChange: (v: CartQuietHours) => void;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <div className="flex items-center gap-2">
        <Switch
          id="cart-quiet"
          checked={value.enabled}
          disabled={!editable}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
        <label htmlFor="cart-quiet" className="text-sm leading-none font-medium">
          Quiet hours
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">No texts from</span>
        <NativeSelect
          aria-label="Quiet hours start"
          className="h-8 w-auto"
          value={value.startHour}
          disabled={!editable || !value.enabled}
          onChange={(e) => onChange({ ...value, startHour: Number(e.target.value) })}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </NativeSelect>
        <span className="text-muted-foreground">to</span>
        <NativeSelect
          aria-label="Quiet hours end"
          className="h-8 w-auto"
          value={value.endHour}
          disabled={!editable || !value.enabled}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange({ ...value, endHour: Number(e.target.value) })}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {value.enabled
            ? `Your time (${timezone}). A reminder due then goes out at ${hourLabel(value.endHour)}.`
            : 'Reminders go out at any hour.'}
        </p>
      )}
    </div>
  );
}
