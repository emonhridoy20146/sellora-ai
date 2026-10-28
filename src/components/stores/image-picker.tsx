'use client';

import { ImagePlus, Loader2, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/errors';
import type { StoreImage } from '@/lib/api/types';
import { PHOTO_TYPES, preparePhoto, uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';

/**
 * One store picture (logo, hero or banner): pick a file, it is shrunk and uploaded straight
 * to storage, and the result goes into the design. The design save attaches it to the store;
 * a picture removed before saving is cleaned up by the storage sweep.
 */
export function ImagePicker({
  orgId,
  label,
  hint,
  value,
  onChange,
  maxSide = 1600,
  aspect = 'wide',
  disabled,
}: {
  orgId: string;
  label: string;
  hint?: string;
  value: StoreImage | null;
  onChange: (image: StoreImage | null) => void;
  maxSide?: number;
  aspect?: 'wide' | 'square';
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File) => {
    setError(null);
    setProgress(0);
    try {
      const prepared = await preparePhoto(file, { maxSide });
      const stored = await uploadFile(orgId, prepared, 'store_asset', { onProgress: setProgress });
      if (!stored.url) throw new Error('The picture was saved but has no address yet. Try again.');
      onChange({ fileId: stored.id, url: stored.url });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="grid gap-1.5">
      <span id={`${id}-label`} className="text-sm font-medium">
        {label}
      </span>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'relative flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted',
            aspect === 'square' ? 'size-16' : 'h-16 w-28',
          )}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.url} alt="" className="size-full object-cover" />
          ) : (
            <ImagePlus className="size-5 text-muted-foreground" aria-hidden />
          )}
          {progress !== null && (
            <span className="absolute inset-0 flex items-center justify-center bg-background/70">
              <Loader2 className="size-4 animate-spin" aria-label="Uploading" />
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || progress !== null}
            aria-describedby={`${id}-label`}
            onClick={() => input.current?.click()}
          >
            {value ? 'Change' : 'Upload'}
          </Button>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || progress !== null}
              onClick={() => onChange(null)}
            >
              <X /> Remove
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept={PHOTO_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-labelledby={`${id}-label`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void pick(file);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
