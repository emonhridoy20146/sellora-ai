'use client';

import { ImagePlus, Link2, RotateCw, Star, X } from 'lucide-react';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/errors';
import type { Product } from '@/lib/api/types';
import { PHOTO_TYPES, preparePhoto, uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';

export interface PhotoItem {
  key: string;
  /** Stored URL once ready; a local preview while uploading. */
  url: string;
  fileId?: string;
  alt?: string;
  state: 'ready' | 'uploading' | 'failed';
  progress?: number;
  error?: string;
  /** The picked file, kept so a failed upload can be retried. */
  source?: File;
}

export const MAX_PHOTOS = 20;

export function photosFromProduct(product?: Product): PhotoItem[] {
  return (product?.images ?? []).map((img, i) => ({
    key: `${img.fileId ?? img.url}-${i}`,
    url: img.url,
    ...(img.fileId ? { fileId: img.fileId } : {}),
    ...(img.alt ? { alt: img.alt } : {}),
    state: 'ready' as const,
  }));
}

/** The images part of a product save: uploaded photos by file id, linked ones by URL. */
export function photosPayload(items: PhotoItem[]) {
  return items
    .filter((p) => p.state === 'ready')
    .map((p) => ({
      ...(p.fileId ? { fileId: p.fileId } : { url: p.url }),
      ...(p.alt ? { alt: p.alt } : {}),
    }));
}

export function photosBusy(items: PhotoItem[]): string | null {
  if (items.some((p) => p.state === 'uploading')) return 'Wait for the photos to finish uploading.';
  if (items.some((p) => p.state === 'failed'))
    return 'Some photos did not upload. Retry or remove them.';
  return null;
}

/**
 * Product photos: pick or drop several at once (they are shrunk, then uploaded straight to
 * storage with progress), reorder by choosing the main photo, or add a link to a photo hosted
 * elsewhere.
 */
export function PhotoManager({
  orgId,
  items,
  setItems,
  disabled,
}: {
  orgId: string;
  items: PhotoItem[];
  setItems: Dispatch<SetStateAction<PhotoItem[]>>;
  disabled?: boolean;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const previews = useRef(new Set<string>());

  useEffect(() => {
    const controllers = aborts.current;
    const urls = previews.current;
    return () => {
      for (const c of controllers.values()) c.abort();
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  const patch = (key: string, next: Partial<PhotoItem>) =>
    setItems((list) => list.map((p) => (p.key === key ? { ...p, ...next } : p)));

  const run = async (key: string, source: File) => {
    const controller = new AbortController();
    aborts.current.set(key, controller);
    patch(key, { state: 'uploading', progress: 0, error: undefined });
    try {
      const prepared = await preparePhoto(source);
      const stored = await uploadFile(orgId, prepared, 'product_image', {
        signal: controller.signal,
        onProgress: (progress) => patch(key, { progress }),
      });
      patch(key, { state: 'ready', url: stored.url!, fileId: stored.id, progress: 1 });
    } catch (err) {
      if (controller.signal.aborted) return;
      patch(key, { state: 'failed', error: errorMessage(err) });
    } finally {
      aborts.current.delete(key);
    }
  };

  const addFiles = (files: File[]) => {
    setNotice(null);
    const photos = files.filter((f) => f.type.startsWith('image/'));
    if (photos.length < files.length) setNotice('Only photos can be added here.');
    const room = MAX_PHOTOS - items.length;
    if (photos.length > room) setNotice(`A product can have up to ${MAX_PHOTOS} photos.`);
    const added = photos.slice(0, Math.max(0, room)).map((source) => {
      const url = URL.createObjectURL(source);
      previews.current.add(url);
      return { key: crypto.randomUUID(), url, state: 'uploading' as const, progress: 0, source };
    });
    setItems((list) => [...list, ...added]);
    for (const item of added) void run(item.key, item.source);
  };

  const remove = (key: string) => {
    aborts.current.get(key)?.abort();
    setItems((list) => list.filter((p) => p.key !== key));
  };

  const makeMain = (key: string) =>
    setItems((list) => {
      const item = list.find((p) => p.key === key);
      return item ? [item, ...list.filter((p) => p.key !== key)] : list;
    });

  const addLink = () => {
    const url = link.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    if (!items.some((p) => p.url === url))
      setItems((list) => [...list, { key: crypto.randomUUID(), url, state: 'ready' }]);
    setLink('');
    setLinkOpen(false);
  };

  return (
    <div
      className={cn(
        'grid gap-3 rounded-lg',
        dragging && 'outline-2 outline-offset-4 outline-primary outline-dashed',
      )}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5" aria-label="Product photos">
        {items.map((p, i) => (
          <li
            key={p.key}
            className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- uploaded or merchant-linked photos */}
            <img
              src={p.url}
              alt={p.alt ?? `Photo ${i + 1}`}
              className={cn('size-full object-cover', p.state !== 'ready' && 'opacity-60')}
            />
            {i === 0 && p.state === 'ready' && (
              <span className="absolute bottom-1 left-1 rounded bg-black/65 px-1.5 text-[11px] text-white">
                Main
              </span>
            )}
            {p.state === 'uploading' && (
              <div className="absolute inset-x-2 bottom-2" role="status">
                <span className="sr-only">Uploading {Math.round((p.progress ?? 0) * 100)}%</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
                  <div
                    className="h-full rounded-full bg-white transition-[width]"
                    style={{ width: `${Math.max(5, Math.round((p.progress ?? 0) * 100))}%` }}
                  />
                </div>
              </div>
            )}
            {p.state === 'failed' && (
              <div className="absolute inset-0 grid place-content-center gap-1 bg-black/60 p-2 text-center text-[11px] text-white">
                <span title={p.error}>Upload failed</span>
                {p.source && !disabled && (
                  <button
                    type="button"
                    className="mx-auto inline-flex items-center gap-1 rounded bg-white/90 px-1.5 py-0.5 text-[11px] font-medium text-black"
                    onClick={() => void run(p.key, p.source!)}
                  >
                    <RotateCw className="size-3" aria-hidden /> Retry
                  </button>
                )}
              </div>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(p.key)}
                className="absolute top-1 right-1 rounded-full bg-black/65 p-1 text-white"
                aria-label={`Remove photo ${i + 1}`}
              >
                <X className="size-3.5" />
              </button>
            )}
            {!disabled && i > 0 && p.state === 'ready' && (
              <button
                type="button"
                onClick={() => makeMain(p.key)}
                className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[11px] text-white opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
              >
                <Star className="size-3" aria-hidden /> Make main
              </button>
            )}
          </li>
        ))}
        {!disabled && items.length < MAX_PHOTOS && (
          <li className="aspect-square">
            <label className="flex size-full cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center text-[13px] text-muted-foreground focus-within:border-primary focus-within:text-primary hover:border-primary hover:text-primary">
              <ImagePlus className="size-5" aria-hidden />
              Add photos
              <input
                type="file"
                accept={PHOTO_TYPES.join(',')}
                multiple
                className="sr-only"
                onChange={(e) => {
                  addFiles([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </label>
          </li>
        )}
      </ul>
      {notice && <p className="text-[13px] text-destructive">{notice}</p>}
      {items.some((p) => p.state === 'failed' && p.error) && (
        <p className="text-[13px] text-destructive">
          {items.find((p) => p.state === 'failed' && p.error)!.error}
        </p>
      )}
      {!disabled &&
        items.length < MAX_PHOTOS &&
        (linkOpen ? (
          <div className="flex gap-2">
            <label htmlFor="p-img" className="sr-only">
              Photo link
            </label>
            <Input
              id="p-img"
              type="url"
              autoFocus
              placeholder="https://…/photo.jpg"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addLink();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!/^https?:\/\/\S+$/i.test(link.trim())}
              onClick={addLink}
            >
              Add
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="justify-self-start px-0"
            onClick={() => setLinkOpen(true)}
          >
            <Link2 /> Add a photo from a link instead
          </Button>
        ))}
    </div>
  );
}
