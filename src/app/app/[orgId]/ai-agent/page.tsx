'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Lock, MessageSquare, Plus, Trash2, Wallet, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { TestChat } from '@/components/ai-agent/test-chat';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  AI_LIMITS,
  LANGUAGE_OPTIONS,
  TIER_OPTIONS,
  TONE_OPTIONS,
  addKeywords,
  changedFields,
  previewDraft,
  repliesLeft,
  toDraft,
  validateDraft,
  type AgentDraft,
  type AgentPatch,
} from '@/lib/ai-agent';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { AiAgentView, AiLanguage } from '@/lib/api/types';
import { formatClock, formatCredits, formatMoney, formatNumber } from '@/lib/format';
import { CHANNEL_LABEL } from '@/lib/inbox';
import { cn } from '@/lib/utils';

const agentKey = (orgId: string) => ['org', orgId, 'ai-agent'] as const;

function Count({ value, max }: { value: string; max: number }) {
  const n = value.trim().length;
  return (
    <span className={cn('tabular', n > max ? 'text-destructive' : 'text-muted-foreground')}>
      {formatNumber(n)} / {formatNumber(max)}
    </span>
  );
}

function SwitchRow({
  checked,
  onChange,
  disabled,
  title,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn('flex items-start gap-3 text-sm', disabled && 'opacity-60')}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
      <span>
        {title}
        <span className="block text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}

function VoiceNotesCard({
  voiceNotes,
  checked,
  onChange,
}: {
  voiceNotes: AiAgentView['status']['voiceNotes'];
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const price = voiceNotes.perMinute;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice notes</CardTitle>
        <CardDescription>
          Customers’ voice notes from Facebook, Instagram and WhatsApp are always saved in the inbox
          so your team can play them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <SwitchRow checked={checked} onChange={onChange} title="Turn voice notes into text">
          The text shows under each voice note, and the agent answers it like a typed message.
          Speech-to-text can mishear names, numbers and addresses, so the agent confirms them before
          placing an order. Recordings longer than {formatClock(voiceNotes.maxSeconds * 1000)} stay
          audio only.
        </SwitchRow>
        {voiceNotes.available && price ? (
          <p className="text-sm text-muted-foreground">
            Costs {formatCredits(price.credits)} per minute of recording (about{' '}
            {formatMoney(price.amountMinor, price.currency)}), counted by the second, from your AI
            credit balance.
          </p>
        ) : (
          <Alert tone="info" title="Voice-to-text is not set up on this Sellora server yet">
            Voice notes are still saved and playable. The platform team turns this on.
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function StatusCards({
  view,
  currency,
  orgId,
}: {
  view: AiAgentView;
  currency: string;
  orgId: string;
}) {
  const { settings, status } = view;
  const left = repliesLeft(status.wallet.availableMinor, status.perReply?.amountMinor);
  const replying = status.channels.filter(
    (c) => c.aiEnabled && c.aiCanReply && c.status === 'active',
  );
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Bot className="size-3.5" aria-hidden /> Agent
        </p>
        <p className="mt-1 font-semibold">
          {!settings.enabled
            ? 'Off'
            : status.serviceReady
              ? 'Answering customers'
              : 'On, AI service unavailable'}
        </p>
        <p className="text-xs text-muted-foreground">
          {replying.length
            ? `Replies on ${
                replying.length <= 2
                  ? replying.map((c) => c.name).join(' and ')
                  : `${replying.length} website chats`
              }`
            : 'No channel it can reply on yet'}
        </p>
      </Card>
      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageSquare className="size-3.5" aria-hidden /> A typical reply
        </p>
        <p className="tabular mt-1 font-semibold">
          {status.perReply ? formatCredits(status.perReply.credits) : 'Price not set'}
        </p>
        <p className="text-xs text-muted-foreground">
          {status.perReply
            ? `About ${formatMoney(status.perReply.amountMinor, status.perReply.currency)}; longer chats cost more`
            : 'The platform has not set AI prices yet'}
        </p>
      </Card>
      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Wallet className="size-3.5" aria-hidden /> AI credit in your wallet
        </p>
        <p className="tabular mt-1 font-semibold">
          {formatMoney(status.wallet.availableMinor, status.wallet.currency || currency)}
        </p>
        <p className="text-xs text-muted-foreground">
          {left !== null ? `About ${formatNumber(left)} typical replies` : ' '}
          {' · '}
          <Link
            href={`/app/${orgId}/billing/wallet`}
            className="underline-offset-4 hover:underline"
          >
            Top up
          </Link>
        </p>
      </Card>
    </div>
  );
}

function Notices({
  view,
  orgId,
  canManage,
}: {
  view: AiAgentView;
  orgId: string;
  canManage: boolean;
}) {
  const { settings, status } = view;
  const left = repliesLeft(status.wallet.availableMinor, status.perReply?.amountMinor);
  const canReplySomewhere = status.channels.some((c) => c.aiCanReply && c.status === 'active');
  const notices: React.ReactNode[] = [];
  if (!status.serviceReady)
    notices.push(
      <Alert key="service" tone="warning" title="The AI service is not available right now">
        The agent cannot reply until it is back. Chats go to your team in the meantime, so no
        customer is left waiting. The platform team looks after this.
      </Alert>,
    );
  if (left !== null && left < 20)
    notices.push(
      <Alert
        key="credit"
        tone={left === 0 ? 'danger' : 'warning'}
        title={left === 0 ? 'Your AI credit is used up' : 'Your AI credit is running low'}
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={`/app/${orgId}/billing/wallet`}>Top up</Link>
          </Button>
        }
      >
        {left === 0
          ? 'The agent hands every chat to your team until you add money to your wallet.'
          : `About ${left} typical replies left.`}
      </Alert>,
    );
  if (!canReplySomewhere)
    notices.push(
      <Alert
        key="channels"
        tone="info"
        title="Connect a channel so the agent can reply"
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={`/app/${orgId}/settings/channels`}>Channels</Link>
          </Button>
        }
      >
        Add the website chat, or connect your Facebook page, Instagram or WhatsApp.
      </Alert>,
    );
  if (!settings.enabled && canManage && status.serviceReady)
    notices.push(
      <Alert key="off" tone="info" title="The agent is off">
        Add what customers usually ask, try it in the chat on this page, then turn it on.
      </Alert>,
    );
  return notices.length ? <div className="grid gap-3">{notices}</div> : null;
}

function FaqEditor({
  faqs,
  errors,
  onChange,
}: {
  faqs: AgentDraft['faqs'];
  errors: Record<string, string>;
  onChange: (faqs: AgentDraft['faqs']) => void;
}) {
  const set = (i: number, patch: Partial<AgentDraft['faqs'][number]>) =>
    onChange(faqs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="grid gap-3">
      {faqs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No questions yet. Add the ones customers ask most: delivery time, return policy, sizes,
          payment.
        </p>
      )}
      {faqs.map((f, i) => (
        <div key={i} className="grid gap-2 rounded-lg border p-3">
          <div className="flex items-start gap-2">
            <Field
              label={`Question ${i + 1}`}
              htmlFor={`faq-${i}-q`}
              error={errors[`faq-${i}-q`]}
              className="flex-1"
            >
              <Input
                id={`faq-${i}-q`}
                value={f.question}
                maxLength={AI_LIMITS.faqQuestion}
                placeholder="How long does delivery take?"
                onChange={(e) => set(i, { question: e.target.value })}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="mt-6"
              aria-label={`Remove question ${i + 1}`}
              onClick={() => onChange(faqs.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </div>
          <Field label="Answer" htmlFor={`faq-${i}-a`} error={errors[`faq-${i}-a`]}>
            <Textarea
              id={`faq-${i}-a`}
              rows={2}
              value={f.answer}
              maxLength={AI_LIMITS.faqAnswer}
              placeholder="Inside Dhaka 1–2 days, outside Dhaka 2–4 days."
              onChange={(e) => set(i, { answer: e.target.value })}
            />
          </Field>
        </div>
      ))}
      {faqs.length < AI_LIMITS.faqs && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...faqs, { question: '', answer: '' }])}
          >
            <Plus /> Add question
          </Button>
        </div>
      )}
    </div>
  );
}

