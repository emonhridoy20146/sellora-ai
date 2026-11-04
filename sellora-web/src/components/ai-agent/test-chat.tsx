'use client';

import { Bot, RotateCcw, Send, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { HANDOVER_LABEL, TOOL_LABEL, type previewDraft } from '@/lib/ai-agent';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { AiPreviewResult } from '@/lib/api/types';
import { formatCredits } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ChatLine {
  id: number;
  from: 'customer' | 'assistant';
  text: string;
  result?: AiPreviewResult;
}

/** The API takes the newest 20 messages, starting with the customer. */
const MAX_MESSAGES = 20;

const SUGGESTIONS = ['Saree ache?', 'দাম কত?', 'Delivery charge koto?', 'I want to order one'];

function history(lines: ChatLine[]): { from: ChatLine['from']; text: string }[] {
  const recent = lines.slice(-MAX_MESSAGES);
  while (recent[0]?.from === 'assistant') recent.shift();
  return recent.map((l) => ({ from: l.from, text: l.text }));
}

function Meta({ result }: { result: AiPreviewResult }) {
  const used = [...new Set(result.toolCalls.map((t) => TOOL_LABEL[t.name] ?? t.name))];
  return (
    <div className="mt-1 space-y-1 px-1 text-[11px] text-muted-foreground">
      {result.handover && (
        <p className="rounded-md bg-warning-soft px-2 py-1 text-[12px] text-foreground">
          Would hand this chat to your team: {HANDOVER_LABEL[result.handover.reason] ?? 'other'}
          {result.handover.summary ? `. “${result.handover.summary}”` : '.'}
        </p>
      )}
      {result.order && (
        <p className="rounded-md bg-success-soft px-2 py-1 text-[12px] text-foreground">
          The agent placed a test order. In a real chat it would appear in Orders; nothing was
          saved.
        </p>
      )}
      {result.outcome !== 'reply' && (
        <p>
          {result.outcome === 'refusal'
            ? 'The AI declined to answer, so the customer would get the handover message.'
            : 'The AI could not finish an answer, so the customer would get the handover message.'}
        </p>
      )}
      <p>
        {used.length > 0 && `${used.join(', ')} · `}
        {formatCredits(result.credits)}
      </p>
    </div>
  );
}

/**
 * Chat with the agent as a customer would, with the settings on the page (saved or not).
 * Runs the real agent on the real catalog; nothing is sent to customers or saved.
 */
export function TestChat({
  orgId,
  draft,
  perReplyCredits,
  blockedReason,
}: {
  orgId: string;
  draft: ReturnType<typeof previewDraft>;
  perReplyCredits: number | null;
  /** Why the chat cannot run now (shown instead of the composer). */
  blockedReason: string | null;
}) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; topUp: boolean } | null>(null);
  const seq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, busy]);

  const send = (value: string) => {
    const message = value.trim();
    if (!message || busy) return;
    const customer: ChatLine = { id: (seq.current += 1), from: 'customer', text: message };
    const next = [...lines, customer];
    setLines(next);
    setText('');
    setError(null);
    setBusy(true);
    api<AiPreviewResult>(`/orgs/${orgId}/ai-agent/preview`, {
      method: 'POST',
      body: { messages: history(next), draft },
    })
      .then((result) =>
        setLines((list) => [
          ...list,
          { id: (seq.current += 1), from: 'assistant', text: result.reply, result },
        ]),
      )
      .catch((err: unknown) => {
        // Put the message back so it can be sent again.
        setLines((list) => list.filter((l) => l.id !== customer.id));
        setText(message);
        setError({
          message: errorMessage(err),
          topUp: err instanceof ApiError && err.status === 402,
        });
      })
      .finally(() => setBusy(false));
  };

  return (
    <Card className="flex max-h-[calc(100dvh-7rem)] min-h-[28rem] flex-col">
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle>Try it</CardTitle>
          <CardDescription>
            Chat as a customer. Uses the settings on this page, even before you save.
          </CardDescription>
        </div>
        {lines.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Start a new test chat"
            title="Start again"
            disabled={busy}
            onClick={() => {
              setLines([]);
              setError(null);
            }}
          >
            <RotateCcw />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-muted/30 p-3"
          aria-live="polite"
        >
          {lines.length === 0 ? (
            <div className="grid h-full content-center gap-3 text-center text-sm text-muted-foreground">
              <Bot className="mx-auto size-6" aria-hidden />
              <p>
                See how the agent answers with your products, prices and settings. Nothing is sent
                to customers and test orders are not saved.
              </p>
              <p className="text-xs">
                Each message uses AI credits
                {perReplyCredits !== null ? `, about ${formatCredits(perReplyCredits)}` : ''}.
              </p>
              {!blockedReason && (
                <div className="flex flex-wrap justify-center gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="rounded-full border bg-card px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <ol className="space-y-3" aria-label="Test chat">
              {lines.map((l) => (
                <li
                  key={l.id}
                  className={cn(
                    'flex flex-col',
                    l.from === 'customer' ? 'items-end' : 'items-start',
                  )}
                >
                  <span className="mb-0.5 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
                    {l.from === 'customer' ? (
                      <>
                        <UserRound className="size-3" aria-hidden /> You, as the customer
                      </>
                    ) : (
                      <>
                        <Bot className="size-3" aria-hidden /> AI agent
                      </>
                    )}
                  </span>
                  <p
                    className={cn(
                      'max-w-[88%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap',
                      l.from === 'customer'
                        ? 'rounded-br-md bg-primary text-primary-foreground'
                        : 'rounded-bl-md bg-card shadow-xs',
                    )}
                  >
                    {l.text}
                  </p>
                  {l.result && <Meta result={l.result} />}
                </li>
              ))}
              {busy && (
                <li className="flex items-center gap-1.5 px-1 text-xs text-primary italic">
                  <Bot className="size-3.5" aria-hidden /> AI is replying…
                </li>
              )}
            </ol>
          )}
        </div>

        {error && (
          <Alert
            tone="danger"
            action={
              error.topUp ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/app/${orgId}/billing/wallet`}>Top up</Link>
                </Button>
              ) : undefined
            }
          >
            {error.message}
          </Alert>
        )}

        {blockedReason ? (
          <p className="rounded-md bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
            {blockedReason}
          </p>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <label htmlFor="test-chat-input" className="sr-only">
              Message as the customer
            </label>
            <Textarea
              id="test-chat-input"
              rows={1}
              value={text}
              maxLength={2000}
              placeholder="Write as a customer…"
              className="max-h-32 min-h-10 resize-none"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(text);
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send"
              loading={busy}
              disabled={!text.trim()}
            >
              {!busy && <Send />}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
