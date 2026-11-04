'use client';

import { useState } from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogFooter } from './dialog';
import { Field } from './field';
import { Textarea } from './input';

/**
 * Asks before an action. With `reason`, the person must write why (the API records it in
 * the audit log). `onConfirm` may throw; the dialog then stays open.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  reason,
  reasonLabel = 'Reason',
  reasonMin = 3,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  reason?: boolean;
  reasonLabel?: string;
  reasonMin?: number;
  onConfirm: (reason: string) => Promise<unknown> | void;
  children?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const invalid = reason && text.trim().length < reasonMin;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setText('');
        onOpenChange(o);
      }}
    >
      <DialogContent title={title} description={description}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (invalid) return;
            setBusy(true);
            Promise.resolve(onConfirm(text.trim()))
              .then(() => {
                setText('');
                onOpenChange(false);
              })
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        >
          {children}
          {reason && (
            <Field label={reasonLabel} htmlFor="confirm-reason" hint="Saved in the audit log.">
              <Textarea
                id="confirm-reason"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                required
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              loading={busy}
              disabled={invalid}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
