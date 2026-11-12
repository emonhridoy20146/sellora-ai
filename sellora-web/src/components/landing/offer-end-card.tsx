'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { LandingPage } from '@/lib/api/types';
import { formatDateTime, fromLocalInput, toLocalInput } from '@/lib/format';
import { offerEndProblem } from '@/lib/landing';
import { landingKeys } from './hooks';

/**
 * When the offer ends (ADR 0031): the page pauses itself at that time, so an ad that keeps
 * running does not sell an offer that is over. Resume it later from the page's menu.
 */
export function OfferEndCard({ page, orgId }: { page: LandingPage; orgId: string }) {
  const queryClient = useQueryClient();
  const [at, setAt] = useState(toLocalInput(page.pauseAt));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = async (pauseAt: string | null) => {
    if (pauseAt !== null) {
      const p = offerEndProblem(pauseAt);
      if (p) return setProblem(p);
    }
    setBusy(true);
    setProblem(null);
    try {
      const next = await api<LandingPage>(`/orgs/${orgId}/landing-pages/${page.id}/offer-end`, {
        method: 'PUT',
        body: { pauseAt },
      });
      queryClient.setQueryData(landingKeys.page(orgId, page.id), next);
      setAt(toLocalInput(next.pauseAt));
      toast.success(
        next.pauseAt
          ? `The page pauses itself on ${formatDateTime(next.pauseAt)}.`
          : 'The offer has no end now.',
      );
    } catch (err) {
      setProblem(
        err instanceof ApiError && err.errors.length ? err.errors[0]!.message : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const changed =
    (fromLocalInput(at) ?? null) !== (page.pauseAt ? new Date(page.pauseAt).toISOString() : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Offer end</CardTitle>
        <CardDescription>
          The page pauses itself at this time, and shoppers see that the offer is over. Good for a
          sale that ends at midnight. You can resume the page later.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field
          label="Offer ends at"
          htmlFor="lp-offer-end"
          optional
          error={problem ?? undefined}
          hint={
            page.pauseAt
              ? `Now set to ${formatDateTime(page.pauseAt)}. Your computer’s time.`
              : 'Empty: the offer does not end. Your computer’s time.'
          }
          className="max-w-xs"
        >
          <Input
            id="lp-offer-end"
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          {page.pauseAt && (
            <Button variant="ghost" disabled={busy} onClick={() => void send(null)}>
              Remove end
            </Button>
          )}
          <Button
            loading={busy}
            disabled={!at || !changed}
            onClick={() => void send(fromLocalInput(at))}
          >
            Save end
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