function KeywordsEditor({
  keywords,
  error,
  onChange,
}: {
  keywords: string[];
  error?: string;
  onChange: (k: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const add = () => {
    onChange(addKeywords(keywords, input));
    setInput('');
  };
  return (
    <Field
      label="Hand over when the customer writes"
      htmlFor="keywords"
      error={error}
      hint="Words or phrases, in any language. Press Enter to add each one."
    >
      {keywords.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Handover phrases">
          {keywords.map((k) => (
            <li key={k}>
              <Badge tone="outline" className="gap-1 py-1 pr-1 text-foreground">
                {k}
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-accent"
                  aria-label={`Remove ${k}`}
                  onClick={() => onChange(keywords.filter((x) => x !== k))}
                >
                  <X />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id="keywords"
          value={input}
          maxLength={AI_LIMITS.keyword * 3}
          placeholder="talk to a human, মানুষের সাথে কথা"
          disabled={keywords.length >= AI_LIMITS.handoverKeywords}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          onBlur={() => input.trim() && add()}
        />
        <Button type="button" variant="outline" onClick={add} disabled={!input.trim()}>
          Add
        </Button>
      </div>
    </Field>
  );
}

function AgentEditor({ view: initial }: { view: AiAgentView }) {
  const { org, can } = useOrg();
  const qc = useQueryClient();
  const perms = { behaviour: can('ai.settings.manage'), knowledge: can('ai.knowledge.manage') };
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<AgentDraft>(() => toDraft(initial.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const errors = validateDraft(draft);
  const visibleErrors = showErrors ? errors : {};
  // The switch at the top saves on its own; the form covers everything else.
  const pending = changedFields(view.settings, { ...draft, enabled: view.settings.enabled }, perms);
  const dirty = Object.keys(pending).length > 0;
  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const apply = (next: AiAgentView, keepDraft = false) => {
    setView(next);
    qc.setQueryData(agentKey(org.id), next);
    if (!keepDraft) setDraft(toDraft(next.settings));
    else setDraft((d) => ({ ...d, enabled: next.settings.enabled }));
  };

  const patch = (body: AgentPatch) =>
    api<AiAgentView>(`/orgs/${org.id}/ai-agent`, { method: 'PATCH', body });

  const save = () => {
    if (Object.keys(errors).length) {
      setShowErrors(true);
      setError('Check the highlighted fields.');
      return;
    }
    setBusy(true);
    setError(null);
    patch(pending)
      .then((next) => {
        apply(next);
        setShowErrors(false);
        toast.success('Saved. The agent uses the new settings from the next message.');
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const [toggling, setToggling] = useState(false);
  const toggle = (enabled: boolean) => {
    setToggling(true);
    patch({ enabled })
      .then((next) => {
        apply(next, true);
        toast.success(enabled ? 'The AI sales agent is on.' : 'The AI sales agent is off.');
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => setToggling(false));
  };

  const tierInfo = (tier: string) => view.status.tiers.find((t) => t.tier === tier);
  const draftTier = tierInfo(draft.tier);
  const languageHint = LANGUAGE_OPTIONS.find((l) => l.value === draft.language)?.hint;
  // Channels where the agent stays quiet, so the merchant is not surprised.
  const quiet = view.status.channels.filter(
    (c) => (c.status === 'active' && !c.aiEnabled) || (c.status === 'error' && c.aiEnabled),
  );
  const blockedReason = !draftTier?.available
    ? 'The AI service is not available right now, so the test chat cannot run.'
    : null;

  return (
    <>
      <PageHeader
        title="AI sales agent"
        description="Answers customers in your inbox, suggests products and takes orders, in Bangla, Banglish or English."
        actions={
          <>
            <Button asChild variant="outline" className="lg:hidden">
              <a href="#try-it">Try it</a>
            </Button>
            <label
              className={cn(
                'flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm shadow-xs',
                !perms.behaviour && 'opacity-70',
              )}
              title={
                perms.behaviour
                  ? undefined
                  : 'Only the owner and admins can turn the agent on or off'
              }
            >
              <span className="font-medium">
                {view.settings.enabled ? 'Agent on' : 'Agent off'}
              </span>
              <Switch
                checked={view.settings.enabled}
                disabled={!perms.behaviour || toggling}
                onCheckedChange={toggle}
                aria-label="AI sales agent on"
              />
            </label>
          </>
        }
      />

      <div className="grid gap-6">
        <StatusCards view={view} currency={org.currency} orgId={org.id} />
        <Notices view={view} orgId={org.id} canManage={perms.behaviour} />

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <form
            noValidate
            className="grid gap-6 pb-20"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {!perms.behaviour && (
              <Alert tone="info">
                You can keep what the agent knows up to date. The owner and admins decide how it
                behaves.
              </Alert>
            )}
            {error && <Alert tone="danger">{error}</Alert>}

            <fieldset disabled={!perms.behaviour || busy} className="contents">
              <Card>
                <CardHeader>
                  <CardTitle>Personality</CardTitle>
                  <CardDescription>How the agent introduces itself and talks.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5">
                  <Field
                    label="Name"
                    htmlFor="assistantName"
                    optional
                    error={visibleErrors.assistantName}
                    hint={`Customers see it as the sender. Empty: “${org.name} assistant”.`}
                    className="max-w-sm"
                  >
                    <Input
                      id="assistantName"
                      value={draft.assistantName}
                      maxLength={AI_LIMITS.assistantName}
                      placeholder="Mitu"
                      onChange={(e) => set('assistantName', e.target.value)}
                    />
                  </Field>
                  <div className="grid gap-1.5">
                    <span className="text-sm font-medium">Tone</span>
                    <div>
                      <Segmented
                        label="Tone"
                        value={draft.tone}
                        onChange={(v) => set('tone', v)}
                        options={TONE_OPTIONS}
                      />
                    </div>
                  </div>
                  <Field
                    label="Reply language"
                    htmlFor="language"
                    hint={languageHint}
                    className="max-w-sm"
                  >
                    <NativeSelect
                      id="language"
                      value={draft.language}
                      onChange={(e) => set('language', e.target.value as AiLanguage)}
                    >
                      {LANGUAGE_OPTIONS.map((l) => (
                        <option key={l.value} value={l.value}>
                          {l.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <div className="grid gap-2">
                    <span className="text-sm font-medium" id="tier-label">
                      Quality
                    </span>
                    <div
                      role="radiogroup"
                      aria-labelledby="tier-label"
                      className="grid gap-2 sm:grid-cols-3"
                    >
                      {TIER_OPTIONS.map((t) => {
                        const info = tierInfo(t.value);
                        const selected = draft.tier === t.value;
                        return (
                          <button
                            key={t.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => set('tier', t.value)}
                            className={cn(
                              'grid gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60 disabled:pointer-events-none',
                              selected && 'border-primary ring-2 ring-primary/20',
                            )}
                          >
                            <span className="flex items-center justify-between gap-2 text-sm font-medium">
                              {t.label}
                              {info && !info.available && <Badge tone="warning">Unavailable</Badge>}
                            </span>
                            <span className="text-xs text-muted-foreground">{t.hint}</span>
                            <span className="tabular text-xs font-medium">
                              {info?.perReply
                                ? `${formatCredits(info.perReply.credits)} (${formatMoney(info.perReply.amountMinor, info.perReply.currency)}) per typical reply`
                                : 'Price not set'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </fieldset>

            <fieldset disabled={!perms.knowledge || busy} className="contents">
              <Card>
                <CardHeader>
                  <CardTitle>What the agent knows</CardTitle>
                  <CardDescription>
                    It already knows your products, prices, stock and delivery charges. Add what
                    only you know.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5">
                  <Field
                    label="About your business"
                    htmlFor="businessInfo"
                    error={visibleErrors.businessInfo}
                    hint={<Count value={draft.businessInfo} max={AI_LIMITS.businessInfo} />}
                  >
                    <Textarea
                      id="businessInfo"
                      rows={6}
                      value={draft.businessInfo}
                      placeholder="What you sell, where you deliver and how long it takes, payment options (cash on delivery, bKash), exchange and return policy, opening hours."
                      onChange={(e) => set('businessInfo', e.target.value)}
                    />
                  </Field>
                  <div className="grid gap-2">
                    <span className="text-sm font-medium">Frequently asked questions</span>
                    {visibleErrors.faqs && (
                      <p className="text-[13px] text-destructive">{visibleErrors.faqs}</p>
                    )}
                    <FaqEditor
                      faqs={draft.faqs}
                      errors={visibleErrors}
                      onChange={(f) => set('faqs', f)}
                    />
                  </div>
                  <Field
                    label="Rules for the agent"
                    htmlFor="instructions"
                    optional
                    error={visibleErrors.instructions}
                    hint={
                      <>
                        For example: “Always mention free delivery over ৳2,000.” ·{' '}
                        <Count value={draft.instructions} max={AI_LIMITS.instructions} />
                      </>
                    }
                  >
                    <Textarea
                      id="instructions"
                      rows={3}
                      value={draft.instructions}
                      onChange={(e) => set('instructions', e.target.value)}
                    />
                  </Field>
                </CardContent>
              </Card>
            </fieldset>

            <fieldset disabled={!perms.behaviour || busy} className="contents">
              <Card>
                <CardHeader>
                  <CardTitle>Orders</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-5">
                  <SwitchRow
                    checked={draft.takeOrders}
                    onChange={(v) => set('takeOrders', v)}
                    title="Take orders in the chat"
                  >
                    The agent collects the product, size, name, phone and address, tells the
                    customer the total with delivery, and places the order once they confirm. Off:
                    it collects the details and hands the chat to your team.
                  </SwitchRow>
                  <SwitchRow
                    checked={draft.confirmOrders}
                    onChange={(v) => set('confirmOrders', v)}
                    disabled={!draft.takeOrders}
                    title="Confirm the agent’s orders straight away"
                  >
                    Off (recommended): orders wait as Pending so your team can call the customer
                    first. Confirmed orders take stock at once.
                  </SwitchRow>
                </CardContent>
              </Card>

              <VoiceNotesCard
                voiceNotes={view.status.voiceNotes}
                checked={draft.transcribeVoiceNotes}
                onChange={(v) => set('transcribeVoiceNotes', v)}
              />

              <Card>
                <CardHeader>
                  <CardTitle>Handing over to your team</CardTitle>
                  <CardDescription>
                    The agent also hands over on its own for complaints, order problems, discount
                    requests and questions it cannot answer. It then stays quiet in that chat until
                    someone turns it back on (or sends “.”).
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5">
                  <KeywordsEditor
                    keywords={draft.handoverKeywords}
                    error={visibleErrors.handoverKeywords}
                    onChange={(k) => set('handoverKeywords', k)}
                  />
                  <Field
                    label="Message to the customer"
                    htmlFor="handoverMessage"
                    optional
                    error={visibleErrors.handoverMessage}
                    hint="Sent when a phrase above is used or the AI cannot answer. Empty: a short thank-you in the customer’s script, saying the team will reply soon."
                  >
                    <Textarea
                      id="handoverMessage"
                      rows={2}
                      value={draft.handoverMessage}
                      maxLength={AI_LIMITS.handoverMessage}
                      onChange={(e) => set('handoverMessage', e.target.value)}
                    />
                  </Field>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Timing and limits</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-5 sm:grid-cols-2">
                  <Field
                    label="Wait before replying (seconds)"
                    htmlFor="replyDelaySeconds"
                    error={visibleErrors.replyDelaySeconds}
                    hint="Lets customers finish typing, so several messages get one answer."
                  >
                    <Input
                      id="replyDelaySeconds"
                      inputMode="numeric"
                      className="tabular"
                      value={draft.replyDelaySeconds}
                      onChange={(e) => set('replyDelaySeconds', e.target.value)}
                    />
                  </Field>
                  <Field
                    label="AI replies per chat per day"
                    htmlFor="maxRepliesPerDay"
                    error={visibleErrors.maxRepliesPerDay}
                    hint="After this many, the chat goes to your team. Caps what one chat can spend."
                  >
                    <Input
                      id="maxRepliesPerDay"
                      inputMode="numeric"
                      className="tabular"
                      value={draft.maxRepliesPerDay}
                      onChange={(e) => set('maxRepliesPerDay', e.target.value)}
                    />
                  </Field>
                </CardContent>
              </Card>
            </fieldset>

            {(perms.behaviour || perms.knowledge) && dirty && (
              <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-lg">
                <span className="text-sm text-muted-foreground">You have unsaved changes.</span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setDraft(toDraft(view.settings));
                      setShowErrors(false);
                      setError(null);
                    }}
                  >
                    Discard
                  </Button>
                  <Button type="submit" loading={busy}>
                    Save
                  </Button>
                </div>
              </div>
            )}
          </form>

          <div id="try-it" className="scroll-mt-20 lg:sticky lg:top-20">
            <TestChat
              orgId={org.id}
              draft={previewDraft(draft)}
              perReplyCredits={draftTier?.perReply?.credits ?? null}
              blockedReason={blockedReason}
            />
            {quiet.length > 0 && (
              <p className="mt-2 px-1 text-xs text-muted-foreground">
                The agent does not reply on{' '}
                {quiet
                  .map(
                    (c) =>
                      `${c.name} (${CHANNEL_LABEL[c.type]}: ${c.status === 'error' ? 'needs reconnecting' : 'AI turned off for it'})`,
                  )
                  .join(', ')}
                .
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default function AiAgentPage() {
  const { org, can } = useOrg();
  const allowed = can('ai.settings.manage') || can('ai.knowledge.manage');
  const q = useQuery({
    queryKey: agentKey(org.id),
    queryFn: () => api<AiAgentView>(`/orgs/${org.id}/ai-agent`),
    enabled: allowed,
  });

  if (!allowed)
    return (
      <EmptyState icon={Lock} title="Your role cannot manage the AI sales agent" className="pt-24">
        Ask the owner or an admin of {org.name} if you need access.
      </EmptyState>
    );
  if (q.isPending)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  if (q.isError) return <PageError error={q.error} onRetry={() => void q.refetch()} />;
  return <AgentEditor view={q.data} />;
}
