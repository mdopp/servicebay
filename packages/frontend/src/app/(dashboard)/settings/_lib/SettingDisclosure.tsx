'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui';
import type { SettingTier } from './ia';

/** Icon-chip tone — maps to a semantic token pair (bg/10 + text). */
export type DisclosureTone = 'accent' | 'warn' | 'ok' | 'fail' | 'info';

const TONE_CHIP: Record<DisclosureTone, string> = {
  accent: 'bg-accent/10 text-accent',
  warn: 'bg-status-warn/10 text-status-warn',
  ok: 'bg-status-ok/10 text-status-ok',
  fail: 'bg-status-fail/10 text-status-fail',
  info: 'bg-status-info/10 text-status-info',
};

interface SettingDisclosureProps {
  /** Stable id — the in-page anchor target for deep links / search jumps. */
  id: string;
  /** Disclosure tier: 'essential' renders open and flat; 'advanced' collapses. */
  tier: SettingTier;
  label: string;
  /** Icon shown in the section header chip (lives in the header now, not a
   *  nested inner card — #2109). */
  icon?: LucideIcon;
  /** Icon-chip tone. Defaults to 'accent'. */
  iconTone?: DisclosureTone;
  /** One-line description shown as a subline under the header title. */
  description?: React.ReactNode;
  /** Optional right-aligned header accessory (status badge, count, …) the
   *  section feeds in. Stays out of the collapse toggle hit-area. */
  headerAccessory?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Three-tier disclosure wrapper (#1956, feedback_ux_philosophy) and the SINGLE
 * settings-section container (#2109).
 *
 * The disclosure section IS the container + title: the icon, title and one-line
 * description live in this header, and the controls sit directly in the body —
 * no second nested <Card> repeating the same title (the old "box-in-box" that
 * wasted vertical space). Section components render only their controls.
 *
 * - `essential` → header + body always shown, no collapse chrome.
 * - `advanced`  → collapsed behind a single click on the header; the title
 *   carries an ADVANCED tag and a chevron. Defaults intact, knob 100% reachable.
 *
 * Deep links (search "jump to it", or a `#id` href) auto-expand the matching
 * advanced item and scroll it into view, so any setting is findable by name.
 */
export default function SettingDisclosure({
  id,
  tier,
  label,
  icon: Icon,
  iconTone = 'accent',
  description,
  headerAccessory,
  children,
}: SettingDisclosureProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(tier === 'essential');
  const advanced = tier === 'advanced';

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

  const chip = Icon ? (
    <div className={`p-2 rounded-card shrink-0 ${TONE_CHIP[iconTone]}`}>
      <Icon size={20} />
    </div>
  ) : null;

  const heading = (
    <div className="flex-1 min-w-0">
      <h3 className="font-semibold text-text flex items-center gap-space-2">
        {label}
        {advanced && (
          <span className="text-[10px] uppercase font-semibold tracking-wide text-text-subtle">
            Advanced
          </span>
        )}
      </h3>
      {description && <p className="text-xs text-text-muted">{description}</p>}
    </div>
  );

  const bodyClass = 'p-space-5 space-y-6';

  // Essential: a single open Card — header (icon+title+desc) over the body, one
  // border, no collapse chrome.
  if (!advanced) {
    return (
      <Card ref={ref} id={id} padding="none" className="w-full overflow-hidden scroll-mt-24">
        {(chip || description || headerAccessory) && (
          <div className="flex items-center gap-space-3 px-space-4 py-space-3 border-b border-border bg-surface-2">
            {chip}
            {heading}
            {headerAccessory && <div className="shrink-0">{headerAccessory}</div>}
          </div>
        )}
        <div className={bodyClass}>{children}</div>
      </Card>
    );
  }

  // Advanced: the same single Card, but the header is a collapse toggle.
  return (
    <Card ref={ref} id={id} padding="none" className="w-full overflow-hidden scroll-mt-24">
      <div className={`flex items-center bg-surface-2 ${open ? 'border-b border-border' : ''}`}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="flex-1 flex items-center gap-space-3 px-space-4 py-space-3 text-left hover:bg-surface-muted transition-colors"
        >
          <span className="shrink-0 text-text-muted">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          {chip}
          {heading}
        </button>
        {headerAccessory && <div className="shrink-0 pr-space-4">{headerAccessory}</div>}
      </div>
      {open && <div className={bodyClass}>{children}</div>}
    </Card>
  );
}
