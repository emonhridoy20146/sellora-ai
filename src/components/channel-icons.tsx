import { Globe } from 'lucide-react';
import type { SVGProps } from 'react';
import type { ChannelType } from '@/lib/api/types';
import { CHANNEL_LABEL } from '@/lib/inbox';
import { cn } from '@/lib/utils';

/**
 * Simple line glyphs for the social channels, drawn to match the lucide icons used
 * elsewhere (24 × 24, 2 px strokes, currentColor). They hint at each app; they are not
 * the companies' logos.
 */
function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export function MessengerGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M12 3c-5 0-9 3.7-9 8.3 0 2.6 1.3 4.9 3.3 6.4V21l3-1.7c.9.3 1.8.4 2.7.4 5 0 9-3.7 9-8.4S17 3 12 3Z" />
      <path d="m7.5 13.5 3-3.2 2.2 1.9 3.8-2.2-3 3.2-2.2-1.9z" />
    </Glyph>
  );
}

export function InstagramGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </Glyph>
  );
}

export function WhatsAppGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M3.5 20.5 5 16a8.5 8.5 0 1 1 3 3z" />
      <path d="M9 8.6c0 3.4 3 6.4 6.4 6.4l1-1.4-2-1-1 .7a4.7 4.7 0 0 1-2.7-2.7l.7-1-1-2z" />
    </Glyph>
  );
}

export function ChannelGlyph({
  type,
  className,
  label = false,
}: {
  type: ChannelType;
  className?: string;
  /** Announce the channel's name to screen readers. */
  label?: boolean;
}) {
  const a11y = label ? { 'aria-label': CHANNEL_LABEL[type], role: 'img' } : { 'aria-hidden': true };
  const cls = cn('size-5 shrink-0', className);
  switch (type) {
    case 'messenger':
      return <MessengerGlyph className={cls} {...a11y} />;
    case 'instagram':
      return <InstagramGlyph className={cls} {...a11y} />;
    case 'whatsapp':
      return <WhatsAppGlyph className={cls} {...a11y} />;
    case 'web_chat':
      return <Globe className={cls} {...a11y} />;
  }
}
