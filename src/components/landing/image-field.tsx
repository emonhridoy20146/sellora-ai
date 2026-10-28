'use client';

import { ImagePicker } from '@/components/stores/image-picker';
import { Input } from '@/components/ui/input';
import type { LandingImage } from '@/lib/api/types';

/**
 * A landing page picture: the store image picker plus a short description for people who
 * cannot see it (and for search engines).
 */
export function LandingImageField({
  orgId,
  id,
  label,
  hint,
  value,
  onChange,
  aspect,
  disabled,
}: {
  orgId: string;
  id: string;
  label: string;
  hint?: string;
  value: LandingImage | null;
  onChange: (image: LandingImage | null) => void;
  aspect?: 'wide' | 'square';
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <ImagePicker
        orgId={orgId}
        label={label}
        hint={hint}
        aspect={aspect}
        maxSide={1600}
        disabled={disabled}
        value={value ? { fileId: value.fileId, url: value.url } : null}
        onChange={(img) => onChange(img ? { ...img, alt: value?.alt ?? '' } : null)}
      />
      {value && (
        <div className="grid gap-1">
          <label htmlFor={id} className="text-xs text-muted-foreground">
            What the picture shows (for people who cannot see it)
          </label>
          <Input
            id={id}
            value={value.alt}
            maxLength={160}
            className="h-8 text-sm"
            onChange={(e) => onChange({ ...value, alt: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
