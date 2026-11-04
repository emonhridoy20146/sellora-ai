'use client';

import { Users } from 'lucide-react';
import { MoneyInput } from '@/components/commerce/money-input';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import type { AudienceCount, CampaignAudience } from '@/lib/api/types';
import { SOURCE_LABEL } from '@/lib/campaigns';
import { formatNumber, minorToInput, parseMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/** The audience as the inputs hold it (numbers as typed). */
export interface AudienceDraft {
  ordered: CampaignAudience['ordered'];
  minOrders: string;
  minSpent: string;
  orderedWithinDays: string;
  noOrderForDays: string;
  tags: string[];
  sources: string[];
}

export function audienceDraftOf(a: CampaignAudience, currency: string): AudienceDraft {
  return {
    ordered: a.ordered,
    minOrders: a.minOrders ? String(a.minOrders) : '',
    minSpent: a.minSpentMinor ? minorToInput(a.minSpentMinor, currency) : '',
    orderedWithinDays: a.orderedWithinDays ? String(a.orderedWithinDays) : '',
    noOrderForDays: a.noOrderForDays ? String(a.noOrderForDays) : '',
    tags: a.tags ?? [],
    sources: a.sources ?? [],
  };
}

const whole = (s: string) => {
  const n = Number(s.trim());
  return s.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The audience to send, or the field that is not a number yet. */
export function audienceOf(
  d: AudienceDraft,
  currency: string,
): { audience: CampaignAudience; problem: string | null } {
  const audience: CampaignAudience = { ordered: d.ordered };
  let problem: string | null = null;
  const num = (raw: string, key: 'minOrders' | 'orderedWithinDays' | 'noOrderForDays') => {
    if (!raw.trim()) return;
    const n = whole(raw);
    if (n === undefined) problem = 'Write whole numbers, like 30';
    else audience[key] = n;
  };
  num(d.minOrders, 'minOrders');
  num(d.orderedWithinDays, 'orderedWithinDays');
  num(d.noOrderForDays, 'noOrderForDays');
  if (d.minSpent.trim()) {
    const m = parseMoney(d.minSpent, currency);
    if (m === null) problem = 'Write an amount, like 500';
    else if (m > 0) audience.minSpentMinor = m;
  }
  if (d.tags.length) audience.tags = d.tags;
  if (d.sources.length) audience.sources = d.sources;
  return { audience, problem };
}

function Chip({
  pressed,
  onClick,
  disabled,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[13px] transition-colors disabled:opacity-60',
        pressed
          ? 'border-primary bg-info-soft text-primary'
          : 'bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Who gets the text: customers chosen by what they did, and the live count. */
export function AudienceBuilder({
  value,
  onChange,
  tags,
  sources,
  currency,
  count,
  counting,
  problem,
  editable,
}: {
  value: AudienceDraft;
  onChange: (v: AudienceDraft) => void;
  tags: string[];
  sources: string[];
  currency: string;
  count: AudienceCount | undefined;
  counting: boolean;
  problem?: string | null;
  editable: boolean;
}) {
  const set = (v: Partial<AudienceDraft>) => onChange({ ...value, ...v });
  const toggle = (list: string[], item: string) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  return (
    <div className="grid gap-5">
      <Segmented
        label="Which customers"
        value={value.ordered}
        onChange={(ordered) => editable && set({ ordered })}
        options={[
          { value: 'any', label: 'Everyone with a phone' },
          { value: 'ordered', label: 'Ordered before' },
          { value: 'delivered', label: 'Got a delivery' },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="At least this many orders" htmlFor="aud-min-orders" optional>
          <Input
            id="aud-min-orders"
            inputMode="numeric"
            placeholder="Any"
            value={value.minOrders}
            disabled={!editable}
            onChange={(e) => set({ minOrders: e.target.value })}
          />
        </Field>
        <Field label="Spent at least" htmlFor="aud-min-spent" optional>
          <MoneyInput
            id="aud-min-spent"
            currency={currency}
            placeholder="Any"
            value={value.minSpent}
            disabled={!editable}
            onChange={(e) => set({ minSpent: e.target.value })}
          />
        </Field>
        <Field label="Ordered in the last (days)" htmlFor="aud-within" optional>
          <Input
            id="aud-within"
            inputMode="numeric"
            placeholder="Any time"
            value={value.orderedWithinDays}
            disabled={!editable}
            onChange={(e) => set({ orderedWithinDays: e.target.value })}
          />
        </Field>
        <Field
          label="No order for (days)"
          htmlFor="aud-lapsed"
          optional
          hint="For customers who stopped ordering."
        >
          <Input
            id="aud-lapsed"
            inputMode="numeric"
            placeholder="Any"
            value={value.noOrderForDays}
            disabled={!editable}
            onChange={(e) => set({ noOrderForDays: e.target.value })}
          />
        </Field>
      </div>
      {tags.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">
            Tagged <span className="font-normal text-muted-foreground">(any of these)</span>
          </p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Customer tags">
            {tags.map((t) => (
              <Chip
                key={t}
                pressed={value.tags.includes(t)}
                disabled={!editable}
                onClick={() => set({ tags: toggle(value.tags, t) })}
              >
                {t}
              </Chip>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-2">
        <p className="text-sm font-medium">
          Came from <span className="font-normal text-muted-foreground">(any of these)</span>
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Where customers came from">
          {sources.map((s) => (
            <Chip
              key={s}
              pressed={value.sources.includes(s)}
              disabled={!editable}
              onClick={() => set({ sources: toggle(value.sources, s) })}
            >
              {SOURCE_LABEL[s] ?? s}
            </Chip>
          ))}
        </div>
      </div>
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-4 py-3 text-sm"
        aria-live="polite"
        data-testid="audience-count"
      >
        <Users className="size-4 text-muted-foreground" aria-hidden />
        {problem ? (
          <span className="text-destructive">{problem}</span>
        ) : !count ? (
          <span className="text-muted-foreground">Counting…</span>
        ) : (
          <>
            <span className={cn(counting && 'opacity-60')}>
              <span className="font-semibold">{formatNumber(count.recipients)}</span> get the text
            </span>
            <span className="text-muted-foreground">
              {formatNumber(count.customers)} customers match
              {count.optedOut > 0 && ` · ${formatNumber(count.optedOut)} asked to stop`}
              {count.unreachable > 0 &&
                ` · ${formatNumber(count.unreachable)} numbers SMS cannot reach`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
