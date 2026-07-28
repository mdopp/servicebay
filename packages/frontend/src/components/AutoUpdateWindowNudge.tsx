'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { Card } from '@/components/ui';

/**
 * "Your services are not auto-updating yet" nudge (#2396).
 *
 * ServiceBay has TWO completely separate update mechanisms, and nothing in the
 * UI used to say so:
 *
 *   1. The ServiceBay app updater — the "ServiceBay Updates" card this banner
 *      sits under (`GET/POST /api/system/update`, `config.autoUpdate`). It is
 *      about the ServiceBay image itself and is NOT gated by the update window.
 *   2. Per-service container image refresh — `podman-auto-update.timer`, which
 *      `lib/updateWindow.ts:applyLocks()` deliberately MASKS until the operator
 *      saves an update window (`config.updateWindow`). That lock is the defence
 *      against "the host auto-updated and rebooted mid-install with the USB
 *      stick still in". See config.ts:updateWindow for the state machine.
 *
 * Operators read "Auto-Updates: on" on the ServiceBay card and reasonably
 * conclude their Ollama/Jellyfin/... containers are being refreshed too. They
 * are not. This banner says so in one place they cannot miss, and points at the
 * one setting that changes it.
 *
 * It changes NO behaviour — `applyLocks()` and the opt-in default are untouched;
 * this is visibility around them.
 *
 * Visibility rule (mirrors the config state machine exactly, so we inform once
 * and then get out of the way):
 *   - `window === null` (field absent — the operator has never decided) → show.
 *   - any saved window, INCLUDING `{ enabled: false }` (an explicit opt-out) →
 *     hide. Once they have been to the page and chosen, nagging is noise.
 *   - read failed / still loading → show nothing (a fetch blip must not
 *     manufacture a warning).
 */

type NudgeState = 'unknown' | 'configured' | 'unconfigured';

export const UPDATE_WINDOW_SETTINGS_HREF = '/settings/system#update-window';

/** Read `config.updateWindow` via the settings page's own GET route. Stays
 *  'unknown' (→ renders nothing) while in flight and on any read failure. */
function useUpdateWindowState(): NudgeState {
  const [state, setState] = useState<NudgeState>('unknown');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/update-window');
        if (!res.ok) return;
        const data = (await res.json()) as { window?: unknown };
        if (cancelled) return;
        setState(data?.window ? 'configured' : 'unconfigured');
      } catch (error) {
        // Background read — stay silent rather than surfacing a transient
        // failure as "your services aren't updating".
        console.error('[AutoUpdateWindowNudge] Failed to read the update window', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export default function AutoUpdateWindowNudge() {
  const state = useUpdateWindowState();
  if (state !== 'unconfigured') return null;

  return (
    <Card padding="md" className="border-status-warn/40 bg-status-warn/5">
      <div className="flex items-start gap-space-3">
        <div className="shrink-0 rounded-card bg-status-warn/10 p-1.5 text-status-warn">
          <CalendarClock size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text">
            Your services are not auto-updating yet
          </h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Container image auto-update is locked until you pick a maintenance window, so a
            service can never restart itself at a random moment. Until then a service pinned to a
            rolling tag like <span className="font-mono">:latest</span> (Ollama, Jellyfin, …) keeps
            running the image it was deployed with — you update it by re-deploying it yourself.
          </p>
          <p className="mt-space-2 text-xs text-text-muted">
            <strong className="font-semibold text-text">This is separate from ServiceBay&apos;s own
            updates.</strong>{' '}
            The ServiceBay Updates card covers the ServiceBay app itself and is not affected by the
            window — so &ldquo;ServiceBay is up to date&rdquo; does not mean your services are.
          </p>
          <Link
            href={UPDATE_WINDOW_SETTINGS_HREF}
            className="mt-space-2 inline-flex items-center text-xs font-medium text-accent underline underline-offset-2 hover:text-accent-strong"
          >
            Choose an auto-update window in Settings → System
          </Link>
        </div>
      </div>
    </Card>
  );
}
