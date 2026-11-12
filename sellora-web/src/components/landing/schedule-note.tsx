'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, FlaskConical, TimerOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { LandingPage } from '@/lib/api/types';
import { formatDateTime, fromLocalInput, toLocalInput } from '@/lib/format';
import { publishAtProblem } from '@/lib/landing';
import { landingKeys } from './hooks';

/**
 * The page's timed parts (ADR 0031): an approved version waiting for its time (publish it
 * now, move it, or drop it), a running A/B test, and when the offer ends.
 */
export function ScheduleNote({ page, orgId }: { page: LandingPage; orgId: string }) {
  const { can } = useOrg();
  const queryClient = useQueryClient();
  const publisher = can('stores.publish');
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [at, setAt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const base = `/app/${orgId}/landing-pages/${page.id}`;
  const path = `/orgs/${orgId}/landing-pages/${page.id}`;

  const apply = (next: LandingPage, done: string) => {
    queryClient.setQueryData(landingKeys.page(orgId, page.id), next);
    void queryClient.invalidateQueries({ queryKey: landingKeys.all(orgId), exact: true });
    void queryClient.invalidateQueries({ queryKey: landingKeys.versions(orgId, page.id) });
    toast.success(done);
  };

  const publishNow = () => {
    setBusy('now');
    api<LandingPage>(`${path}/scheduled/publish-now`, { method: 'POST' })
      .then((next) => apply(next, 'Published. Shoppers see it now.'))
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  const move = async () => {
    const iso = fromLocalInput(at);
    const p = publishAtProblem(iso);
    if (p) return setProblem(p);
    setBusy('move');
    try {
      const next = await api<LandingPage>(`${path}/scheduled`, {
        method: 'PATCH',
        body: { publishAt: iso },
      });
      apply(next, `Moved. It goes live on ${formatDateTime(iso)}.`);
      setMoving(false);
    } catch (err) {
      setProblem(
        err instanceof ApiError && err.errors.length ? err.errors[0]!.message : errorMessage(err),
      );
    } finally {
      setBusy(null);
    }
  };

  const notes: React.ReactNode[] = [];
  if (page.scheduled)
    notes.push(
      <Alert
        key="scheduled"
        tone="info"
        icon={CalendarClock}
        title={`Goes live on ${formatDateTime(page.scheduled.publishAt)}`}
      >
        <p>
          This version is approved and goes live by itself.{' '}
          {page.published
            ? 'Shoppers see the current live version until then.'
            : 'Until then the page is not open to shoppers.'}
        </p>
        {publisher && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={busy === 'now'}
              disabled={busy !== null}
              onClick={publishNow}
            >
              Publish now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                setAt(toLocalInput(page.scheduled!.publishAt));
                setProblem(null);
                setMoving(true);
              }}
            >
              Change time
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setCancelling(true)}
            >
              Cancel
            </Button>
          </div>
        )}
      </Alert>,
    );
  if (page.abTest)
    notes.push(
      <Alert key="ab" tone="info" icon={FlaskConical} title="A/B test running">
        <p>{page.abTest.splitB}% of visitors see the new version (B), the rest the live one (A).</p>
        <Button asChild size="sm" variant="outline" className="mt-2">
          <Link href={`${base}/ab-tests`}>See how each sells</Link>
        </Button>
      </Alert>,
    );
  if (page.pauseAt && page.status !== 'paused')
    notes.push(
      <Alert key="end" tone="info" icon={TimerOff}>
        The offer ends on {formatDateTime(page.pauseAt)}; the page pauses itself then.{' '}
        <Link href={`${base}/settings`} className="font-medium underline">
          Change
        </Link>
      </Alert>,
    );
  if (notes.length === 0) return null;

  return (
    <>
      {notes}
      <Dialog open={moving} onOpenChange={setMoving}>
        <DialogContent title="Change the time" description="The approved version goes live then.">
          <Field
            label="Goes live at"
            htmlFor="lp-move-at"
            error={problem ?? undefined}
            hint="Your computer’s time. Up to 90 days ahead."
          >
            <Input
              id="lp-move-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoving(false)}>
              Cancel
            </Button>
            <Button loading={busy === 'move'} onClick={() => void move()}>
              Save time
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel the scheduled version?"
        description="It will not go live. Your draft stays, so you can publish it again later."
        confirmLabel="Cancel schedule"
        destructive
        onConfirm={async () => {
          try {
            const next = await api<LandingPage>(`${path}/scheduled`, { method: 'DELETE' });
            apply(next, 'Schedule cancelled.');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </>
  );
}
