'use client';

import { Activity, CheckCircle, XCircle, AlertTriangle, AlertCircle, Play, Edit, Trash2, History, Search, Wrench } from 'lucide-react';
import { Check, type NodeContainer } from '@servicebay/api-client';
import { Button } from '@/components/ui';

/** Four-way row status. Real checks are ok/fail/unknown; synthetic
 *  diagnose rows (#1423) additionally carry `warn`/`info` in their
 *  `diagnose` payload, which we surface here instead of folding warn
 *  into fail. */
export type RowStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export type StatusFilter = 'all' | RowStatus;

/** Effective row status. Diagnose rows expose their true four-way status
 *  via `check.diagnose.status` (the binary check-level status folds warn
 *  into fail); everything else uses the check's own status. */
export function rowStatus(check: Check): RowStatus {
  const d = (check as Check & { diagnose?: { status?: string } }).diagnose;
  if (d?.status) {
    // `info` probes have run and aren't failing — show them as ok-tinted
    // (the badge keeps the info nuance in the popup); warn/fail/ok pass
    // through verbatim.
    return d.status === 'info' ? 'ok' : (d.status as RowStatus);
  }
  return check.status as RowStatus;
}

/** A row is a self-diagnose probe (carries the self-repair payload). */
export function isDiagnoseRow(check: Check): boolean {
  return Boolean((check as Check & { diagnose?: unknown }).diagnose);
}

/**
 * "Last checked" cell text for a row (#1671). Synthetic diagnose rows run on
 * the daily self-diagnose cadence, not the per-minute check poll, so a raw
 * timestamp on a diagnose row reads as misleadingly "stale" next to every
 * other (60s-polled) row. Suffix the cadence so a ~20h-old self-diagnose
 * timestamp is understood as fresh-for-its-schedule rather than broken. Real
 * checks keep the plain timestamp. `Never` until the first run lands.
 */
export function lastCheckedLabel(check: Check): string {
  if (!check.lastRun) return 'Never';
  const stamp = new Date(check.lastRun).toLocaleString();
  if (isDiagnoseRow(check)) return `${stamp} (daily self-diagnose)`;
  return stamp;
}

/** Per-row status presentation (icon tint + badge background). Module-level
 *  so the row renderer stays a thin map. */
const ROW_STATUS_META: Record<RowStatus, { color: string; bg: string; Icon: typeof CheckCircle }> = {
  ok: { color: 'text-status-ok', bg: 'bg-status-ok/5', Icon: CheckCircle },
  warn: { color: 'text-status-warn', bg: 'bg-status-warn/5', Icon: AlertTriangle },
  fail: { color: 'text-status-fail', bg: 'bg-status-fail/5', Icon: XCircle },
  unknown: { color: 'text-text-subtle', bg: 'bg-surface-2', Icon: AlertCircle },
};

