'use client';

import { useEffect, useState } from 'react';

// Shape of GET /api/system/core-health. Shared by the CoreHealthBanner
// and the Home dashboard's health headline so the two can't disagree —
// the headline used to read only the twin's systemd `activeState` (a
// crash-looping-but-"active" pod counted as healthy), which contradicted
// the banner's readiness signal.

export interface CoreUnhealthyCause {
  summary: string;
  action?: { label: string; href: string };
}

export interface CoreNotReady {
  template: string;
  state: 'unhealthy' | 'unknown';
  /** Populated when a known config-side cause matches (#665 — S5). */
  cause?: CoreUnhealthyCause;
}

export interface CoreDegradedEntry {
  stack: string;
  label: string;
  notReady: CoreNotReady[];
}

const POLL_INTERVAL_MS = 15_000;

/**
 * Polls `/api/system/core-health` for `tier: core` stacks that aren't
 * ready. Returns the raw `degraded` list plus a derived view that counts
 * only stacks with a concrete `unhealthy` signal (pure `unknown` —
 * template lacks a healthcheck annotation — doesn't warrant a red
 * verdict, matching the banner's gate).
 */
export function useCoreHealth(): {
  degraded: CoreDegradedEntry[];
  unhealthy: boolean;
  labels: string[];
} {
  const [degraded, setDegraded] = useState<CoreDegradedEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/system/core-health');
        if (!res.ok) return;
        const data = (await res.json()) as { degraded?: CoreDegradedEntry[] };
        if (cancelled) return;
        setDegraded(Array.isArray(data.degraded) ? data.degraded : []);
      } catch {
        /* keep previous state */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const unhealthyEntries = degraded.filter(d => d.notReady.some(n => n.state === 'unhealthy'));
  return {
    degraded,
    unhealthy: unhealthyEntries.length > 0,
    labels: unhealthyEntries.map(d => d.label),
  };
}
