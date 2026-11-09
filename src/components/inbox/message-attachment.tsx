'use client';

import { FileText, ImageOff, Loader2, Mic, MicOff, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import type { MessageAttachment } from '@/lib/api/types';
import { formatClock, formatCredits } from '@/lib/format';

const PHOTO_ALT = 'Photo from the customer';

/**
 * One attachment in a chat bubble. Customers' photos are copied from Meta first, so a photo
 * shows "Saving photo…" until it is ready (the thread updates live) and the reason when it
 * could not be saved. Saved photos are private: the browser loads them with the staff
 * member's session, so they are plain <img> elements rather than optimised Next images.
 */
export function MessageAttachmentView({
  a,
  onRetryTranscript,
  retrying,
}: {
  a: MessageAttachment;
  /** Voice notes: ask again for the text (staff who can reply). */
  onRetryTranscript?: () => void;
  retrying?: boolean;
}) {
  const [broken, setBroken] = useState(false);

  if (a.kind === 'audio')
    return <VoiceNote a={a} onRetryTranscript={onRetryTranscript} retrying={retrying} />;

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

/**
 * A customer's voice note (ADR 0025): a player for the saved recording, then what
 * speech-to-text heard. The text arrives live a few seconds after the recording is saved.
 */
function VoiceNote({
  a,
  onRetryTranscript,
  retrying,
}: {
  a: MessageAttachment;
  onRetryTranscript?: (() => void) | undefined;
  retrying?: boolean | undefined;
}) {
  const [broken, setBroken] = useState(false);
  const length = a.durationMs !== null ? formatClock(a.durationMs) : null;

  if (a.status === 'pending')
    return (
      <div
        role="status"
        className="flex h-12 w-64 max-w-full items-center gap-2 rounded-lg bg-background/60 px-3 text-xs text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden /> Saving voice note…
      </div>
    );

  if (a.status === 'failed' || !a.url)
    return (
      <div className="flex max-w-64 items-start gap-2 rounded-lg border border-dashed border-current/30 px-3 py-2 text-xs opacity-80">
        <MicOff className="mt-px size-4 shrink-0" aria-hidden />
        <span>{a.error ?? 'This voice note could not be saved.'}</span>
      </div>
    );

  const t = a.transcript;
  const retry = onRetryTranscript && (
    <button
      type="button"
      onClick={onRetryTranscript}
      disabled={retrying}
      className="inline-flex items-center gap-1 font-medium underline disabled:opacity-60"
    >
      <RotateCw className={retrying ? 'size-3 animate-spin' : 'size-3'} aria-hidden />
      {t ? 'Try again' : 'Turn into text'}
    </button>
  );

  return (
    <figure className="grid w-72 max-w-full gap-1.5 whitespace-normal">
      <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Mic className="size-3.5" aria-hidden />
        Voice note{length && ` · ${length}`}
      </figcaption>
      {broken ? (
        <p className="text-xs opacity-80">
          This browser cannot play the recording.{' '}
          <a href={a.url} className="underline" download>
            Download it
          </a>
        </p>
      ) : (
        <audio
          controls
          preload="metadata"
          src={a.url}
          onError={() => setBroken(true)}
          aria-label={`Voice note from the customer${length ? `, ${length}` : ''}`}
          className="h-10 w-full"
        />
      )}
      {t?.status === 'pending' && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Turning into text…
        </p>
      )}
      {t?.status === 'done' &&
        (t.text ? (
          <blockquote className="border-l-2 border-current/30 pl-2.5">
            <p className="text-sm break-words">“{t.text}”</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Voice-to-text{t.credits !== null && ` · ${formatCredits(t.credits)}`} · may mishear
              names and numbers
            </p>
          </blockquote>
        ) : (
          <p className="text-xs text-muted-foreground">No words were heard in this recording.</p>
        ))}
      {(t?.status === 'failed' || t?.status === 'skipped') && (
        <p
          className={
            t.status === 'failed'
              ? 'flex flex-wrap items-center gap-x-2 text-xs text-destructive'
              : 'flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground'
          }
        >
          <span>{t.error ?? 'Not turned into text.'}</span>
          {retry}
        </p>
      )}
      {!t && retry && <p className="text-xs">{retry}</p>}
    </figure>
  );
}
