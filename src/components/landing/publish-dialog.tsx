'use client';

import { CalendarClock, Check, FlaskConical, Send } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { AbTestSettings, LandingPage } from '@/lib/api/types';
import { fromLocalInput, toLocalInput } from '@/lib/format';
import { AB_DEFAULTS, abTestBlocker, publishAtProblem } from '@/lib/landing';
import { cn } from '@/lib/utils';

/** What "Publish" sends: now, at a time, or as an A/B test (ADR 0031). */
export type PublishRequest =
  { purpose: 'publish'; publishAt: string | null } | { purpose: 'ab_test'; abTest: AbTestSettings };

type Mode = 'now' | 'later' | 'ab';

/** An hour from now, on the hour: a sensible first time to offer. */
function nextHour(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d.toISOString());
}

/**
 * Asks how to publish the saved draft. Every way goes through the same review; with a time
 * the approved version waits for it, and an A/B test starts once approved.
 */
export function PublishDialog({
  page,
  orgId,
  open,
  onOpenChange,
  busy,
  onPublish,
}: {
  page: LandingPage;
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onPublish: (req: PublishRequest) => void;
}) {
  const [mode, setMode] = useState<Mode>('now');
  const [at, setAt] = useState(nextHour);
  const [ab, setAb] = useState<AbTestSettings>(AB_DEFAULTS);
  const [problem, setProblem] = useState<string | null>(null);
  const testBlocker = abTestBlocker(page);
  const base = `/app/${orgId}/landing-pages/${page.id}`;

  const choices: { key: Mode; icon: typeof Send; title: string; text: string; off?: string }[] = [
    {
      key: 'now',
      icon: Send,
      title: 'Now',
      text: page.published
        ? 'The new version replaces the live one once approved.'
        : 'The page goes live once approved.',
    },
    {
      key: 'later',
      icon: CalendarClock,
      title: 'At a time',
      text: 'Approved first, then it goes live by itself at the time you choose, such as midnight when a sale starts.',
    },
    {
      key: 'ab',
      icon: FlaskConical,
      title: 'As an A/B test',
      text: 'Some visitors see the new version, the rest the live one. Keep the one that sells better.',
      off: testBlocker ?? undefined,
    },
  ];

  const submit = () => {
    setProblem(null);
    if (mode === 'ab') return onPublish({ purpose: 'ab_test', abTest: ab });
    if (mode === 'now') return onPublish({ purpose: 'publish', publishAt: null });
    const iso = fromLocalInput(at);
    const p = publishAtProblem(iso);
    if (p) return setProblem(p);
    onPublish({ purpose: 'publish', publishAt: iso });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setProblem(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={page.published ? 'Publish changes' : 'Publish page'}
        description="Sellora checks every version before shoppers see it; most pages pass at once."
      >
        {page.abTest ? (
          <Alert tone="info" title="An A/B test is running">
            <p>End the test first: keep the live version or make the new one live.</p>
            <Button asChild size="sm" variant="outline" className="mt-2">
              <Link href={`${base}/ab-tests`}>See the A/B test</Link>
            </Button>
          </Alert>
        ) : (
          <div className="grid gap-2" role="radiogroup" aria-label="When to publish">
            {choices.map((c) => {
              const selected = mode === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={Boolean(c.off)}
                  onClick={() => setMode(c.key)}
                  className={cn(
                    'relative flex gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    selected ? 'border-primary bg-info-soft' : 'hover:border-foreground/30',
                  )}
                >
                  <c.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="grid gap-0.5 pr-5">
                    <span className="text-sm font-medium">{c.title}</span>
                    <span className="text-[13px] text-muted-foreground">{c.off ?? c.text}</span>
                  </span>
                  {selected && (
                    <Check className="absolute top-3 right-3 size-4 text-primary" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {!page.abTest && mode === 'later' && (
          <Field
            label="Goes live at"
            htmlFor="lp-publish-at"
            error={problem ?? undefined}
            hint="Your computer’s time. Up to 90 days ahead."
          >
            <Input
              id="lp-publish-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
        )}

        {!page.abTest && mode === 'ab' && (
          <div className="grid gap-4 rounded-lg border p-3">
            <Field
              label="Visitors who see the new version"
              htmlFor="lp-ab-split"
              hint="The rest see the live version. Each visitor keeps seeing the same one."
            >
              <NativeSelect
                id="lp-ab-split"
                className="w-32"
                value={ab.splitB}
                onChange={(e) => setAb((s) => ({ ...s, splitB: Number(e.target.value) }))}
              >
                {[10, 20, 30, 40, 50, 60, 70, 80, 90].map((n) => (
                  <option key={n} value={n}>
                    {n}%
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <label className="flex items-start gap-3 text-sm">
              <Switch
                checked={ab.autoWinner}
                onCheckedChange={(autoWinner) => setAb((s) => ({ ...s, autoWinner }))}
                className="mt-0.5"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">Choose the winner by itself</span>
                <span className="text-[13px] text-muted-foreground">
                  Once each version had enough visitors and one sells clearly better (95% sure),
                  that one stays live. Otherwise you choose.
                </span>
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Visitors each version needs" htmlFor="lp-ab-min">
                <Input
                  id="lp-ab-min"
                  type="number"
                  min={50}
                  max={100000}
                  value={ab.minVisitors}
                  onChange={(e) =>
                    setAb((s) => ({ ...s, minVisitors: Math.round(Number(e.target.value)) }))
                  }
                />
              </Field>
              <Field label="Ends after (days)" htmlFor="lp-ab-days">
                <Input
                  id="lp-ab-days"
                  type="number"
                  min={3}
                  max={60}
                  value={ab.maxDays}
                  onChange={(e) =>
                    setAb((s) => ({ ...s, maxDays: Math.round(Number(e.target.value)) }))
                  }
                />
              </Field>
            </div>
            {abSettingsProblem(ab) && (
              <p role="alert" className="text-[13px] text-destructive">
                {abSettingsProblem(ab)}
              </p>
            )}
            <p className="text-[13px] text-muted-foreground">
              When the days are up without a clear winner, the live version stays and you can decide
              from the numbers.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!page.abTest && (
            <Button
              loading={busy}
              disabled={mode === 'ab' && Boolean(abSettingsProblem(ab))}
              onClick={submit}
            >
              {mode === 'ab' ? 'Start A/B test' : mode === 'later' ? 'Schedule' : 'Publish'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Why the A/B settings cannot be sent, or null. */
function abSettingsProblem(s: AbTestSettings): string | null {
  if (!Number.isInteger(s.minVisitors) || s.minVisitors < 50 || s.minVisitors > 100_000)
    return 'Each version needs between 50 and 100,000 visitors.';
  if (!Number.isInteger(s.maxDays) || s.maxDays < 3 || s.maxDays > 60)
    return 'Run the test for 3 to 60 days.';
  return null;
}
