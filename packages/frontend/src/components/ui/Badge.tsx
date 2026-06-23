import { cn } from './cn';

/**
 * <Badge> — small status/label chip (#2076, epic #2071).
 *
 * Replaces the audited 27 ad-hoc badge styles with one chip wired to the
 * status/accent tokens. Tinted-fill on a translucent status colour so it
 * reads on both the dark default and the light theme.
 */
export type BadgeVariant = 'neutral' | 'ok' | 'warn' | 'fail' | 'info' | 'accent';

const variants: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-2 text-text-muted border border-border',
  ok: 'bg-status-ok/10 text-status-ok border border-status-ok/20',
  warn: 'bg-status-warn/10 text-status-warn border border-status-warn/20',
  fail: 'bg-status-fail/10 text-status-fail border border-status-fail/20',
  info: 'bg-status-info/10 text-status-info border border-status-info/20',
  accent: 'bg-accent/10 text-accent border border-accent/20',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span
      data-variant={variant}
      className={cn(
        'inline-flex items-center gap-space-1 rounded-chip px-space-2 py-px text-xs font-medium',
        variants[variant],
        className,
      )}
      {...rest}
    />
  );
}

