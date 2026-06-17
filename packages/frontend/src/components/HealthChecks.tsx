'use client';

import { Activity, CheckCircle, XCircle, AlertTriangle, AlertCircle, Play, Edit, Trash2, History, Search, Wrench } from 'lucide-react';
import { Check } from '@servicebay/api-client';

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
  ok: { color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-900/20', Icon: CheckCircle },
  warn: { color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', Icon: AlertTriangle },
  fail: { color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-900/20', Icon: XCircle },
  unknown: { color: 'text-gray-400', bg: 'bg-gray-50 dark:bg-gray-800', Icon: AlertCircle },
};

interface HealthChecksProps {
  checks: Check[];
  containers: { Id: string; Names: string[]; Image: string }[];
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
      const container = containers.find(c => c.Names[0].substring(1) === check.target);
      return container ? container.Names[0].substring(1) : check.target;
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
          longer folded into fail). */}
      <div className="grid grid-cols-4 gap-2 px-2">
        <button
            onClick={() => setStatusFilter(statusFilter === 'ok' ? 'all' : 'ok')}
            className={`p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'ok'
                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 ring-2 ring-green-500 ring-opacity-50'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
            }`}
        >
            <div className="p-2 bg-green-500/10 rounded-lg mb-1">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Healthy</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{counts.ok}</p>
            </div>
        </button>
        <button
            onClick={() => setStatusFilter(statusFilter === 'warn' ? 'all' : 'warn')}
            className={`p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'warn'
                ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 ring-2 ring-amber-500 ring-opacity-50'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
            }`}
        >
            <div className="p-2 bg-amber-500/10 rounded-lg mb-1">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Warning</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{counts.warn}</p>
            </div>
        </button>
        <button
            onClick={() => setStatusFilter(statusFilter === 'fail' ? 'all' : 'fail')}
            className={`p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'fail'
                ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 ring-2 ring-red-500 ring-opacity-50'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
            }`}
        >
            <div className="p-2 bg-red-500/10 rounded-lg mb-1">
              <XCircle className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Failing</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{counts.fail}</p>
            </div>
        </button>
        <button
            onClick={() => setStatusFilter(statusFilter === 'unknown' ? 'all' : 'unknown')}
            className={`p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'unknown'
                ? 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 ring-2 ring-gray-500 ring-opacity-50'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
            }`}
        >
            <div className="p-2 bg-gray-500/10 rounded-lg mb-1">
              <AlertCircle className="w-5 h-5 text-gray-500" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Unknown</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{counts.unknown}</p>
            </div>
        </button>
      </div>

      {/* Checks List */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm mx-2">
        {filteredChecks.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {checks.length > 0 ? (
                <>
                    <Search className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No checks match your filters.</p>
                    <button onClick={() => {setSearchQuery(''); setStatusFilter('all');}} className="mt-2 text-blue-600 dark:text-blue-400 hover:underline text-sm">
                        Clear filters
                    </button>
                </>
            ) : (
                <>
                    <Activity className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No health checks configured.</p>
                    <button onClick={() => handleOpenModal()} className="mt-4 text-blue-600 dark:text-blue-400 hover:underline text-sm">
                    Create your first check
                    </button>
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
                    className={`p-4 ${index !== filteredChecks.length - 1 ? 'border-b border-gray-200 dark:border-gray-800' : ''} hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors`}
                >
                    <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3 flex-1">
                            <div className={`p-2 rounded-lg ${statusBg} ${statusColor}`}>
                                <StatusIcon className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-medium text-gray-900 dark:text-white">{check.name}</h3>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                                        {check.type.toUpperCase()}
                                    </span>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400">
                                        {check.nodeName || 'local'}
                                    </span>
                                </div>
                                <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                                    {formatLabel(check)}
                                </p>
                                {check.message && (
                                    <p className="text-xs text-gray-500 dark:text-gray-500 mt-1 line-clamp-2">
                                        {check.message}
                                    </p>
                                )}
                                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
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
                                                    className={`w-1.5 rounded-sm ${h.status === 'ok' ? 'bg-green-200 dark:bg-green-900' : 'bg-red-400'}`}
                                                    style={{ height: `${hPercent}%` }}
                                                    title={`${h.latency}ms - ${new Date(h.timestamp).toLocaleTimeString()}`}
                                                ></div>
                                            );
                                        });
                                    })()}
                                </div>
                                <div className="text-[10px] text-gray-400 mt-1 font-mono">
                                    {check.history[0]?.latency || 0}ms
                                </div>
                            </div>
                        )}

                        <div className="flex items-center gap-1 ml-4">
                            <button
                                onClick={() => handleRun(check.id)}
                                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                title={isDiagnose ? 'Re-run self-diagnose now' : 'Run check now'}
                            >
                                <Play className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                            </button>
                            {isDiagnose ? (
                                /* Synthetic diagnose row: not editable config — expose the
                                   self-repair popup instead of Edit/Delete (#1423). It still
                                   gets the History drawer (#1671): its results are persisted
                                   under the `diagnose:<id>` key just like any other check, so
                                   the same history view applies — only Edit/Delete don't. */
                                <>
                                    <button
                                        onClick={() => handleViewHistory(check)}
                                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                        title="View history"
                                    >
                                        <History className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                                    </button>
                                    <button
                                        onClick={() => handleOpenRepair(check)}
                                        className="p-2 hover:bg-violet-100 dark:hover:bg-violet-900/30 rounded-lg transition-colors"
                                        title="Self-repair options"
                                    >
                                        <Wrench className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        onClick={() => handleViewHistory(check)}
                                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                        title="View history"
                                    >
                                        <History className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                                    </button>
                                    <button
                                        onClick={() => handleOpenModal(check)}
                                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                        title="Edit check"
                                    >
                                        <Edit className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                                    </button>
                                    <button
                                        onClick={() => handleOpenDeleteModal(check.id)}
                                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                        title="Delete check"
                                    >
                                        <Trash2 className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                                    </button>
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
