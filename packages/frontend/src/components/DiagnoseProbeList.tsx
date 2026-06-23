'use client';

import { useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, History, Info, Loader2, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui';

/**
 * Shared probe-list renderer used by Settings → Self-Diagnose and by the
 * OnboardingWizard's post-install diagnose panel. Owns the action-dispatch
 * state machine (button disabled while running, message + details after,
 * destructive-action confirm, inline form for actions with `inputs[]`) so
 * the two surfaces don't drift.
 *
 * Wizard mode (`compact = true`) hides probes with `status === 'ok'` so the
 * post-install summary stays focused on actionable issues; settings mode
 * (`compact = false`) lists every probe for full transparency.
 */

export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

interface ProbeActionInput {
  name: string;
  label: string;
  type: 'text' | 'password' | 'email';
  placeholder?: string;
  hint?: string;
  required?: boolean;
}

export interface ProbeAction {
  id: string;
  label: string;
  description: string;
  destructive?: boolean;
  inputs?: ProbeActionInput[];
}

export interface ProbeItem {
  id: string;
  label: string;
  detail?: string;
  status?: ProbeStatus;
  actions: ProbeAction[];
}

/** Problem-domain card a probe belongs to (#1534). Mirrors the backend
 *  `ProbeGroup` union in `lib/diagnose/runDiagnose.ts` — kept structural
 *  (no shared import) to match the existing duplicated `DiagnoseProbe`
 *  shape across the package boundary. */
export type ProbeGroup =
  | 'services'
  | 'reverse-proxy'
  | 'proxy-admin'
  | 'domains'
  | 'dns-network'
  | 'tls'
  | 'sso'
  | 'storage-backups'
  | 'system-info'
  | 'other';

/** Persisted result history for a probe (#1541). Mirrors the backend
 *  `ProbeHistory` in `lib/diagnose/persistDiagnoseResults.ts` — kept
 *  structural (no shared import) to match the existing duplicated
 *  `DiagnoseProbe` shape across the package boundary. `trend` is
 *  oldest → newest binary statuses for a left-to-right sparkline. */
export interface ProbeHistory {
  firstSeen: string;
  lastOk: string | null;
  trend: ('ok' | 'fail')[];
  total: number;
}

/** One persisted result row served by `GET /api/health/checks/:id/history`
 *  (#1553). Mirrors the HealthStore result shape the Checks tab already
 *  consumes — newest first. */
interface ProbeHistoryItem {
  status: 'ok' | 'fail';
  latency: number;
  timestamp: string;
  message?: string;
}

export interface DiagnoseProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  detail: string;
  hint?: string;
  actions?: ProbeAction[];
  items?: ProbeItem[];
  /** Problem-domain card (#1534). Set by the backend; older payloads
   *  without it fall through to the ungrouped flat list. */
  group?: ProbeGroup;
  /** Persisted first-seen / last-ok / trend (#1541). Set by the backend
   *  once #1540 persistence has accrued; absent on a brand-new box or an
   *  older backend, in which case the row simply shows no history badge. */
  history?: ProbeHistory;
}

/** Compact relative-time label ("3d", "5h", "12m", "just now") for a
 *  history timestamp. Keeps the badge terse — the full timestamp lives
 *  in the element's `title`. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '?';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Uniform per-row history badge (#1541): first-seen, last-ok, and a
 * trend sparkline, rendered identically on every diagnose row from the
 * persisted `history` payload. No per-probe special-casing — a row with
 * no history yet renders nothing.
 */
