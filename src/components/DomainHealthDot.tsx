'use client';

/**
 * Small status dot rendered next to every public/LAN domain across the
 * app (Services overview, Network map). Driven by the auto-managed
 * `domain`-type health checks that the apex/NPM provisioner registers
 * for every entry in `config.reverseProxy.hosts`. The continuous
 * 60-s runner keeps results fresh; this component just renders them.
 *
 *   green  = last check passed
 *   red    = last check failed (with the message in the tooltip)
 *   grey   = unknown / no check registered yet (just-installed pod,
 *            checks queued but not yet executed)
 *
 * The cache is module-shared so 20 dots on the same page don't fire
 * 20 fetches — one /api/health/checks call drives every dot.
 */

import { useEffect, useState } from 'react';

interface DomainCheck {
  id: string;
  type: string;
  target: string;
  status: 'ok' | 'fail' | 'unknown';
  lastRun: string | null;
  lastResult: string | null;
  domainConfig?: { expectedScheme: 'http' | 'https'; isPublic: boolean };
}

const REFRESH_MS = 30_000;

// Module-level singleton so every <DomainHealthDot> reuses the same
// fetch + tick. The first instance starts the poll; later instances
// piggy-back on the existing state.
let cache: Map<string, DomainCheck> | null = null;
let lastFetch = 0;
let inFlight: Promise<Map<string, DomainCheck>> | null = null;
const subscribers = new Set<() => void>();

async function fetchDomainChecks(): Promise<Map<string, DomainCheck>> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch('/api/health/checks', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DomainCheck[];
      const next = new Map<string, DomainCheck>();
      for (const c of data) {
        if (c.type === 'domain') next.set(c.target, c);
      }
      cache = next;
      lastFetch = Date.now();
      for (const sub of subscribers) sub();
      return next;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function ensureFreshness(): void {
  if (!cache || Date.now() - lastFetch > REFRESH_MS) {
    // Suppress unhandled-rejection noise — a transient network blip
    // (or running under SSR / test without a base URL) just leaves
    // the cache empty for this tick; the next interval retries.
    void fetchDomainChecks().catch(() => undefined);
  }
}

export function DomainHealthDot({ domain, className = '' }: { domain: string; className?: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const sub = () => setTick(n => n + 1);
    subscribers.add(sub);
    ensureFreshness();
    const handle = setInterval(ensureFreshness, REFRESH_MS);
    return () => {
      subscribers.delete(sub);
      clearInterval(handle);
    };
  }, []);

  const check = cache?.get(domain);
  const status = check?.status ?? 'unknown';

  const colour = status === 'ok'   ? 'bg-emerald-500'
              : status === 'fail' ? 'bg-rose-500'
              :                     'bg-gray-300 dark:bg-gray-600';

  const titleParts: string[] = [];
  if (!check) {
    titleParts.push('No health check registered yet.');
  } else {
    titleParts.push(status === 'ok' ? 'Reachable' : status === 'fail' ? 'Not reachable' : 'Status unknown');
    if (check.lastResult) titleParts.push(check.lastResult);
    if (check.lastRun)    titleParts.push(`Last checked: ${new Date(check.lastRun).toLocaleString()}`);
  }
  const title = titleParts.join(' — ');

  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${colour} ${className}`}
    />
  );
}
