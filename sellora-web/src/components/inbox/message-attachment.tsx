'use client';

import { FileText, ImageOff, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import type { MessageAttachment } from '@/lib/api/types';

const PHOTO_ALT = 'Photo from the customer';

/**
 * One attachment in a chat bubble. Customers' photos are copied from Meta first, so a photo
 * shows "Saving photo…" until it is ready (the thread updates live) and the reason when it
 * could not be saved. Saved photos are private: the browser loads them with the staff
 * member's session, so they are plain <img> elements rather than optimised Next images.
 */
export function MessageAttachmentView({ a }: { a: MessageAttachment }) {
  const [broken, setBroken] = useState(false);

  if (a.status === 'pending')
    return (
      <div
        role="status"
        className="flex h-28 w-44 items-center justify-center gap-2 rounded-lg bg-background/60 text-xs text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden /> Saving photo…
      </div>
    );

  if (a.status === 'failed' || !a.url || broken)
    return (
      <div className="flex max-w-64 items-start gap-2 rounded-lg border border-dashed border-current/30 px-3 py-2 text-xs opacity-80">
        <ImageOff className="mt-px size-4 shrink-0" aria-hidden />
        <span>{a.error ?? 'This photo could not be shown.'}</span>
      </div>
    );

  if (!a.contentType?.startsWith('image/'))
    return (
      <a
        href={a.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1.5 underline"
      >
        <FileText className="size-4 shrink-0" aria-hidden /> {a.name ?? 'File'}
      </a>
    );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Open photo"
          className="block overflow-hidden rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- private, session-authenticated photo */}
          <img
            src={a.url}
            alt={PHOTO_ALT}
            loading="lazy"
            onError={() => setBroken(true)}
            className="max-h-64 max-w-full object-cover"
          />
        </button>
      </DialogTrigger>
      <DialogContent title={PHOTO_ALT} wide>
        {/* eslint-disable-next-line @next/next/no-img-element -- private, session-authenticated photo */}
        <img
          src={a.url}
          alt={PHOTO_ALT}
          className="max-h-[70vh] w-full rounded-md bg-muted object-contain"
        />
        <a href={a.url} target="_blank" rel="noreferrer" className="text-sm underline">
          Open full size
        </a>
      </DialogContent>
    </Dialog>
  );
}