function ProbeHistoryBadge({ history, compact }: { history?: ProbeHistory; compact: boolean }) {
  if (!history || history.trend.length === 0) return null;
  const trend = history.trend.slice(-20);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
      <span
        className="inline-flex items-end gap-[1.5px] h-3.5"
        title={`Trend: ${trend.length} of ${history.total} recent checks (oldest → newest)`}
        aria-label="status trend"
      >
        {trend.map((s, i) => (
          <span
            key={i}
            className={`inline-block w-[3px] ${compact ? 'h-2.5' : 'h-3.5'} rounded-chip ${
              s === 'ok' ? 'bg-status-ok' : 'bg-status-fail'
            }`}
          />
        ))}
      </span>
      <span title={new Date(history.firstSeen).toLocaleString()}>
        first seen <span className="font-medium">{relTime(history.firstSeen)}</span> ago
      </span>
      <span title={history.lastOk ? new Date(history.lastOk).toLocaleString() : 'No passing result on record'}>
        {history.lastOk
          ? <>last ok <span className="font-medium">{relTime(history.lastOk)}</span> ago</>
          : <span className="text-status-fail">never ok</span>}
      </span>
    </div>
  );
}

/** Card metadata for the problem-domain grouping (#1534). `order` fixes
 *  the card sequence; `info` marks the collapsed "System info" panel
 *  (probes that are information, not problems). */
const GROUP_META: Record<ProbeGroup, { label: string; order: number; info?: boolean }> = {
  services:          { label: 'Services running',     order: 0 },
  'reverse-proxy':   { label: 'Reverse-proxy routes', order: 1 },
  'proxy-admin':     { label: 'Proxy admin',          order: 2 },
  domains:           { label: 'Domains reachable',    order: 3 },
  'dns-network':     { label: 'DNS & network',        order: 4 },
  tls:               { label: 'TLS certificates',     order: 5 },
  sso:               { label: 'Login / SSO',          order: 6 },
  'storage-backups': { label: 'Storage & backups',    order: 7 },
  other:             { label: 'Other checks',         order: 8 },
  'system-info':     { label: 'System info',          order: 9, info: true },
};

/** Worst status across a card's probes — drives the card header tint
 *  (fail > warn > info > ok). */
function worstStatus(probes: DiagnoseProbe[]): ProbeStatus {
  const rank: Record<ProbeStatus, number> = { ok: 0, info: 1, warn: 2, fail: 3 };
  return probes.reduce<ProbeStatus>(
    (worst, p) => (rank[p.status] > rank[worst] ? p.status : worst),
    'ok',
  );
}

/**
 * Client-side DNS verification: hits the public installer admin host on
 * *this device's* DNS resolver and reports whether the browser can
 * resolve the LAN domain. Runs in the browser (not the server) because
 * the whole point is to test the calling device's DNS setup.
 *
 * Returns the action-state row the caller should write into its
 * `actionState[key]` map — keeps runAction's dispatch step trivial.
 */
