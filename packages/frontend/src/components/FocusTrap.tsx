'use client';

import { useEffect, useRef, ReactNode } from 'react';

// #1090 Phase 1: focus trap for overlay dialogs.
//
// Mount-time: remember the previously-focused element, focus the first
// focusable child of the trap.
// Unmount-time: restore focus to the previously-focused element.
// Tab / Shift+Tab while mounted: cycle within the trap so keyboard
// users can't accidentally land on background controls behind the
// overlay.
//
// Phase 2 will add aria-modal + aria-label wiring at each overlay
// callsite; this component just owns the focus behaviour.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface FocusTrapProps {
  /** Whether the trap is currently active. Mounting/unmounting the
   *  component is the usual on/off; `active=false` is a per-render
   *  escape hatch for cases where the parent needs to keep the trap
   *  in the React tree but wants focus to fall through. */
  active?: boolean;
  children: ReactNode;
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  // We don't filter by visibility (offsetParent / getClientRects) because
  // jsdom returns null for those even on rendered elements — that would
  // make the trap untestable. Aria-hidden subtrees are excluded since
  // those are the conventional "don't focus me" marker in overlay code.
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(el => el.closest('[aria-hidden="true"]') === null);
}

export default function FocusTrap({ active = true, children }: FocusTrapProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;

    // Remember the element that had focus before we mounted so we can
    // restore it on unmount. document.activeElement is safe to read
    // even when nothing is focused (it falls back to <body>).
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const focusables = getFocusable(root);
    const initial = focusables[0] ?? root;
    initial.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const currentFocusables = getFocusable(root);
      if (currentFocusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = currentFocusables[0];
      const last = currentFocusables[currentFocusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (activeEl === first || !root.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !root.contains(activeEl)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    root.addEventListener('keydown', handleKeyDown);
    return () => {
      root.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [active]);

  return (
    <div ref={rootRef} tabIndex={-1} style={{ outline: 'none' }}>
      {children}
    </div>
  );
}