interface HealthChecksProps {
  checks: Check[];
  containers: NodeContainer[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (filter: StatusFilter) => void;
  handleRun: (id: string) => void;
  handleOpenModal: (check?: Check) => void;
  handleOpenDeleteModal: (id: string) => void;
  handleViewHistory: (check: Check) => void;
  /** Open the self-repair popup for a diagnose row. */
  handleOpenRepair: (check: Check) => void;
}

export default function HealthChecks({
  checks,
  containers,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  handleRun,
  handleOpenModal,
  handleOpenDeleteModal,
  handleViewHistory,
  handleOpenRepair
}: HealthChecksProps) {

  const filteredChecks = checks.filter(c => {
    const matchesSearch = searchQuery === '' ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.target.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || rowStatus(c) === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const counts = {
    ok: checks.filter(c => rowStatus(c) === 'ok').length,
    warn: checks.filter(c => rowStatus(c) === 'warn').length,
    fail: checks.filter(c => rowStatus(c) === 'fail').length,
    unknown: checks.filter(c => rowStatus(c) === 'unknown').length,
  };

  const formatLabel = (check: Check) => {
    const type = check.type;
    if (type === 'http') return 'HTTP';
    if (type === 'podman') {
      // The agent's `names` are already bare (`media-jellyfin`) — the old
      // `.substring(1)` here stripped a leading `/` that only docker's raw
      // `Names` carry, so this lookup never matched (#2782).
      const container = containers.find(c => c.names?.[0] === check.target);
      return container?.names?.[0] ?? check.target;
    }
    if (type === 'systemd') {
      return check.target;
    }
    if (type === 'service') {
      return check.target;
    }
    return check.target;
  };

  return (
    <>
      {/* Stats Overview & Filters — clickable counters that filter the
          list. Diagnose rows surface their own warn/fail (warn is no
          longer folded into fail).
          The active tiles carry no `ring-opacity-50`: Tailwind v4 dropped that
          utility (it emitted nothing here), and cn()'s tailwind-merge pass
          (#2484) read it as a ring *colour*, merging the real `ring-status-*`
          away. Use a `/50` alpha on the colour itself if the ring should fade. */}
      <div className="grid grid-cols-4 gap-2 px-2">
        <Button
            onClick={() => setStatusFilter(statusFilter === 'ok' ? 'all' : 'ok')}
            variant="ghost"
            className={`h-auto p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'ok'
                ? 'bg-status-ok/5 border-status-ok/20 ring-2 ring-status-ok'
                : 'bg-surface border-border hover:bg-surface-2'
            }`}
        >
            <div className="p-2 bg-status-ok/10 rounded-lg mb-1">
              <CheckCircle className="w-5 h-5 text-status-ok" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Healthy</p>
              <p className="text-xl font-bold text-text">{counts.ok}</p>
            </div>
        </Button>
        <Button
            onClick={() => setStatusFilter(statusFilter === 'warn' ? 'all' : 'warn')}
            variant="ghost"
            className={`h-auto p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'warn'
                ? 'bg-status-warn/5 border-status-warn/20 ring-2 ring-status-warn'
                : 'bg-surface border-border hover:bg-surface-2'
            }`}
        >
            <div className="p-2 bg-status-warn/10 rounded-lg mb-1">
              <AlertTriangle className="w-5 h-5 text-status-warn" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Warning</p>
              <p className="text-xl font-bold text-text">{counts.warn}</p>
            </div>
        </Button>
        <Button
            onClick={() => setStatusFilter(statusFilter === 'fail' ? 'all' : 'fail')}
            variant="ghost"
            className={`h-auto p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'fail'
                ? 'bg-status-fail/5 border-status-fail/20 ring-2 ring-status-fail'
                : 'bg-surface border-border hover:bg-surface-2'
            }`}
        >
            <div className="p-2 bg-status-fail/10 rounded-lg mb-1">
              <XCircle className="w-5 h-5 text-status-fail" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Failing</p>
              <p className="text-xl font-bold text-text">{counts.fail}</p>
            </div>
        </Button>
        <Button
            onClick={() => setStatusFilter(statusFilter === 'unknown' ? 'all' : 'unknown')}
            variant="ghost"
            className={`h-auto p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'unknown'
                ? 'bg-surface-2 border-border ring-2 ring-text-subtle'
                : 'bg-surface border-border hover:bg-surface-2'
            }`}
        >
            <div className="p-2 bg-text-subtle/10 rounded-lg mb-1">
              <AlertCircle className="w-5 h-5 text-text-subtle" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Unknown</p>
              <p className="text-xl font-bold text-text">{counts.unknown}</p>
            </div>
        </Button>
      </div>

      {/* Checks List */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden shadow-sm mx-2">
        {filteredChecks.length === 0 ? (
          <div className="p-8 text-center text-text-muted">
            {checks.length > 0 ? (
                <>
                    <Search className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No checks match your filters.</p>
                    <Button onClick={() => {setSearchQuery(''); setStatusFilter('all');}} variant="ghost" className="mt-2 text-accent hover:underline text-sm">
                        Clear filters
                    </Button>
                </>
            ) : (
                <>
                    <Activity className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No health checks configured.</p>
                    <Button onClick={() => handleOpenModal()} variant="ghost" className="mt-4 text-accent hover:underline text-sm">
                    Create your first check
                    </Button>
                </>
            )}
          </div>
        ) : (
          <>
            {filteredChecks.map((check, index) => {
              const isDiagnose = isDiagnoseRow(check);
              const { color: statusColor, bg: statusBg, Icon: StatusIcon } = ROW_STATUS_META[rowStatus(check)];

              return (
                <div
                    key={check.id}
                    className={`p-4 ${index !== filteredChecks.length - 1 ? 'border-b border-border' : ''} hover:bg-surface-2 transition-colors`}
                >
                    <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3 flex-1">
                            <div className={`p-2 rounded-lg ${statusBg} ${statusColor}`}>
                                <StatusIcon className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-medium text-text">{check.name}</h3>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-muted">
                                        {check.type.toUpperCase()}
                                    </span>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-status-info/5 text-status-info">
                                        {check.nodeName || 'local'}
                                    </span>
                                </div>
                                <p className="text-sm text-text-muted truncate">
                                    {formatLabel(check)}
                                </p>
                                {check.message && (
                                    <p className="text-xs text-text-subtle mt-1 line-clamp-2">
                                        {check.message}
                                    </p>
                                )}
                                <p className="text-xs text-text-subtle mt-1">
                                    Last checked: {lastCheckedLabel(check)}
                                </p>
                            </div>
                        </div>

                        {/* Sparkline Graph */}
                        {check.history && check.history.length > 0 && (
                            <div className="hidden md:flex flex-col items-end justify-center mr-4 h-full self-center">
                                <div className="h-10 w-32 flex items-end gap-[2px]">
                                    {/* Reverse history so oldest is left */}
                                    {(() => {
                                        const trend = [...check.history].slice(0, 20).reverse(); // API sends newest first
                                        const maxLat = Math.max(...trend.map(h => h.latency || 0), 100);
                                        return trend.map((h, i) => {
                                            // Scale 0-100% of height (100% = maxLat)
                                            // Min height 20%
                                            const hPercent = Math.max((h.latency / maxLat) * 100, 20);
                                            return (
                                                <div
                                                    key={i}
                                                    className={`w-1.5 rounded-sm ${h.status === 'ok' ? 'bg-status-ok/50' : 'bg-status-fail'}`}
                                                    style={{ height: `${hPercent}%` }}
                                                    title={`${h.latency}ms - ${new Date(h.timestamp).toLocaleTimeString()}`}
                                                ></div>
                                            );
                                        });
                                    })()}
                                </div>
                                <div className="text-[10px] text-text-subtle mt-1 font-mono">
                                    {check.history[0]?.latency || 0}ms
                                </div>
                            </div>
                        )}

                        <div className="flex items-center gap-1 ml-4">
                            <Button
                                onClick={() => handleRun(check.id)}
                                variant="ghost"
                                size="sm"
                                className="p-2 h-auto hover:bg-surface-2 rounded-lg transition-colors"
                                title={isDiagnose ? 'Re-run self-diagnose now' : 'Run check now'}
                            >
                                <Play className="w-4 h-4 text-text-muted" />
                            </Button>
                            {isDiagnose ? (
                                /* Synthetic diagnose row: not editable config — expose the
                                   self-repair popup instead of Edit/Delete (#1423). It still
                                   gets the History drawer (#1671): its results are persisted
                                   under the `diagnose:<id>` key just like any other check, so
                                   the same history view applies — only Edit/Delete don't. */
                                <>
                                    <Button
                                        onClick={() => handleViewHistory(check)}
                                        variant="ghost"
                                        size="sm"
                                        className="p-2 h-auto hover:bg-surface-2 rounded-lg transition-colors"
                                        title="View history"
                                    >
                                        <History className="w-4 h-4 text-text-muted" />
                                    </Button>
                                    <Button
                                        onClick={() => handleOpenRepair(check)}
                                        variant="ghost"
                                        size="sm"
                                        className="p-2 h-auto hover:bg-accent/10 rounded-lg transition-colors"
                                        title="Self-repair options"
                                    >
                                        <Wrench className="w-4 h-4 text-accent" />
                                    </Button>
                                </>
                            ) : (
                                <>
                                    <Button
                                        onClick={() => handleViewHistory(check)}
                                        variant="ghost"
                                        size="sm"
                                        className="p-2 h-auto hover:bg-surface-2 rounded-lg transition-colors"
                                        title="View history"
                                    >
                                        <History className="w-4 h-4 text-text-muted" />
                                    </Button>
                                    <Button
                                        onClick={() => handleOpenModal(check)}
                                        variant="ghost"
                                        size="sm"
                                        className="p-2 h-auto hover:bg-surface-2 rounded-lg transition-colors"
                                        title="Edit check"
                                    >
                                        <Edit className="w-4 h-4 text-text-muted" />
                                    </Button>
                                    <Button
                                        onClick={() => handleOpenDeleteModal(check.id)}
                                        variant="ghost"
                                        size="sm"
                                        className="p-2 h-auto hover:bg-surface-2 rounded-lg transition-colors"
                                        title="Delete check"
                                    >
                                        <Trash2 className="w-4 h-4 text-text-muted" />
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
