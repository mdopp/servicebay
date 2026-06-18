'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle, XCircle, AlertTriangle, AlertCircle, Play, RefreshCw } from 'lucide-react';
import { logger, type Check, type ServiceViewModel } from '@servicebay/api-client';
import { rowStatus, lastCheckedLabel, type RowStatus } from '@/components/HealthChecks';

const ROW_META: Record<RowStatus, { color: string; bg: string; Icon: typeof CheckCircle }> = {
  ok: { color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-900/20', Icon: CheckCircle },
  warn: { color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', Icon: AlertTriangle },
  fail: { color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-900/20', Icon: XCircle },
  unknown: { color: 'text-gray-400', bg: 'bg-gray-50 dark:bg-gray-800', Icon: AlertCircle },
};

/** Does this health check belong to the given service? Matches on the bare
 *  service name against the check's target / name (covers service, http,
 *  podman and systemd checks plus the per-service `Link:`/diagnose rows). */
function checkBelongsToService(check: Check, baseName: string): boolean {
  const needle = baseName.toLowerCase();
  const target = (check.target || '').toLowerCase();
  const name = (check.name || '').toLowerCase();
  return target === needle || target.includes(needle) || name.includes(needle);
}

/**
 * Health tab of a service's Operate page (#1957). Co-locates the service's
 * health checks + daily self-diagnose rows with its Settings and Actions,
 * merging the diagnose/health surface (project_diagnose_health_rework) into
 * the per-service page rather than a global health dashboard.
 */
export default function OperateHealthTab({ service }: { service: ServiceViewModel }) {
  const baseName = (service.id || service.name).replace(/\.(service|scope|socket|timer)$/, '');
  const [checks, setChecks] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health/checks', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load health checks');
      const all: Check[] = await res.json();
      setChecks(all.filter(c => checkBelongsToService(c, baseName)));
    } catch (e) {
      logger.error('OperateHealthTab', 'Failed to load checks', e);
    } finally {
      setLoading(false);
    }
  }, [baseName]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async health-checks load on mount/service change
    void load();
  }, [load]);

  const handleRun = useCallback(async (id: string) => {
    setRunning(id);
    try {
      await fetch(`/api/health/checks/${id}/run`, { method: 'POST' });
      await load();
    } catch (e) {
      logger.error('OperateHealthTab', 'Failed to run check', e);
    } finally {
      setRunning(null);
    }
  }, [load]);

  const counts = useMemo(() => ({
    ok: checks.filter(c => rowStatus(c) === 'ok').length,
    warn: checks.filter(c => rowStatus(c) === 'warn').length,
    fail: checks.filter(c => rowStatus(c) === 'fail').length,
    unknown: checks.filter(c => rowStatus(c) === 'unknown').length,
  }), [checks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-gray-500">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading health…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-sm">
          <span className="text-green-600 dark:text-green-400 font-medium">{counts.ok} healthy</span>
          {counts.warn > 0 && <span className="text-amber-600 dark:text-amber-400 font-medium">{counts.warn} warning</span>}
          {counts.fail > 0 && <span className="text-red-600 dark:text-red-400 font-medium">{counts.fail} failing</span>}
          {counts.unknown > 0 && <span className="text-gray-500 font-medium">{counts.unknown} unknown</span>}
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
          title="Refresh health"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {checks.length === 0 ? (
        <div className="p-8 text-center text-gray-500 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
          <Activity className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p>No health checks for this service yet.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          {checks.map((check, i) => (
            <CheckRow
              key={check.id}
              check={check}
              last={i === checks.length - 1}
              running={running === check.id}
              onRun={() => handleRun(check.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CheckRow({ check, last, running, onRun }: { check: Check; last: boolean; running: boolean; onRun: () => void }) {
  const { color, bg, Icon } = ROW_META[rowStatus(check)];
  return (
    <div className={`p-4 flex items-start justify-between gap-3 ${last ? '' : 'border-b border-gray-200 dark:border-gray-800'}`}>
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className={`p-2 rounded-lg ${bg} ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-gray-900 dark:text-white truncate">{check.name}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
              {check.type.toUpperCase()}
            </span>
          </div>
          {check.message && <p className="text-xs text-gray-500 dark:text-gray-500 mt-1 line-clamp-2">{check.message}</p>}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Last checked: {lastCheckedLabel(check)}</p>
        </div>
      </div>
      <button
        onClick={onRun}
        disabled={running}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
        title="Run check now"
      >
        {running
          ? <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
          : <Play className="w-4 h-4 text-gray-600 dark:text-gray-400" />}
      </button>
    </div>
  );
}
