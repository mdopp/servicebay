import { cn } from './cn';

/**
 * <StatusDot> — the canonical health/status indicator dot (#2076, epic #2071).
 *
 * One dot, four states, all on status tokens (no ad-hoc green-500/red-400…).
 * Carries an accessible label: a visually-hidden text plus role="status" so a
 * screen reader announces the state, not just a coloured circle.
 */
export type StatusState = 'ok' | 'warn' | 'fail' | 'unknown';

const colors: Record<StatusState, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  fail: 'bg-status-fail',
  unknown: 'bg-text-subtle',
};

const defaultLabels: Record<StatusState, string> = {
  ok: 'OK',
  warn: 'Warning',
  fail: 'Failed',
  unknown: 'Unknown',
};

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  state: StatusState;
  /** Accessible label; defaults to a human-readable name for the state. */
  label?: string;
  /** Render the label text next to the dot (otherwise it's SR-only). */
  showLabel?: boolean;
}

export function StatusDot({
  state,
  label,
  showLabel = false,
  className,
  ...rest
}: StatusDotProps) {
  const text = label ?? defaultLabels[state];
  return (
    <span
      role="status"
      data-state={state}
      className={cn('inline-flex items-center gap-space-2', className)}
      {...rest}
    >
      <span className={cn('inline-block h-2 w-2 rounded-chip shrink-0', colors[state])} aria-hidden="true" />
      {showLabel ? (
        <span className="text-xs text-text-muted">{text}</span>
      ) : (
        <span className="sr-only">{text}</span>
      )}
    </span>
  );
}

