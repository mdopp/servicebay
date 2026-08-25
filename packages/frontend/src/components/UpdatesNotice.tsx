'use client';

import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/components/ui';

/**
 * Collapsible "something is waiting for you" notice (#2604).
 *
 * The Services page stacks update notices above the list. On a desktop that
 * reads as informative; on a phone the stack — a header line plus one row per
 * pending upgrade, each with its own button — filled the screen before the
 * first service appeared, and it grows with every pending upgrade.
 *
 * The shape this settles on: the **summary line is always visible** (it
 * carries the count, so nothing is hidden), the detail rows collapse behind
 * it, and the default follows the viewport — collapsed below `md`, expanded
 * from `md` up, so the desktop reading is unchanged. The viewport default is
 * read through `matchMedia` rather than a CSS `md:` utility so the toggle and
 * `aria-expanded` can never disagree with what is on screen; it re-resolves on
 * resize.
 *
 * Deliberately **not** a dismiss: a notice that can be closed away is a
 * pending update the operator may never see again. Collapsing keeps the
 * summary — and therefore the count — on screen.
 */
const WIDE_QUERY = '(min-width: 768px)';

function subscribeWide(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function readWide(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(WIDE_QUERY).matches;
}

export interface UpdatesNoticeProps {
  /** One-line roll-up — always visible, collapsed or not. Carries the count. */
  title: ReactNode;
  /** Leading status icon. */
  icon?: ReactNode;
  /** Primary action kept in the summary row so it stays reachable collapsed. */
  action?: ReactNode;
  /** Detail rows; rendered only while expanded. */
  children: ReactNode;
  /** Extra classes for the notice surface (tone tint lives with the caller). */
  className?: string;
  /**
   * Start collapsed even on a wide viewport — the persisted "I've seen this"
   * choice. It only changes the *default*; the summary line still renders.
   */
  defaultCollapsed?: boolean;
  /** Called with the new open state whenever the operator toggles. */
  onToggle?: (open: boolean) => void;
  'data-testid'?: string;
}

export default function UpdatesNotice({
  title,
  icon,
  action,
  children,
  className,
  defaultCollapsed = false,
  onToggle,
  'data-testid': testId = 'updates-notice',
}: UpdatesNoticeProps) {
  const isWide = useSyncExternalStore(subscribeWide, readWide, () => false);
  const [override, setOverride] = useState<boolean | null>(null);
  const detailId = useId();

  const open = override ?? (isWide && !defaultCollapsed);

  const toggle = () => {
    const next = !open;
    setOverride(next);
    onToggle?.(next);
  };

  return (
    <div className={cn('rounded-card border', className)} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-space-2 p-space-3">
        {icon ? <span className="shrink-0">{icon}</span> : null}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={detailId}
          data-testid={`${testId}-toggle`}
          title={open ? 'Hide the details' : 'Show the details'}
          className="flex min-w-0 flex-1 items-center gap-space-2 text-left text-sm font-semibold text-text"
        >
          <span className="min-w-0">{title}</span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={cn('ml-auto shrink-0 text-text-muted transition-transform', open && 'rotate-180')}
          />
        </button>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {open && (
        <div id={detailId} data-testid={`${testId}-detail`} className="px-space-3 pb-space-3">
          {children}
        </div>
      )}
    </div>
  );
}
