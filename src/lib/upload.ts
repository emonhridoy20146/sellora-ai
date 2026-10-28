import { api } from './api/client';

/** What the API returns for a stored file. */
export interface StoredFile {
  id: string;
  purpose: string;
  filename: string;
  contentType: string;
  size: number;
  status: 'pending' | 'ready';
  url: string | null;
  inUse: boolean;
  createdAt: string;
}

interface UploadStart {
  file: StoredFile;
  upload: { method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: string };
}

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** Width and height that fit inside `maxSide` on the longest side, keeping the shape. */
export function fitWithin(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Shrinks a phone photo before upload: at most `maxSide` pixels on the longest side, saved
 * as WebP (or JPEG where the browser cannot write WebP). Animated GIFs and photos that are
 * already small are sent as they are.
 */
export async function preparePhoto(
  file: File,
  { maxSide = 1600, quality = 0.85 }: { maxSide?: number; quality?: number } = {},
): Promise<{ blob: Blob; type: string; name: string }> {
  if (!PHOTO_TYPES.includes(file.type))
    throw new Error('Choose a JPG, PNG, WebP, GIF or AVIF photo.');
  const original = { blob: file as Blob, type: file.type, name: file.name };
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return original;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This photo could not be read. Try another one.');
  }
  const size = fitWithin(bitmap.width, bitmap.height, maxSide);
  const resized = size.width < bitmap.width;
  if (!resized && file.size < 400 * 1024) {
    bitmap.close();
    return original;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return original;
  }
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  let blob = await encode(canvas, 'image/webp', quality);
  if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', quality);
  if (!blob || (!resized && blob.size >= file.size)) return original;
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return { blob, type: blob.type, name: file.name.replace(/\.[^.]+$/, '') + `.${ext}` };
}

function put(
  target: UploadStart['upload'],
  body: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error('The upload was refused. Try again.'));
    xhr.onerror = () =>
      reject(new Error('The upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * Uploads one file: reserve space and get a link, send the bytes straight to storage, then
 * have the API check it. Returns the ready file.
 */
export async function uploadFile(
  orgId: string,
  input: { blob: Blob; type: string; name: string },
  purpose: 'product_image' | 'store_asset',
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<StoredFile> {
  const start = await api<UploadStart>(`/orgs/${orgId}/files/uploads`, {
    body: { purpose, filename: input.name, contentType: input.type, size: input.blob.size },
    signal: opts.signal,
  });
  await put(start.upload, input.blob, opts.onProgress, opts.signal);
  return api<StoredFile>(`/orgs/${orgId}/files/${start.file.id}/complete`, {
    method: 'POST',
    signal: opts.signal,
  });
}
