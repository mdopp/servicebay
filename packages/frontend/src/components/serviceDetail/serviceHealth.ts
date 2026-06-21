'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { logger, type Check, type ServiceViewModel } from '@servicebay/api-client';
import { rowStatus, type RowStatus } from '@/components/HealthChecks';

/** Strip the systemd unit suffix to get the bare service base name. */
export function serviceBaseName(service: Pick<ServiceViewModel, 'id' | 'name'>): string {
  return (service.id || service.name).replace(/\.(service|scope|socket|timer)$/, '');
}

/** Does this health check belong to the given service? Matches on the bare
 *  service name against the check's target / name (covers service, http,
 *  podman and systemd checks plus the per-service `Link:`/diagnose rows).
 *  Shared by the Operate Health tab and the shared service-detail summary so
 *  the two surfaces never disagree about which checks belong to a service. */
export function checkBelongsToService(check: Check, baseName: string): boolean {
  const needle = baseName.toLowerCase();
  const target = (check.target || '').toLowerCase();
  const name = (check.name || '').toLowerCase();
  return target === needle || target.includes(needle) || name.includes(needle);
}

export interface ServiceHealthState {
  checks: Check[];
  counts: Record<RowStatus, number>;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Loads the health checks that belong to ONE service. The single source of
 * truth for per-service health, used by both the Operate page Health tab and
 * the shared per-service detail summary (which renders in the Services list,
 * the Operate page header and the Network-map node sidebar) — so every place a
 * service is shown agrees on its health.
 */
export function useServiceHealth(service: Pick<ServiceViewModel, 'id' | 'name'>): ServiceHealthState {
  const baseName = serviceBaseName(service);
  const [checks, setChecks] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health/checks', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load health checks');
      const all: Check[] = await res.json();
      setChecks(all.filter(c => checkBelongsToService(c, baseName)));
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

  return { checks, counts, loading, reload };
}

/** Roll the per-service check counts up into one honest health dot state. */
export function overallHealth(counts: Record<RowStatus, number>): RowStatus {
  if (counts.fail > 0) return 'fail';
  if (counts.warn > 0) return 'warn';
  if (counts.ok > 0) return 'ok';
  return 'unknown';
}
