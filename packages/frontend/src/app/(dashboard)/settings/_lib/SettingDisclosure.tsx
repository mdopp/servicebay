'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui';
import type { SettingTier } from './ia';

interface SettingDisclosureProps {
  /** Stable id — the in-page anchor target for deep links / search jumps. */
  id: string;
  /** Disclosure tier: 'essential' renders open and flat; 'advanced' collapses. */
  tier: SettingTier;
  label: string;
  children: React.ReactNode;
}

/**
 * Three-tier disclosure wrapper (#1956, feedback_ux_philosophy).
 *
 * - `essential` → rendered open, no chrome: the handful of settings people
 *   actually change are shown by default.
 * - `advanced` → collapsed behind a single click, defaults intact, the
 *   expert knob still 100% reachable (nothing removed — only relocated).
 *
 * Deep links (search "jump to it", or a `#id` href) auto-expand the matching
 * advanced item and scroll it into view, so any setting is findable by name.
 */
export default function SettingDisclosure({ id, tier, label, children }: SettingDisclosureProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(tier === 'essential');

  // Auto-expand + scroll when the URL hash targets this setting (search jump
  // or a deep link from elsewhere in the app).
  useEffect(() => {
    const applyHash = () => {
      if (typeof window === 'undefined') return;
      if (window.location.hash === `#${id}`) {
        setOpen(true);
        // Defer the scroll one frame so the expanded content has height.
        requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [id]);

  if (tier === 'essential') {
    return (
      <div ref={ref} id={id} className="scroll-mt-24">
        {children}
      </div>
    );
  }

  return (
    <Card
      ref={ref}
      id={id}
      padding="none"
      className="scroll-mt-24 overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm font-medium text-text-muted hover:bg-surface-2 hover:text-text transition-colors"
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span>{label}</span>
        <span className="ml-2 text-[10px] uppercase font-semibold tracking-wide text-text-subtle">
          Advanced
        </span>
      </button>
      {open && <div className="border-t border-border p-4 space-y-6">{children}</div>}
    </Card>
  );
}
