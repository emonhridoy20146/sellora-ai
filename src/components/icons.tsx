import {
  Banknote,
  Gift,
  Headphones,
  RotateCcw,
  ShieldCheck,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import type { FeatureIcon } from '@/lib/types';

export const FEATURE_ICONS: Record<FeatureIcon, LucideIcon> = {
  truck: Truck,
  cash: Banknote,
  return: RotateCcw,
  support: Headphones,
  shield: ShieldCheck,
  gift: Gift,
};

/** Brand marks for social links (simple paths; lucide has no brand icons). */
export function SocialIcon({ name }: { name: 'facebook' | 'instagram' | 'youtube' | 'tiktok' }) {
  const paths: Record<typeof name, string> = {
    facebook: 'M14 8h3V4h-3c-2.8 0-5 2.2-5 5v2H7v4h2v9h4v-9h3l1-4h-4V9c0-.6.4-1 1-1z',
    instagram:
      'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zm5 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm5.5-1.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
    youtube:
      'M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12 31 31 0 0 0 2 15.8a3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .4-3.8 31 31 0 0 0-.4-3.8zM10 15V9l5 3-5 3z',
    tiktok:
      'M16.5 3c.4 2.2 1.9 3.8 4 4v3.2c-1.5 0-2.9-.5-4-1.2v6.3a5.8 5.8 0 1 1-5.8-5.8h.6v3.3a2.6 2.6 0 1 0 2 2.5V3h3.2z',
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 fill-current">
      <path d={paths[name]} />
    </svg>
  );
}
