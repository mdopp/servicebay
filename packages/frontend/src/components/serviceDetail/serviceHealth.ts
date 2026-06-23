'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { logger, type Check, type ServiceViewModel } from '@servicebay/api-client';
import { rowStatus, type RowStatus } from '@/components/HealthChecks';

/** Strip the systemd unit suffix to get the bare service base name. */
export function serviceBaseName(service: Pick<ServiceViewModel, 'id' | 'name'>): string {
  return (service.id || service.name).replace(/\.(service|scope|socket|timer)$/, '');
}

/**
 * Check types that monitor the *node*, not a single service (#2080): the SSH
 * agent reachability, the gateway/router, and the Phase-3b singletons
 * (`cert_expiry`, `lan_ip_drift`, `npm_auth`, `cert_request_failure`,
 * `nginx_config_valid`, `dns_routing`). These always target `Local` or a bare
 * domain, never a service name, so they belong in the box-wide bucket.
 */
const BOX_WIDE_CHECK_TYPES = new Set<Check['type']>([
  'agent',
  'fritzbox',
  'node',
  'lan_ip_drift',
  'npm_auth',
  'cert_expiry',
  'cert_request_failure',
  'nginx_config_valid',
  'dns_routing',
  'domain',
  'letsdebug',
]);

/**
 * Is this a box-wide check (#2080) — one that monitors the node as a whole
 * rather than a single service? True for the synthetic `diagnose:<probeId>`
 * rows (backend stamps `boxWide`), the node-scoped singleton check types, and
 * any check explicitly targeting the `Local` node. Box-wide checks are never
 * force-attributed to a service; the Operate Health tab lists them in a
 * clearly-labelled "Box-wide" section so they're surfaced honestly, not hidden.
 */
export function isBoxWideCheck(check: Check): boolean {
  if (check.boxWide) return true;
  if (typeof check.id === 'string' && check.id.startsWith('diagnose:')) return true;
  if (BOX_WIDE_CHECK_TYPES.has(check.type)) return true;
  if ((check.target || '') === 'Local') return true;
  return false;
}

/**
 * Does this health check belong to the given service (#2080)? Structural,
 * not substring-guessing: a per-service check is created with
 * `target === <serviceName>` (init.ts) or the canonical `name === "Service:
 * <name>"`, and template/post-deploy probes carry `id === <svc>` /
 * `id.startsWith("<svc>-")`. Box-wide checks (diagnose probes, node
 * singletons) never belong to a service — they're surfaced separately. The
 * old loose `target.includes(needle) || name.includes(needle)` both
 * over-matched (a one-letter service swept up everything) and never caught
 * box-wide rows, which is why the tab read "1 ok". Shared by the Operate
 * Health tab and the service-detail summary so the two surfaces agree.
 */
export function checkBelongsToService(check: Check, baseName: string): boolean {
  if (isBoxWideCheck(check)) return false;
  const needle = baseName.toLowerCase();
  if (!needle) return false;
  const target = (check.target || '').toLowerCase().replace(/\.(service|scope|socket|timer)$/, '');
  const id = (check.id || '').toLowerCase();
  const name = (check.name || '').toLowerCase();
  return (
    target === needle ||
    id === needle ||
    id.startsWith(`${needle}-`) ||
    name === `service: ${needle}`
  );
}

export interface ServiceHealthState {
  /** Checks attributed to THIS service (drives the health dot + roll-up). */
  checks: Check[];
  /**
   * Box-wide checks (#2080) — diagnose probes + node singletons. Surfaced in
   * the Operate Health tab's "Box-wide" section so they're not hidden, but
   * deliberately excluded from `checks`/`counts` so one service's health dot
   * isn't dragged red by a node-wide TLS/DNS problem.
   */
  boxWideChecks: Check[];
  counts: Record<RowStatus, number>;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Loads the health checks for ONE service plus the box-wide checks (#2080).
 * The single source of truth for per-service health, used by both the Operate
 * page Health tab and the shared per-service detail summary (which renders in
 * the Services list, the Operate page header and the Network-map node sidebar)
 * — so every place a service is shown agrees on its health.
 */
export function useServiceHealth(service: Pick<ServiceViewModel, 'id' | 'name'>): ServiceHealthState {
  const baseName = serviceBaseName(service);
  const [checks, setChecks] = useState<Check[]>([]);
  const [boxWideChecks, setBoxWideChecks] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health/checks', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load health checks');
      const all: Check[] = await res.json();
      setChecks(all.filter(c => checkBelongsToService(c, baseName)));
      setBoxWideChecks(all.filter(isBoxWideCheck));
    } catch (e) {
      logger.error('useServiceHealth', 'Failed to load checks', e);
    } finally {
      setLoading(false);
    }
  }, [baseName]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async health-checks load on mount/service change
    void reload();
  }, [reload]);

  const counts = useMemo<Record<RowStatus, number>>(() => ({
    ok: checks.filter(c => rowStatus(c) === 'ok').length,
    warn: checks.filter(c => rowStatus(c) === 'warn').length,
    fail: checks.filter(c => rowStatus(c) === 'fail').length,
    unknown: checks.filter(c => rowStatus(c) === 'unknown').length,
  }), [checks]);

  return { checks, boxWideChecks, counts, loading, reload };
}

/** Roll the per-service check counts up into one honest health dot state. */
export function overallHealth(counts: Record<RowStatus, number>): RowStatus {
  if (counts.fail > 0) return 'fail';
  if (counts.warn > 0) return 'warn';
  if (counts.ok > 0) return 'ok';
  return 'unknown';
}
