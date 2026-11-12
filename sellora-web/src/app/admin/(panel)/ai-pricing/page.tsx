'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Pencil, Plus, Tags } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TIER_LABEL } from '@/components/billing/labels';
import { usePlatform } from '@/components/platform-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { AiModel, ModelPurpose, ModelTier, PlatformCreditRate } from '@/lib/api/types';
import {
  estimateCall,
  tierEconomics,
  voiceEconomics,
  type RateDraft,
} from '@/lib/credit-economics';
import {
  formatCredits,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  minorToInput,
  parseMoney,
} from '@/lib/format';
import { cn } from '@/lib/utils';

const TIERS: ModelTier[] = ['fast', 'standard', 'advanced'];
/** A typical sales reply (prompt with history and catalogue context, short answer) for the estimate. */
const SAMPLE = { input: 3_000, output: 400 };

export default function AiPricingPage() {
  const { can } = usePlatform();
  const manage = can('platform.billing.manage');
  const rates = useQuery({
    queryKey: ['platform', 'credit-rates'],
    queryFn: () => api<PlatformCreditRate[]>('/platform/billing/credit-rates'),
  });
  const models = useQuery({
    queryKey: ['platform', 'ai-models'],
    queryFn: () => api<AiModel[]>('/platform/billing/ai-models'),
  });
  const currencies = useMemo(
    () => [...new Set(rates.data?.map((r) => r.currency) ?? [])],
    [rates.data],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const currency = picked ?? currencies[0] ?? null;
  const history = rates.data?.filter((r) => r.currency === currency) ?? [];
  // "Now" is when the list was fetched, so the current version does not shift between renders.
  const now = rates.dataUpdatedAt;
  const current = history.find((r) => new Date(r.effectiveFrom).getTime() <= now) ?? null;
  const scheduled = history.filter((r) => new Date(r.effectiveFrom).getTime() > now);
  const [publishing, setPublishing] = useState(false);
  const [editingModel, setEditingModel] = useState<AiModel | 'new' | null>(null);

  return (
    <>
      <PageHeader
        title="AI credits & models"
        description="The credit price merchants pay and the provider models behind each tier. Merchants never see provider costs."
        actions={
          <>
            {currencies.length > 1 && (
              <Segmented
                label="Currency"
                value={currency ?? ''}
                onChange={setPicked}
                options={currencies.map((c) => ({ value: c, label: c }))}
              />
            )}
            {manage && (
              <Button onClick={() => setPublishing(true)}>
                <Tags /> Publish new price
              </Button>
            )}
          </>
        }
      />

      {rates.isPending ? (
        <Skeleton className="h-64" />
      ) : rates.isError ? (
        <ErrorState error={rates.error} onRetry={() => void rates.refetch()} />
      ) : !current ? (
        <Card>
          <EmptyState icon={Tags} title="No credit price yet">
            Publish a price list before any business can use AI features.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-6">
          {scheduled.length > 0 && (
            <Alert tone="info">
              {scheduled.length === 1 ? 'Version' : 'Versions'}{' '}
              {scheduled.map((s) => `v${s.version}`).join(', ')}{' '}
              {scheduled.length === 1 ? 'takes' : 'take'} effect on{' '}
              {formatDateTime(scheduled.at(-1)!.effectiveFrom)}.
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Price of 1 credit"
              value={formatMoney(current.creditPriceMinor, current.currency)}
              sub={`Version ${current.version}`}
            />
            <Stat
              label="Minimum per AI request"
              value={formatCredits(current.minimumCreditsPerRequest)}
              sub={
                current.transcriptionCreditsPerMinute === null
                  ? 'No voice note price: voice notes stay audio only'
                  : `Voice notes: ${formatCredits(current.transcriptionCreditsPerMinute)} per minute`
              }
            />
            <Stat
              label="Exchange rate used"
              value={`${formatNumber(current.usdRate, { digits: 4 })} ${current.currency}`}
              sub={
                current.keywordLookupCredits === null
                  ? 'per 1 USD. No keyword price: ideas show without volumes'
                  : `per 1 USD. Keyword volumes: ${formatCredits(current.keywordLookupCredits)} per lookup`
              }
            />
            <Stat
              label="In effect since"
              value={formatDateTime(inEffectSince(current))}
              className="[&>p:nth-child(2)]:text-base"
            />
          </div>
          <EconomicsCard
            rate={{ ...current }}
            models={models.data ?? []}
            modelsLoading={models.isPending}
          />
          <Card>
            <CardHeader>
              <CardTitle>Price history</CardTitle>
              <CardDescription>
                Every AI call records the version it was billed with.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Version</TH>
                    <TH>From</TH>
                    <TH className="text-right">Credit price</TH>
                    {TIERS.map((t) => (
                      <TH key={t} className="text-right">
                        {TIER_LABEL[t].name} in / out per 1K
                      </TH>
                    ))}
                    <TH className="text-right">Voice / min</TH>
                    <TH className="text-right">Keyword lookup</TH>
                    <TH className="text-right">USD rate</TH>
                    <TH>Note</TH>
                  </TR>
                </THead>
                <TBody>
                  {history.map((r) => {
                    const future = new Date(r.effectiveFrom).getTime() > now;
                    return (
                      <TR key={r.id}>
                        <TD>
                          <span className="inline-flex items-center gap-1.5">
                            v{r.version}
                            {r.id === current.id && <Badge tone="success">Current</Badge>}
                            {future && <Badge tone="info">Scheduled</Badge>}
                          </span>
                        </TD>
                        <TD className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(inEffectSince(r))}
                        </TD>
                        <TD className="tabular text-right">
                          {formatMoney(r.creditPriceMinor, r.currency)}
                        </TD>
                        {TIERS.map((t) => {
                          const x = r.tiers.find((y) => y.tier === t);
                          return (
                            <TD key={t} className="tabular text-right whitespace-nowrap">
                              {x
                                ? `${formatNumber(x.inputCreditsPer1k)} / ${formatNumber(x.outputCreditsPer1k)}`
                                : '–'}
                            </TD>
                          );
                        })}
                        <TD className="tabular text-right">
                          {r.transcriptionCreditsPerMinute === null
                            ? '–'
                            : formatNumber(r.transcriptionCreditsPerMinute)}
                        </TD>
                        <TD className="tabular text-right">
                          {r.keywordLookupCredits === null
                            ? '–'
                            : formatNumber(r.keywordLookupCredits)}
                        </TD>
                        <TD className="tabular text-right">
                          {formatNumber(r.usdRate, { digits: 4 })}
                        </TD>
                        <TD
                          className="max-w-56 truncate text-muted-foreground"
                          title={r.note ?? undefined}
                        >
                          {r.note ?? '–'}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="mt-6">
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Provider models</CardTitle>
            <CardDescription>
              Prices are what the provider charges per million tokens, or per minute for
              speech-to-text. The AI agent uses the default model of each tier; voice notes use the
              default speech-to-text model.
            </CardDescription>
          </div>
          {manage && (
            <Button variant="outline" size="sm" onClick={() => setEditingModel('new')}>
              <Plus /> Add model
            </Button>
          )}
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {models.isPending ? (
            <Skeleton className="m-5 h-32" />
          ) : models.isError ? (
            <ErrorState error={models.error} onRetry={() => void models.refetch()} />
          ) : models.data.length === 0 ? (
            <EmptyState icon={Cpu} title="No models yet">
              Add at least one model per tier.
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Model</TH>
                  <TH>Used for</TH>
                  <TH className="text-right">Input $/M</TH>
                  <TH className="text-right">Cached $/M</TH>
                  <TH className="text-right">Output $/M</TH>
                  <TH className="text-right">Context</TH>
                  <TH>State</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {models.data.map((m) => (
                  <TR key={m.id}>
                    <TD>
                      <span className="block font-medium">{m.label}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {m.provider} · {m.model}
                      </span>
                    </TD>
                    {m.purpose === 'transcription' ? (
                      <>
                        <TD>Voice notes</TD>
                        <TD colSpan={4} className="tabular text-right">
                          {usd(m.audioUsdPerMinute ?? 0)} per minute of audio
                        </TD>
                      </>
                    ) : (
                      <>
                        <TD>{TIER_LABEL[m.tier].name}</TD>
                        <TD className="tabular text-right">{usd(m.inputUsdPerMTok)}</TD>
                        <TD className="tabular text-right">
                          {usd(m.cachedInputUsdPerMTok)}
                          <span className="block text-xs text-muted-foreground">
                            write {usd(m.cacheWriteUsdPerMTok ?? m.inputUsdPerMTok * 1.25)}
                          </span>
                        </TD>
                        <TD className="tabular text-right">{usd(m.outputUsdPerMTok)}</TD>
                        <TD className="tabular text-right">
                          {formatNumber(m.contextWindow, { compact: true })}
                          {m.longContext && (
                            <span className="block text-xs text-muted-foreground">
                              over {formatNumber(m.longContext.thresholdTokens, { compact: true })}:{' '}
                              {usd(m.longContext.inputUsdPerMTok)} /{' '}
                              {usd(m.longContext.outputUsdPerMTok)}
                            </span>
                          )}
                        </TD>
                      </>
                    )}
                    <TD>
                      <span className="inline-flex flex-wrap gap-1">
                        {m.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                        {m.isDefaultForTier && <Badge tone="info">Default</Badge>}
                        {m.imageInput && <Badge>Sees photos</Badge>}
                      </span>
                    </TD>
                    <TD className="text-right">
                      {manage && (
                        <Button variant="ghost" size="sm" onClick={() => setEditingModel(m)}>
                          <Pencil /> Edit
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {publishing && (
        <PublishRateDialog
          base={current}
          defaultCurrency={currency}
          models={models.data ?? []}
          onClose={() => setPublishing(false)}
        />
      )}
      {editingModel && (
        <ModelDialog
          model={editingModel === 'new' ? null : editingModel}
          onClose={() => setEditingModel(null)}
        />
      )}
    </>
  );
}

/** A version cannot apply before it was published, even when its start date is earlier. */
function inEffectSince(r: PlatformCreditRate): string {
  return new Date(r.effectiveFrom) > new Date(r.createdAt) ? r.effectiveFrom : r.createdAt;
}

function usd(n: number): string {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(n);
}

function marginTone(pct: number | null): string {
  if (pct === null) return 'text-muted-foreground';
  if (pct < 0) return 'text-destructive font-medium';
  if (pct < 20) return 'text-warning font-medium';
  return '';
}

function EconomicsCard({
  rate,
  models,
  modelsLoading,
  title = 'Margin by tier',
}: {
  rate: RateDraft;
  models: AiModel[];
  modelsLoading?: boolean;
  title?: string;
}) {
  const rows = tierEconomics(rate, models);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          Per million tokens, against the most expensive enabled model in each tier. An estimate:
          real profit is in the profit report.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {modelsLoading ? (
          <Skeleton className="m-5 h-24" />
        ) : (
          <>
            <EconomicsTable rate={rate} rows={rows} />
            <VoiceMargin rate={rate} models={models} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One line under the tier table: what a minute of voice note earns. */
function VoiceMargin({ rate, models }: { rate: RateDraft; models: AiModel[] }) {
  const v = voiceEconomics(rate, models);
  const m = (n: number | null) => (n === null ? '–' : formatMoney(Math.round(n), rate.currency));
  return (
    <p className="border-t px-5 py-3 text-sm">
      <span className="font-medium">Voice notes to text: </span>
      {v ? (
        <>
          merchant pays {m(v.pricePerMinuteMinor)} per minute, provider cost{' '}
          {m(v.costPerMinuteMinor)}
          {v.model ? ` (${v.model.label})` : ' (no enabled speech-to-text model)'}, margin{' '}
          <span className={marginTone(v.marginPct)}>{formatPercent(v.marginPct, 0)}</span>.
        </>
      ) : (
        <span className="text-muted-foreground">
          no price in this list, so voice notes stay audio only.
        </span>
      )}
    </p>
  );
}

function EconomicsTable({
  rate,
  rows,
}: {
  rate: RateDraft;
  rows: ReturnType<typeof tierEconomics>;
}) {
  const m = (n: number | null) => (n === null ? '–' : formatMoney(Math.round(n), rate.currency));
  return (
    <Table>
      <THead>
        <TR>
          <TH>Tier</TH>
          <TH className="text-right">Merchant pays (in / out)</TH>
          <TH className="text-right">Provider cost (in / out)</TH>
          <TH className="text-right">Margin (in / out)</TH>
          <TH className="text-right">
            Sample reply
            <span className="block text-[11px] font-normal">
              {formatNumber(SAMPLE.input)} in + {formatNumber(SAMPLE.output)} out
            </span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => {
          const est = estimateCall(rate, r.tier, SAMPLE.input, SAMPLE.output);
          return (
            <TR key={r.tier}>
              <TD>
                <span className="block font-medium">{TIER_LABEL[r.tier].name}</span>
                <span className="text-xs text-muted-foreground">
                  {r.model ? r.model.label : 'No enabled model'}
                </span>
              </TD>
              <TD className="tabular text-right whitespace-nowrap">
                {m(r.priceInputPerMMinor)} / {m(r.priceOutputPerMMinor)}
              </TD>
              <TD className="tabular text-right whitespace-nowrap">
                {m(r.costInputPerMMinor)} / {m(r.costOutputPerMMinor)}
              </TD>
              <TD className="tabular text-right whitespace-nowrap">
                <span className={marginTone(r.marginInputPct)}>
                  {formatPercent(r.marginInputPct, 0)}
                </span>{' '}
                /{' '}
                <span className={marginTone(r.marginOutputPct)}>
                  {formatPercent(r.marginOutputPct, 0)}
                </span>
              </TD>
              <TD className="tabular text-right whitespace-nowrap">
                {est ? (
                  <>
                    {formatMoney(est.chargeMinor, rate.currency)}
                    <span className="block text-xs text-muted-foreground">
                      {formatNumber(est.credits)} credits
                    </span>
                  </>
                ) : (
                  '–'
                )}
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

function PublishRateDialog({
  base,
  defaultCurrency,
  models,
  onClose,
}: {
  base: PlatformCreditRate | null;
  defaultCurrency: string | null;
  models: AiModel[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [currency, setCurrency] = useState(base?.currency ?? defaultCurrency ?? '');
  const [price, setPrice] = useState(
    base ? minorToInput(base.creditPriceMinor, base.currency) : '',
  );
  const [usdRate, setUsdRate] = useState(base ? String(base.usdRate) : '');
  const [minimum, setMinimum] = useState(String(base?.minimumCreditsPerRequest ?? 1));
  const [voice, setVoice] = useState(
    base?.transcriptionCreditsPerMinute === null ||
      base?.transcriptionCreditsPerMinute === undefined
      ? ''
      : String(base.transcriptionCreditsPerMinute),
  );
  const [keywords, setKeywords] = useState(
    base?.keywordLookupCredits === null || base?.keywordLookupCredits === undefined
      ? ''
      : String(base.keywordLookupCredits),
  );
  const [tiers, setTiers] = useState<Record<ModelTier, { input: string; output: string }>>(
    () =>
      Object.fromEntries(
        TIERS.map((t) => {
          const x = base?.tiers.find((y) => y.tier === t);
          return [
            t,
            {
              input: x ? String(x.inputCreditsPer1k) : '',
              output: x ? String(x.outputCreditsPer1k) : '',
            },
          ];
        }),
      ) as Record<ModelTier, { input: string; output: string }>,
  );
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');

  const cur = currency.trim().toUpperCase();
  const curValid = /^[A-Z]{3}$/.test(cur);
  const priceMinor = curValid ? parseMoney(price, cur) : null;
  const dec = (s: string) => (/^\d+(\.\d{1,2})?$/.test(s.trim()) ? Number(s) : null);
  const draftTiers = TIERS.flatMap((t) => {
    const i = dec(tiers[t].input);
    const o = dec(tiers[t].output);
    return i !== null && o !== null
      ? [{ tier: t, inputCreditsPer1k: i, outputCreditsPer1k: o }]
      : [];
  });
  const partial = TIERS.some(
    (t) =>
      (tiers[t].input.trim() === '') !== (tiers[t].output.trim() === '') ||
      (tiers[t].input.trim() !== '' && dec(tiers[t].input) === null) ||
      (tiers[t].output.trim() !== '' && dec(tiers[t].output) === null),
  );
  const rateNum = Number(usdRate);
  const minNum = dec(minimum);
  const voiceNum = voice.trim() === '' ? null : dec(voice);
  const voiceBad = voice.trim() !== '' && voiceNum === null;
  const keywordsNum = keywords.trim() === '' ? null : dec(keywords);
  const keywordsBad = keywords.trim() !== '' && keywordsNum === null;
  const valid =
    curValid &&
    priceMinor !== null &&
    priceMinor > 0 &&
    rateNum > 0 &&
    minNum !== null &&
    draftTiers.length > 0 &&
    !partial &&
    !voiceBad &&
    !keywordsBad;
  const draft: RateDraft | null = valid
    ? {
        currency: cur,
        creditPriceMinor: priceMinor,
        usdRate: rateNum,
        minimumCreditsPerRequest: minNum,
        tiers: draftTiers,
        transcriptionCreditsPerMinute: voiceNum,
      }
    : null;

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<PlatformCreditRate>('/platform/billing/credit-rates', {
        body: {
          currency: cur,
          creditPriceMinor: priceMinor,
          usdRate: rateNum,
          minimumCreditsPerRequest: minNum,
          tiers: draftTiers,
          ...(voiceNum !== null ? { transcriptionCreditsPerMinute: voiceNum } : {}),
          ...(keywordsNum !== null ? { keywordLookupCredits: keywordsNum } : {}),
          ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom).toISOString() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'credit-rates'] });
      toast.success(`Version ${r.version} published.`);
      onClose();
    },
  });
  const errs: Record<string, string> =
    save.error instanceof ApiError ? save.error.fieldErrors() : {};

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        wide
        className="max-w-3xl"
        title="Publish a new AI credit price"
        description="A new version never changes past charges. Businesses see the new price from the moment it takes effect."
      >
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Currency" htmlFor="r-cur" error={errs.currency}>
              <Input
                id="r-cur"
                className="font-mono uppercase"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                required
              />
            </Field>
            <Field label="Price of 1 credit" htmlFor="r-price" error={errs.creditPriceMinor}>
              <Input
                id="r-price"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
              />
            </Field>
            <Field
              label={`${cur || 'Local'} per 1 USD`}
              htmlFor="r-usd"
              error={errs.usdRate}
              hint="For cost and profit."
            >
              <Input
                id="r-usd"
                inputMode="decimal"
                value={usdRate}
                onChange={(e) => setUsdRate(e.target.value)}
                required
              />
            </Field>
            <Field
              label="Minimum credits"
              htmlFor="r-min"
              error={errs.minimumCreditsPerRequest}
              hint="Per AI request."
            >
              <Input
                id="r-min"
                inputMode="decimal"
                value={minimum}
                onChange={(e) => setMinimum(e.target.value)}
                required
              />
            </Field>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Credits per 1,000 tokens</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {TIERS.map((t) => (
                <div key={t} className="rounded-md border p-3">
                  <p className="text-sm font-medium">{TIER_LABEL[t].name}</p>
                  <p className="mb-2 text-xs text-muted-foreground">{TIER_LABEL[t].use}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Input" htmlFor={`r-${t}-in`}>
                      <Input
                        id={`r-${t}-in`}
                        inputMode="decimal"
                        value={tiers[t].input}
                        onChange={(e) =>
                          setTiers((s) => ({ ...s, [t]: { ...s[t], input: e.target.value } }))
                        }
                      />
                    </Field>
                    <Field label="Output" htmlFor={`r-${t}-out`}>
                      <Input
                        id={`r-${t}-out`}
                        inputMode="decimal"
                        value={tiers[t].output}
                        onChange={(e) =>
                          setTiers((s) => ({ ...s, [t]: { ...s[t], output: e.target.value } }))
                        }
                      />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
            {partial && (
              <p className="mt-2 text-sm text-destructive">
                Fill both input and output for a tier (up to 2 decimals), or leave both empty to
                drop it.
              </p>
            )}
            {errs.tiers && <p className="mt-2 text-sm text-destructive">{errs.tiers}</p>}
          </fieldset>

          <Field
            label="Credits per minute of voice note"
            htmlFor="r-voice"
            optional
            error={
              errs.transcriptionCreditsPerMinute ??
              (voiceBad ? 'A number with up to 2 decimals.' : undefined)
            }
            hint="Turning a customer's voice note into text, charged by the second. Empty: voice notes stay audio only."
          >
            <Input
              id="r-voice"
              inputMode="decimal"
              className="sm:max-w-48"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            />
          </Field>

          <Field
            label="Credits per keyword lookup"
            htmlFor="r-keywords"
            optional
            error={
              errs.keywordLookupCredits ??
              (keywordsBad ? 'A number with up to 2 decimals.' : undefined)
            }
            hint="One look-up of monthly searches for up to 100 keywords in the SEO studio. Empty: keyword ideas show without search volumes."
          >
            <Input
              id="r-keywords"
              inputMode="decimal"
              className="sm:max-w-48"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </Field>

          {draft && (
            <div className="rounded-md border">
              <p className="border-b px-4 py-2 text-sm font-medium">Margin with this price</p>
              <EconomicsTable rate={draft} rows={tierEconomics(draft, models)} />
              <VoiceMargin rate={draft} models={models} />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Takes effect"
              htmlFor="r-from"
              optional
              hint="Empty means right away."
              error={errs.effectiveFrom}
            >
              <Input
                id="r-from"
                type="datetime-local"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </Field>
            <Field label="Note" htmlFor="r-note" optional hint="Why the price changed.">
              <Textarea
                id="r-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!valid}>
              Publish version {base ? base.version + 1 : 1}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModelDialog({ model, onClose }: { model: AiModel | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<AiModel['provider']>(model?.provider ?? 'anthropic');
  const [modelId, setModelId] = useState(model?.model ?? '');
  const [label, setLabel] = useState(model?.label ?? '');
  const [purpose, setPurpose] = useState<ModelPurpose>(model?.purpose ?? 'chat');
  const speech = purpose === 'transcription';
  const [tier, setTier] = useState<ModelTier>(model?.tier ?? 'standard');
  const [perMinute, setPerMinute] = useState(
    model?.audioUsdPerMinute === null || model?.audioUsdPerMinute === undefined
      ? ''
      : String(model.audioUsdPerMinute),
  );
  const [input, setInput] = useState(String(model?.inputUsdPerMTok ?? ''));
  const [cached, setCached] = useState(String(model?.cachedInputUsdPerMTok ?? 0));
  const [cacheWrite, setCacheWrite] = useState(
    model?.cacheWriteUsdPerMTok === null || model?.cacheWriteUsdPerMTok === undefined
      ? ''
      : String(model.cacheWriteUsdPerMTok),
  );
  const [output, setOutput] = useState(String(model?.outputUsdPerMTok ?? ''));
  const [contextWindow, setContextWindow] = useState(String(model?.contextWindow ?? 200_000));
  const [long, setLong] = useState(Boolean(model?.longContext));
  const [longThreshold, setLongThreshold] = useState(
    String(model?.longContext?.thresholdTokens ?? 200_000),
  );
  const [longIn, setLongIn] = useState(String(model?.longContext?.inputUsdPerMTok ?? ''));
  const [longOut, setLongOut] = useState(String(model?.longContext?.outputUsdPerMTok ?? ''));
  const [imageInput, setImageInput] = useState(model?.imageInput ?? false);
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(model?.isDefaultForTier ?? false);

  const num = (s: string) =>
    s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) : null;
  const valid = speech
    ? Boolean(modelId.trim() && label.trim() && num(perMinute) !== null)
    : modelId.trim() &&
      label.trim() &&
      num(input) !== null &&
      num(output) !== null &&
      num(cached) !== null &&
      (cacheWrite.trim() === '' || num(cacheWrite) !== null) &&
      Number.isInteger(num(contextWindow)) &&
      (!long ||
        (Number.isInteger(num(longThreshold)) && num(longIn) !== null && num(longOut) !== null));

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      // Speech-to-text is priced per minute; its token prices stay at zero.
      const body = speech
        ? {
            label: label.trim(),
            tier: model?.tier ?? 'fast',
            audioUsdPerMinute: num(perMinute),
            inputUsdPerMTok: 0,
            outputUsdPerMTok: 0,
            cachedInputUsdPerMTok: 0,
            enabled,
            isDefaultForTier: isDefault,
          }
        : {
            label: label.trim(),
            tier,
            inputUsdPerMTok: num(input),
            outputUsdPerMTok: num(output),
            cachedInputUsdPerMTok: num(cached),
            cacheWriteUsdPerMTok: cacheWrite.trim() === '' ? null : num(cacheWrite),
            contextWindow: num(contextWindow),
            longContext: long
              ? {
                  thresholdTokens: num(longThreshold),
                  inputUsdPerMTok: num(longIn),
                  outputUsdPerMTok: num(longOut),
                }
              : null,
            imageInput,
            enabled,
            isDefaultForTier: isDefault,
          };
      return model
        ? api<AiModel>(`/platform/billing/ai-models/${model.id}`, { method: 'PATCH', body })
        : api<AiModel>('/platform/billing/ai-models', {
            body: { ...body, provider, model: modelId.trim(), purpose },
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'ai-models'] });
      toast.success(model ? 'Model saved.' : 'Model added.');
      onClose();
    },
  });
  const errs: Record<string, string> =
    save.error instanceof ApiError ? save.error.fieldErrors() : {};

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        wide
        title={model ? `Edit ${model.label}` : 'Add a provider model'}
        description="Copy prices from the provider's price page. They decide cost and profit, never what merchants pay."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" htmlFor="m-provider">
              <NativeSelect
                id="m-provider"
                value={provider}
                disabled={Boolean(model)}
                onChange={(e) => setProvider(e.target.value as AiModel['provider'])}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google</option>
                <option value="other">Other</option>
              </NativeSelect>
            </Field>
            <Field
              label="Model ID"
              htmlFor="m-id"
              hint={model ? 'Cannot change.' : "Exactly as the provider's API expects it."}
              error={errs.model}
            >
              <Input
                id="m-id"
                className="font-mono"
                value={modelId}
                disabled={Boolean(model)}
                onChange={(e) => setModelId(e.target.value)}
                required
              />
            </Field>
            <Field label="Name shown to admins" htmlFor="m-label" error={errs.label}>
              <Input
                id="m-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={100}
                required
              />
            </Field>
            <Field label="Used for" htmlFor="m-purpose" hint={model ? 'Cannot change.' : undefined}>
              <NativeSelect
                id="m-purpose"
                value={purpose}
                disabled={Boolean(model)}
                onChange={(e) => setPurpose(e.target.value as ModelPurpose)}
              >
                <option value="chat">AI replies and writing</option>
                <option value="transcription">Voice notes to text</option>
              </NativeSelect>
            </Field>
            {!speech && (
              <Field label="Tier" htmlFor="m-tier">
                <NativeSelect
                  id="m-tier"
                  value={tier}
                  onChange={(e) => setTier(e.target.value as ModelTier)}
                >
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t].name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>
          {speech ? (
            <Field
              label="$ per minute of audio"
              htmlFor="m-minute"
              error={errs.audioUsdPerMinute}
              hint="What the provider charges to turn one minute of recording into text."
            >
              <Input
                id="m-minute"
                inputMode="decimal"
                className="sm:max-w-48"
                value={perMinute}
                onChange={(e) => setPerMinute(e.target.value)}
                required
              />
            </Field>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Input $ / M tokens" htmlFor="m-in" error={errs.inputUsdPerMTok}>
                  <Input
                    id="m-in"
                    inputMode="decimal"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    required
                  />
                </Field>
                <Field
                  label="Cached input $ / M"
                  htmlFor="m-cached"
                  error={errs.cachedInputUsdPerMTok}
                >
                  <Input
                    id="m-cached"
                    inputMode="decimal"
                    value={cached}
                    onChange={(e) => setCached(e.target.value)}
                  />
                </Field>
                <Field
                  label="Cache write $ / M"
                  htmlFor="m-cache-write"
                  error={errs.cacheWriteUsdPerMTok}
                  hint="Empty: 1.25 × input"
                >
                  <Input
                    id="m-cache-write"
                    inputMode="decimal"
                    value={cacheWrite}
                    placeholder={num(input) !== null ? String(num(input)! * 1.25) : ''}
                    onChange={(e) => setCacheWrite(e.target.value)}
                  />
                </Field>
                <Field label="Output $ / M tokens" htmlFor="m-out" error={errs.outputUsdPerMTok}>
                  <Input
                    id="m-out"
                    inputMode="decimal"
                    value={output}
                    onChange={(e) => setOutput(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Context window" htmlFor="m-ctx" error={errs.contextWindow}>
                  <Input
                    id="m-ctx"
                    inputMode="numeric"
                    value={contextWindow}
                    onChange={(e) => setContextWindow(e.target.value)}
                  />
                </Field>
              </div>
              <div className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="m-long" className="text-sm font-medium">
                    Higher price for long prompts
                  </label>
                  <Switch id="m-long" checked={long} onCheckedChange={setLong} />
                </div>
                {long && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Field label="Above (prompt tokens)" htmlFor="m-lt">
                      <Input
                        id="m-lt"
                        inputMode="numeric"
                        value={longThreshold}
                        onChange={(e) => setLongThreshold(e.target.value)}
                      />
                    </Field>
                    <Field label="Input $ / M" htmlFor="m-li">
                      <Input
                        id="m-li"
                        inputMode="decimal"
                        value={longIn}
                        onChange={(e) => setLongIn(e.target.value)}
                      />
                    </Field>
                    <Field label="Output $ / M" htmlFor="m-lo">
                      <Input
                        id="m-lo"
                        inputMode="decimal"
                        value={longOut}
                        onChange={(e) => setLongOut(e.target.value)}
                      />
                    </Field>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <span className="text-sm">
                  <label htmlFor="m-images" className="font-medium">
                    Understands photos
                  </label>
                  <span className="block text-xs text-muted-foreground">
                    The AI agent shows it the customer’s newest photos. Turn on only if the provider
                    accepts images for this model; photos are billed as input tokens.
                  </span>
                </span>
                <Switch id="m-images" checked={imageInput} onCheckedChange={setImageInput} />
              </div>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <label htmlFor="m-enabled" className="text-sm font-medium">
                Enabled
              </label>
              <Switch id="m-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div
              className={cn('flex items-center justify-between gap-3 rounded-md border px-3 py-2')}
            >
              <span className="text-sm">
                <label htmlFor="m-default" className="font-medium">
                  {speech ? 'Default for voice notes' : `Default for ${TIER_LABEL[tier].name}`}
                </label>
                <span className="block text-xs text-muted-foreground">
                  Replaces the current default.
                </span>
              </span>
              <Switch id="m-default" checked={isDefault} onCheckedChange={setIsDefault} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!valid}>
              {model ? 'Save model' : 'Add model'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
