'use client';

import { useCallback, useState } from 'react';
import { Activity, Play, RefreshCw } from 'lucide-react';
import { logger, type Check, type ServiceViewModel } from '@servicebay/api-client';
import { rowStatus, lastCheckedLabel, type RowStatus } from '@/components/HealthChecks';
import { useServiceHealth } from '@/components/serviceDetail/serviceHealth';
import { Badge, Button, Card, SectionHeading, StatusDot, type StatusState } from '@/components/ui';

// rowStatus already yields ok | warn | fail | unknown — the StatusDot state set.
const STATUS_STATE: Record<RowStatus, StatusState> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  unknown: 'unknown',
};

/**
 * Health tab of a service's Operate page (#1957). Co-locates the service's
 * health checks + daily self-diagnose rows with its Settings and Actions,
 * merging the diagnose/health surface (project_diagnose_health_rework) into
 * the per-service page rather than a global health dashboard.
 */
export default function OperateHealthTab({ service }: { service: ServiceViewModel }) {
  const { checks, boxWideChecks, counts, loading, reload: load } = useServiceHealth(service);
  const [running, setRunning] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-text-muted">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading health…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="ok">{counts.ok} healthy</Badge>
          {counts.warn > 0 && <Badge variant="warn">{counts.warn} warning</Badge>}
          {counts.fail > 0 && <Badge variant="fail">{counts.fail} failing</Badge>}
          {counts.unknown > 0 && <Badge variant="neutral">{counts.unknown} unknown</Badge>}
        </div>
        <Button variant="ghost" size="sm" onClick={load} title="Refresh health">
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      {checks.length === 0 ? (
        <Card padding="lg" className="text-center text-text-muted">
          <Activity className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p>No service-specific health checks yet.</p>
          {boxWideChecks.length > 0 && (
            <p className="text-xs mt-1">Box-wide diagnostics for this node are listed below.</p>
          )}
        </Card>
      ) : (
        <CheckList checks={checks} running={running} onRun={handleRun} />
      )}

      <BoxWideSection checks={boxWideChecks} serviceName={service.displayName} running={running} onRun={handleRun} />
    </div>
  );
}

/** A bordered card listing a set of check rows. Shared by the service-specific
 *  list and the box-wide section so both render identically (#2080). */
function CheckList({ checks, running, onRun }: { checks: Check[]; running: string | null; onRun: (id: string) => void }) {
  return (
    <Card padding="none" className="overflow-hidden">
      {checks.map((check, i) => (
        <CheckRow
          key={check.id}
          check={check}
          last={i === checks.length - 1}
          running={running === check.id}
          onRun={() => onRun(check.id)}
        />
      ))}
    </Card>
  );
}

/**
 * Box-wide diagnostics (#2080) — diagnose probes + node singletons — in a
 * clearly-labelled section rather than dropped. They used to silently vanish
 * from every per-service tab because their `target` never substring-matched a
 * service name (the "1 ok" symptom). They monitor the whole node, so they're
 * separated from this service's own checks.
 */
function BoxWideSection({
  checks,
  serviceName,
  running,
  onRun,
}: {
  checks: Check[];
  serviceName: string;
  running: string | null;
  onRun: (id: string) => void;
}) {
  if (checks.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Box-wide health checks">
      <SectionHeading description={`Monitor the whole node, not just ${serviceName}`}>
        Box-wide checks
      </SectionHeading>
      <CheckList checks={checks} running={running} onRun={onRun} />
    </section>
  );
}

function CheckRow({ check, last, running, onRun }: { check: Check; last: boolean; running: boolean; onRun: () => void }) {
  const state = STATUS_STATE[rowStatus(check)];
  return (
    <div className={`p-space-4 flex items-start justify-between gap-3 ${last ? '' : 'border-b border-border'}`}>
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <StatusDot state={state} className="mt-1.5" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-text truncate">{check.name}</h3>
            <Badge variant="neutral">{check.type.toUpperCase()}</Badge>
          </div>
          {check.message && <p className="text-xs text-text-muted mt-1 line-clamp-2">{check.message}</p>}
          <p className="text-xs text-text-subtle mt-1">Last checked: {lastCheckedLabel(check)}</p>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onRun} disabled={running} title="Run check now" aria-label="Run check now">
        {running
          ? <RefreshCw className="w-4 h-4 animate-spin" />
          : <Play className="w-4 h-4" />}
      </Button>
    </div>
  );
}
