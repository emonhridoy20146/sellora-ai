import { AlertTriangle, CircleCheck, CircleX, Info } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const tones = {
  info: { cls: 'bg-info-soft border-primary/20', icon: Info, iconCls: 'text-primary' },
  success: { cls: 'bg-success-soft border-success/20', icon: CircleCheck, iconCls: 'text-success' },
  warning: {
    cls: 'bg-warning-soft border-warning/25',
    icon: AlertTriangle,
    iconCls: 'text-warning',
  },
  danger: {
    cls: 'bg-danger-soft border-destructive/25',
    icon: CircleX,
    iconCls: 'text-destructive',
  },
} as const;

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
  icon,
}: {
  tone?: keyof typeof tones;
  /** Another icon in the tone's colour, when it says more than the tone's own. */
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const t = tones[tone];
  const Icon = icon ?? t.icon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border p-3.5 text-sm', t.cls, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', t.iconCls)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-foreground/80">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
