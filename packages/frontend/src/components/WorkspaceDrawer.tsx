'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Resizable side drawer (#804 — foundation).
 *
 * The first landing of this primitive replaces inline drawer JSX
 * across the codebase (service edit/monitor in useServiceActions,
 * container logs/terminal pages) with a single reusable component.
 * The follow-up commits enable the more interesting half:
 *
 *   - `width='wide'`, `hasBackdrop` (default) — the existing visual,
 *     shipping today. Safe; no behaviour change.
 *   - `width='standard'` (~max-w-2xl) — narrower drawer for simple
 *     detail panes. Add per-surface once visual QA confirms the
 *     content reflows cleanly.
 *   - `width='full'` — wraps the surface with no left margin so
 *     wizards / merge tools that previously hijacked the whole
 *     screen can use one consistent chrome.
 *   - `hasBackdrop={false}` — non-blocking split-screen mode where
 *     the main page remains scrollable on the left while observation
 *     surfaces (logs, self-test) stream on the right. Enabled
 *     per-surface; sticky destructive modals (#804 acceptance) keep
 *     the blocking backdrop.
 *
 * Cubic-bezier transition class is included for forward compat with
 * width morphing in a later PR — today the width is fixed per
 * mount, so the transition is a no-op visually.
 */

export type WorkspaceDrawerWidth = 'standard' | 'wide' | 'full';

interface WorkspaceDrawerProps {
  /** Closed → unmount. The parent owns the state. */
  isOpen: boolean;
  onClose: () => void;
  /** Header block rendered above the body — title, status pills,
   *  badge chips, etc. The close button is rendered by the drawer
   *  itself; do not include a close affordance here. */
  header: ReactNode;
  children: ReactNode;
  /** Default: `'wide'` (`max-w-6xl` — same as the legacy inline
   *  drawer). `'standard'` ≈ `max-w-2xl` for short detail panes.
   *  `'full'` removes the left margin entirely. */
  width?: WorkspaceDrawerWidth;
  /** When false, no dimming backdrop is rendered — the main page on
   *  the left remains interactive. Defaults to true so callers
   *  migrate without behaviour change. Destructive confirms must
   *  keep this true. */
  hasBackdrop?: boolean;
  /** Optional aria-label for the close button; defaults to "Close
   *  drawer". */
  closeAriaLabel?: string;
}

const widthClass: Record<WorkspaceDrawerWidth, string> = {
  standard: 'max-w-2xl',
  wide: 'max-w-6xl',
  full: '',
};

export default function WorkspaceDrawer({
  isOpen,
  onClose,
  header,
  children,
  width = 'wide',
  hasBackdrop = true,
  closeAriaLabel = 'Close drawer',
}: WorkspaceDrawerProps) {
  if (!isOpen) return null;

  // Backdrop variant — fixed overlay with a dim layer that blocks the
  // main page. Non-backdrop variant — same fixed positioning but no
  // dim and `pointer-events-none` on the wrapper so clicks fall
  // through to the page behind; the panel itself re-enables pointer
  // events so it stays interactive.
  const wrapperClass = hasBackdrop
    ? 'fixed inset-0 z-[70] flex justify-end bg-gray-950/70 backdrop-blur-sm'
    : 'fixed inset-0 z-[70] flex justify-end pointer-events-none';
  const panelExtraClass = hasBackdrop ? '' : 'pointer-events-auto';

  return (
    <div className={wrapperClass}>
      <div
        className={`w-full ${widthClass[width]} h-full bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl flex flex-col transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${panelExtraClass}`}
      >
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
          <div className="min-w-0">{header}</div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-800 shrink-0"
            aria-label={closeAriaLabel}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
