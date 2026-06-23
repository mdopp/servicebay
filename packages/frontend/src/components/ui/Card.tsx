import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * <Card> / <Panel> — the canonical surface primitives (#2074, epic #2071).
 *
 * Collapses the audited 10+ ad-hoc card styles (rounded-xl…p-6 shadow-sm vs
 * rounded-lg…bg-gray-800 p-4 vs border-gray-700/-800…) into ONE surface:
 * bg-surface, border-border, rounded-card, token spacing.
 *
 *  - <Card>  — a bare surface; pass children, control padding via `padding`.
 *  - <Panel> — a Card with an optional header (title + actions) over a divider.
 */

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const paddings: Record<CardPadding, string> = {
  none: '',
  sm: 'p-space-3',
  md: 'p-space-4',
  lg: 'p-space-5',
};

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { padding = 'md', className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'bg-surface border border-border rounded-card',
        paddings[padding],
        className,
      )}
      {...rest}
    />
  );
});

export interface PanelProps extends Omit<CardProps, 'title'> {
  /** Header title — string or any node. Omit for a header-less panel. */
  title?: React.ReactNode;
  /** Optional right-aligned header actions (buttons, badges). */
  actions?: React.ReactNode;
  /** Padding applied to the body region (the header keeps its own). */
  padding?: CardPadding;
}

export function Panel({
  title,
  actions,
  padding = 'md',
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <div
      className={cn(
        'bg-surface border border-border rounded-card overflow-hidden',
        className,
      )}
      {...rest}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-space-3 px-space-4 py-space-3 border-b border-border">
          {title && (
            <h3 className="text-sm font-semibold text-text truncate">{title}</h3>
          )}
          {actions && <div className="flex items-center gap-space-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={paddings[padding]}>{children}</div>
    </div>
  );
}