async function runVerifyFromDeviceAction(): Promise<{ ok: boolean; message: string }> {
  try {
    const modeRes = await fetch('/api/system/mode');
    const modeData = await modeRes.json().catch(() => ({}));
    const activeDomain = modeData.activeDomain ?? 'home.arpa';
    const verifyRes = await fetch(`http://admin.${activeDomain}/api/system/verify-lan-dns`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    const data = await verifyRes.json().catch(() => ({}));
    const ok = verifyRes.ok && data.ok === true;
    return {
      ok,
      message: ok
        ? `✅ This device resolves ${activeDomain} → ${data.lanIp ?? 'ok'}.`
        : `Got HTTP ${verifyRes.status} — DNS may be partially configured.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: `❌ This device can't resolve the LAN domain — your router may not be using AdGuard as DNS, or this device has DNS-over-HTTPS overriding it. (${msg})`,
    };
  }
}

/** Probe status → semantic status tokens (design-system #2100). One status
 *  token per state drives the row text, the tinted surface and the border —
 *  no raw emerald/amber/red/blue-200/300 literals. */
const STATUS_META: Record<ProbeStatus, { color: string; bg: string; ring: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  ok: { color: 'text-status-ok', bg: 'bg-status-ok/10', ring: 'border-status-ok/30', Icon: CheckCircle2 },
  warn: { color: 'text-status-warn', bg: 'bg-status-warn/10', ring: 'border-status-warn/30', Icon: AlertTriangle },
  fail: { color: 'text-status-fail', bg: 'bg-status-fail/10', ring: 'border-status-fail/30', Icon: AlertCircle },
  info: { color: 'text-status-info', bg: 'bg-status-info/10', ring: 'border-status-info/30', Icon: Info },
};

interface DiagnoseProbeListProps {
  probes: DiagnoseProbe[];
  /** Node name passed back to the dispatch endpoint. */
  node: string;
  /** Compact = wizard-style. Filters out `ok` rows and tightens spacing. */
  compact?: boolean;
  /** Called after a successful action so the host can re-fetch the suite.
   *  Default no-op; SelfDiagnoseSection passes `run`, the wizard passes
   *  the function that resets its auto-run gate. */
  onRefresh?: () => void;
  /** Disable buttons while the parent is mid-run. */
  parentRunning?: boolean;
}

export default function DiagnoseProbeList({
  probes,
  node,
  compact = false,
  onRefresh,
  parentRunning = false,
}: DiagnoseProbeListProps) {
  /** Per-action transient state. Keyed by `<probeId>:<actionId>` for
   *  probe-level actions, `<probeId>:<actionId>:<itemId>` for per-item. */
  const [actionState, setActionState] = useState<Record<string, { running?: boolean; message?: string; details?: string; ok?: boolean }>>({});
  /** Which actions have their inline form expanded. */
  const [expandedForms, setExpandedForms] = useState<Record<string, boolean>>({});
  /** Form-field values per action. */
  const [formValues, setFormValues] = useState<Record<string, Record<string, string>>>({});
  /** #1553 — self-contained per-probe history drawer. #1540 persists each
   *  probe as a synthetic `diagnose:<probeId>` check, so the same
   *  `/api/health/checks/:id/history` endpoint the Checks tab uses also
   *  serves diagnose history. Owning the drawer here (rather than threading
   *  a callback through every consumer) means setup, StacksStep and the
   *  HealthDashboard repair popup all get the opener for free. */
  const [historyProbe, setHistoryProbe] = useState<DiagnoseProbe | null>(null);
  const [historyData, setHistoryData] = useState<ProbeHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const handleViewHistory = async (probe: DiagnoseProbe) => {
    setHistoryProbe(probe);
    setHistoryData([]);
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/health/checks/${encodeURIComponent(`diagnose:${probe.id}`)}/history`);
      if (res.ok) setHistoryData(await res.json());
    } catch {
      // Leave historyData empty — the drawer shows its "no history" state.
    } finally {
      setHistoryLoading(false);
    }
  };

  const closeHistory = () => {
    setHistoryProbe(null);
    setHistoryData([]);
    setHistoryLoading(false);
  };

  const runAction = async (probe: DiagnoseProbe, action: ProbeAction, payload?: Record<string, string>, itemId?: string) => {
    if (action.destructive) {
      const ok = window.confirm(`${action.label}\n\n${action.description}\n\nThis action can't be undone. Continue?`);
      if (!ok) return;
    }
    const key = itemId ? `${probe.id}:${action.id}:${itemId}` : `${probe.id}:${action.id}`;
    setActionState(s => ({ ...s, [key]: { running: true } }));

    if (action.id === 'verify_from_device') {
      const result = await runVerifyFromDeviceAction();
      setActionState(s => ({ ...s, [key]: result }));
      return;
    }

    try {
      const res = await fetch('/api/system/diagnose/run-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          probeId: probe.id,
          actionId: action.id,
          node,
          ...(itemId ? { itemId } : {}),
          ...(payload ? { payload } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok !== false;
      setActionState(s => ({
        ...s,
        [key]: {
          ok,
          message: data.message ?? (ok ? 'Done.' : `HTTP ${res.status}`),
          details: typeof data.details === 'string' ? data.details : undefined,
        },
      }));
      if (ok && data.refresh !== false && onRefresh) onRefresh();
    } catch (e) {
      setActionState(s => ({
        ...s,
        [key]: { ok: false, message: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  // In compact mode, hide ok rows — the wizard's outer panel already
  // surfaces the overall pass/warn/fail count, so a list of every probe
  // would be noise.
  const visible = compact ? probes.filter(p => p.status !== 'ok') : probes;

  const renderProbeRow = (probe: DiagnoseProbe) => {
        const meta = STATUS_META[probe.status];
        const Icon = meta.Icon;
        return (
          <div key={probe.id} className={`${compact ? 'p-2.5' : 'p-3'} rounded-card border ${meta.ring} ${meta.bg}`}>
            <div className="flex items-start gap-2">
              <Icon size={compact ? 14 : 16} className={`shrink-0 mt-0.5 ${meta.color}`} />
              <div className="flex-1 min-w-0">
                <div className={`font-medium text-sm ${meta.color}`}>{probe.label}</div>
                <pre className="text-xs text-text-muted mt-1 whitespace-pre-wrap break-words font-mono">{probe.detail}</pre>
                {probe.hint && (
                  <p className={`text-xs mt-2 ${meta.color}`}>
                    <strong>Suggestion:</strong> {probe.hint}
                  </p>
                )}
                <div className="flex items-start justify-between gap-2">
                  <ProbeHistoryBadge history={probe.history} compact={compact} />
                  {probe.history && probe.history.trend.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleViewHistory(probe)}
                      title="View history"
                      aria-label={`View history for ${probe.label}`}
                      className="shrink-0 mt-1.5 p-1 rounded-card hover:bg-surface-2 text-text-muted transition-colors"
                    >
                      <History size={14} />
                    </button>
                  )}
                </div>
                {(probe.actions ?? []).length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      {(probe.actions ?? []).map(action => {
                        const key = `${probe.id}:${action.id}`;
                        const state = actionState[key];
                        const isRunning = state?.running;
                        const hasInputs = (action.inputs ?? []).length > 0;
                        const isExpanded = expandedForms[key];
                        return (
                          <div key={action.id} className="flex items-center gap-2">
                            <Button
                              variant={action.destructive ? 'danger' : 'primary'}
                              size="sm"
                              onClick={() => {
                                if (hasInputs) {
                                  setExpandedForms(s => ({ ...s, [key]: !s[key] }));
                                } else {
                                  void runAction(probe, action);
                                }
                              }}
                              disabled={isRunning || parentRunning}
                              title={action.description}
                            >
                              {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                              {action.label}
                              {hasInputs && (isExpanded ? ' ▴' : ' ▾')}
                            </Button>
                            {state?.message && !isRunning && (
                              <span className={`text-xs ${state.ok ? 'text-status-ok' : 'text-status-fail'}`}>
                                {state.ok ? '✓' : '✗'} {state.message}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {(probe.actions ?? []).map(action => {
                      const key = `${probe.id}:${action.id}`;
                      const state = actionState[key];
                      if (!state?.details) return null;
                      return (
                        <pre
                          key={`${key}-details`}
                          className="text-xs text-text-muted bg-surface-muted border border-border rounded-card p-space-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono"
                        >{state.details}</pre>
                      );
                    })}
                    {(probe.actions ?? []).map(action => {
                      const key = `${probe.id}:${action.id}`;
                      const hasInputs = (action.inputs ?? []).length > 0;
                      if (!hasInputs || !expandedForms[key]) return null;
                      const values = formValues[key] ?? {};
                      const state = actionState[key];
                      const isRunning = state?.running;
                      const inputs = action.inputs ?? [];
                      const allRequiredFilled = inputs
                        .filter(i => i.required !== false)
                        .every(i => (values[i.name] ?? '').length > 0);
                      return (
                        <form
                          key={`${key}-form`}
                          onSubmit={e => {
                            e.preventDefault();
                            void runAction(probe, action, values);
                          }}
                          className="p-space-3 rounded-card bg-surface-muted border border-border space-y-space-2"
                        >
                          <p className="text-xs text-text-muted">{action.description}</p>
                          {inputs.map(input => (
                            <div key={input.name} className="space-y-1">
                              <label className="block text-xs font-medium text-text-muted">
                                {input.label}{input.required !== false && <span className="text-status-fail"> *</span>}
                              </label>
                              <input
                                type={input.type}
                                value={values[input.name] ?? ''}
                                placeholder={input.placeholder}
                                required={input.required !== false}
                                onChange={e =>
                                  setFormValues(s => ({
                                    ...s,
                                    [key]: { ...(s[key] ?? {}), [input.name]: e.target.value },
                                  }))
                                }
                                className="w-full px-space-2 py-1.5 text-sm rounded-card border border-border bg-surface-2 text-text focus:outline-none focus:ring-1 focus:ring-accent"
                                autoComplete="off"
                              />
                              {input.hint && (
                                <p className="text-xs text-text-muted">{input.hint}</p>
                              )}
                            </div>
                          ))}
                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              type="submit"
                              size="sm"
                              disabled={!allRequiredFilled || isRunning || parentRunning}
                            >
                              {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                              Submit
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setExpandedForms(s => ({ ...s, [key]: false }))}
                            >
                              Cancel
                            </Button>
                          </div>
                        </form>
                      );
                    })}
                  </div>
                )}
                {(probe.items ?? []).length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {(probe.items ?? []).map(item => {
                      const itemMeta = STATUS_META[item.status ?? probe.status];
                      return (
                        <div
                          key={item.id}
                          className={`flex flex-wrap items-center gap-2 px-space-2 py-1.5 rounded-card border ${itemMeta.ring} bg-surface-muted`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className={`text-xs font-mono ${itemMeta.color}`}>{item.label}</div>
                            {item.detail && (
                              <div className="text-xs text-text-muted font-mono">{item.detail}</div>
                            )}
                          </div>
                          {item.actions.map(action => {
                            const key = `${probe.id}:${action.id}:${item.id}`;
                            const state = actionState[key];
                            const isRunning = state?.running;
                            return (
                              <div key={action.id} className="flex items-center gap-2">
                                <Button
                                  variant={action.destructive ? 'danger' : 'primary'}
                                  size="sm"
                                  onClick={() => void runAction(probe, action, undefined, item.id)}
                                  disabled={isRunning || parentRunning}
                                  title={action.description}
                                >
                                  {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                                  {action.label}
                                </Button>
                                {state?.message && !isRunning && (
                                  <span className={`text-xs ${state.ok ? 'text-status-ok' : 'text-status-fail'}`}>
                                    {state.ok ? '✓' : '✗'} {state.message}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                          {item.actions.map(action => {
                            const key = `${probe.id}:${action.id}:${item.id}`;
                            const state = actionState[key];
                            if (!state?.details) return null;
                            return (
                              <pre
                                key={`${key}-details`}
                                className="w-full text-xs text-text-muted bg-surface-muted border border-border rounded-card p-space-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono"
                              >{state.details}</pre>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
  };

  // #1534 — group rows into problem-domain cards. Probes carry a `group`
  // field from the backend; bucket by it, order by GROUP_META, and render
  // the info-only `system-info` group as a collapsed panel. A payload
  // without `group` (older backend) lands every probe in `other`, so the
  // list degrades to one flat card rather than disappearing.
  const buckets = new Map<ProbeGroup, DiagnoseProbe[]>();
  for (const probe of visible) {
    const g = probe.group ?? 'other';
    const arr = buckets.get(g);
    if (arr) arr.push(probe);
    else buckets.set(g, [probe]);
  }
  const orderedGroups = Array.from(buckets.entries())
    .filter(([, ps]) => ps.length > 0)
    .sort((a, b) => GROUP_META[a[0]].order - GROUP_META[b[0]].order);

  // Problem cards lead; the collapsed System-info panel trails.
  const problemGroups = orderedGroups.filter(([g]) => !GROUP_META[g].info);
  const infoGroups = orderedGroups.filter(([g]) => GROUP_META[g].info);

  const renderCard = ([group, ps]: [ProbeGroup, DiagnoseProbe[]]) => {
    const cardMeta = STATUS_META[worstStatus(ps)];
    return (
      <div key={group} className={`rounded-card border ${cardMeta.ring} ${cardMeta.bg} ${compact ? 'p-2.5' : 'p-3'}`}>
        <div className={`flex items-center gap-2 mb-2 text-sm font-semibold ${cardMeta.color}`}>
          <cardMeta.Icon size={compact ? 14 : 16} className="shrink-0" />
          {GROUP_META[group].label}
        </div>
        <div className={compact ? 'space-y-2' : 'space-y-3'}>
          {ps.map(renderProbeRow)}
        </div>
      </div>
    );
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {problemGroups.map(renderCard)}
      {infoGroups.map(([group, ps]) => (
        <details key={group} className={`rounded-card border border-border bg-surface-muted ${compact ? 'p-2.5' : 'p-3'}`}>
          <summary className="cursor-pointer text-sm font-semibold text-text-muted select-none">
            {GROUP_META[group].label} ({ps.length})
          </summary>
          <div className={`mt-2 ${compact ? 'space-y-2' : 'space-y-3'}`}>
            {ps.map(renderProbeRow)}
          </div>
        </details>
      ))}

      {/* #1553 — per-probe history drawer. Opens the persisted
          `diagnose:<probeId>` results so the diagnose page has parity with
          the Checks tab's history opener. */}
      {historyProbe && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
          onClick={closeHistory}
        >
          <div
            className="w-full sm:max-w-2xl h-full bg-surface border-l border-border flex flex-col shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 p-space-5 border-b border-border">
              <div className="min-w-0">
                <p className="text-xs uppercase font-semibold tracking-[0.2em] text-text-subtle">Probe history</p>
                <h3 className="text-lg font-bold text-text truncate">{historyProbe.label}</h3>
                <p className="text-xs text-text-muted font-mono truncate">diagnose:{historyProbe.id}</p>
              </div>
              <button
                type="button"
                onClick={closeHistory}
                aria-label="Close history"
                className="shrink-0 p-2 rounded-card hover:bg-surface-2 text-text-muted"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-space-5">
              {historyLoading && historyData.length === 0 ? (
                <div className="flex h-full items-center justify-center gap-3 text-text-muted">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Loading history…</span>
                </div>
              ) : historyData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-text-subtle">
                  No history recorded yet for this probe.
                </div>
              ) : (
                <table className="w-full text-left text-sm border border-border rounded-card overflow-hidden">
                  <thead className="bg-surface-2 text-text-muted">
                    <tr>
                      <th className="p-3 font-semibold">Time</th>
                      <th className="p-3 font-semibold">Status</th>
                      <th className="p-3 font-semibold">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {historyData.map((h, i) => (
                      <tr key={i} className="hover:bg-surface-2 align-top">
                        <td className="p-3 text-text whitespace-nowrap">
                          {new Date(h.timestamp).toLocaleString()}
                        </td>
                        <td className="p-3">
                          <span className={`inline-flex items-center px-space-2 py-0.5 rounded-chip text-xs font-medium ${
                            h.status === 'ok'
                              ? 'bg-status-ok/10 text-status-ok'
                              : 'bg-status-fail/10 text-status-fail'
                          }`}>
                            {h.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="p-3 text-text-muted whitespace-pre-wrap break-words font-mono text-xs">
                          {h.message ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
