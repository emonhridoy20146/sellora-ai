'use client';

import { useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/input';
import { formatMoney } from '@/lib/format';
import { lengthSummary, smsLength } from '@/lib/sms';

/**
 * A marketing SMS: the text with placeholder buttons, and next to it the text as the customer
 * gets it (sample values, the short link and the stop link), its length and its price.
 */
export function MessageEditor({
  id,
  label,
  value,
  onChange,
  placeholders,
  preview,
  maxChars,
  perPartMinor,
  currency,
  problem,
  editable,
  rows = 4,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholders: { key: string; label: string }[];
  preview: string;
  maxChars: number;
  perPartMinor: number | null;
  currency: string;
  problem?: string | null;
  editable: boolean;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const length = smsLength(value.trim() ? preview : '');
  const cost = perPartMinor !== null && length.parts > 0 ? perPartMinor * length.parts : null;

  const insert = (key: string) => {
    const el = ref.current;
    const token = `{${key}}`;
    if (!el) return onChange(`${value}${token}`);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="grid content-start gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Textarea
          id={id}
          ref={ref}
          rows={rows}
          value={value}
          maxLength={maxChars}
          disabled={!editable}
          aria-invalid={Boolean(problem)}
          aria-describedby={`${id}-meta`}
          onChange={(e) => onChange(e.target.value)}
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
        <p className="text-xs text-muted-foreground">
          {value.trim().length}/{maxChars} characters. A link to stop these texts is added at the
          end.
        </p>
      </div>
      <div className="grid content-start gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          What the customer gets
        </p>
        <div
          className="max-w-sm rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap"
          data-testid={`${id}-preview`}
        >
          {value.trim() ? preview : <span className="text-muted-foreground">Nothing to send</span>}
        </div>
        <p
          id={`${id}-meta`}
          className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
        >
          <span>{lengthSummary(length)}</span>
          {cost !== null && cost > 0 && (
            <Badge tone="outline">{formatMoney(cost, currency)} per text</Badge>
          )}
        </p>
        {problem && (
          <p role="alert" className="text-[13px] text-destructive">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
