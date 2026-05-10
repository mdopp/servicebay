'use client';

import { useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Stethoscope, Wrench } from 'lucide-react';

type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

interface ProbeActionInput {
  name: string;
  label: string;
  type: 'text' | 'password' | 'email';
  placeholder?: string;
  hint?: string;
  required?: boolean;
}

interface ProbeAction {
  id: string;
  label: string;
  description: string;
  destructive?: boolean;
  inputs?: ProbeActionInput[];
}

interface ProbeItem {
  id: string;
  label: string;
  detail?: string;
  status?: ProbeStatus;
  actions: ProbeAction[];
}

interface DiagnoseProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  detail: string;
  hint?: string;
  actions?: ProbeAction[];
  items?: ProbeItem[];
}

interface DiagnoseResult {
  node: string;
  probes: DiagnoseProbe[];
}

const STATUS_META: Record<ProbeStatus, { color: string; bg: string; ring: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  ok: { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-900/20', ring: 'border-emerald-200 dark:border-emerald-800', Icon: CheckCircle2 },
  warn: { color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-50 dark:bg-amber-900/20', ring: 'border-amber-200 dark:border-amber-800', Icon: AlertTriangle },
  fail: { color: 'text-red-700 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-900/20', ring: 'border-red-200 dark:border-red-800', Icon: AlertCircle },
  info: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-50 dark:bg-blue-900/20', ring: 'border-blue-200 dark:border-blue-800', Icon: Info },
};

export default function SelfDiagnoseSection() {
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Per-action transient state. Keyed by `<probeId>:<actionId>` for probe-level
   *  actions, or `<probeId>:<actionId>:<itemId>` for per-item actions. */
  const [actionState, setActionState] = useState<Record<string, { running?: boolean; message?: string; details?: string; ok?: boolean }>>({});
  /** Which actions have their inline form expanded. Keyed by `<probeId>:<actionId>`. */
  const [expandedForms, setExpandedForms] = useState<Record<string, boolean>>({});
  /** Form-field values per action. Keyed by `<probeId>:<actionId>` → { fieldName: value }. */
  const [formValues, setFormValues] = useState<Record<string, Record<string, string>>>({});

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/system/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const runAction = async (probe: DiagnoseProbe, action: ProbeAction, payload?: Record<string, string>, itemId?: string) => {
    // Confirm-on-destructive guard. The action's description is
    // surfaced in the dialog so the user sees the consequences they
    // accepted.
    if (action.destructive) {
      const ok = window.confirm(`${action.label}\n\n${action.description}\n\nThis action can't be undone. Continue?`);
      if (!ok) return;
    }
    // Per-item actions key off the item id too so a row's button
    // state doesn't bleed into siblings.
    const key = itemId ? `${probe.id}:${action.id}:${itemId}` : `${probe.id}:${action.id}`;
    setActionState(s => ({ ...s, [key]: { running: true } }));
    // Special case: actions with id `verify_from_device` run as a
    // browser-side fetch instead of dispatching to the server (#264).
    // The whole point of "verify from this device" is to test what
    // *this device's* DNS resolver does — which has to happen in the
    // browser, not on the ServiceBay backend.
    if (action.id === 'verify_from_device') {
      try {
        // First call /api/system/mode (same-origin, always works) to
        // learn the active domain — then fetch from `admin.<domain>`
        // to verify *this device's* DNS routes home.arpa to ServiceBay.
        const modeRes = await fetch('/api/system/mode');
        const modeData = await modeRes.json().catch(() => ({}));
        const activeDomain = modeData.activeDomain ?? 'home.arpa';
        const verifyRes = await fetch(`http://admin.${activeDomain}/api/system/verify-lan-dns`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        const data = await verifyRes.json().catch(() => ({}));
        const ok = verifyRes.ok && data.ok === true;
        setActionState(s => ({
          ...s,
          [key]: {
            ok,
            message: ok
              ? `✅ This device resolves ${activeDomain} → ${data.lanIp ?? 'ok'}.`
              : `Got HTTP ${verifyRes.status} — DNS may be partially configured.`,
          },
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setActionState(s => ({
          ...s,
          [key]: {
            ok: false,
            message: `❌ This device can't resolve the LAN domain — your router may not be using AdGuard as DNS, or this device has DNS-over-HTTPS overriding it. (${msg})`,
          },
        }));
      }
      return;
    }
    try {
      const res = await fetch('/api/system/diagnose/run-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          probeId: probe.id,
          actionId: action.id,
          node: result?.node,
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
      // Auto-rerun the diagnose suite when the action requested it.
      // This makes the probe transition to `ok` (or to a follow-up
      // warn) immediately visible without a manual click.
      if (ok && data.refresh !== false) {
        void run();
      }
    } catch (e) {
      setActionState(s => ({
        ...s,
        [key]: { ok: false, message: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  const counts = result ? result.probes.reduce<Record<ProbeStatus, number>>(
    (a, p) => ({ ...a, [p.status]: (a[p.status] || 0) + 1 }),
    { ok: 0, warn: 0, fail: 0, info: 0 },
  ) : null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-violet-100 dark:bg-violet-900/30 rounded-lg text-violet-600 dark:text-violet-400">
          <Stethoscope size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Self-Test</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Runs a battery of probes on the local node and reports container engine, pods, failed units, USB sticks, storage, and first-boot status.
          </p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
        >
          {running ? <Loader2 size={16} className="animate-spin" /> : <Stethoscope size={16} />}
          {running ? 'Running…' : result ? 'Run again' : 'Run self-test'}
        </button>
      </div>

      <div className="p-6 space-y-3">
        {error && (
          <div className="p-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-sm text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        {!result && !error && !running && (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            Click &quot;Run self-test&quot; to probe this node. Useful when something doesn&apos;t behave as expected — surfaces the most common gotchas (agent not reachable, pod failing, /mnt/data not mounted, USB stick not detected).
          </p>
        )}

        {counts && (
          <div className="flex items-center gap-3 text-sm">
            {(['ok', 'warn', 'fail', 'info'] as ProbeStatus[]).map(s => {
              const meta = STATUS_META[s];
              const n = counts[s];
              if (!n) return null;
              const Icon = meta.Icon;
              return (
                <span key={s} className={`inline-flex items-center gap-1 px-2 py-1 rounded ${meta.bg} ${meta.color} font-medium`}>
                  <Icon size={14} /> {n} {s}
                </span>
              );
            })}
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">node: {result?.node}</span>
          </div>
        )}

        {result?.probes.map(probe => {
          const meta = STATUS_META[probe.status];
          const Icon = meta.Icon;
          return (
            <div key={probe.id} className={`p-3 rounded-lg border ${meta.ring} ${meta.bg}`}>
              <div className="flex items-start gap-2">
                <Icon size={16} className={`shrink-0 mt-0.5 ${meta.color}`} />
                <div className="flex-1 min-w-0">
                  <div className={`font-medium text-sm ${meta.color}`}>{probe.label}</div>
                  <pre className="text-xs text-gray-700 dark:text-gray-300 mt-1 whitespace-pre-wrap break-words font-mono">{probe.detail}</pre>
                  {probe.hint && (
                    <p className={`text-xs mt-2 ${meta.color}`}>
                      <strong>Suggestion:</strong> {probe.hint}
                    </p>
                  )}
                  {(probe.actions ?? []).length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {(probe.actions ?? []).map(action => {
                          const key = `${probe.id}:${action.id}`;
                          const state = actionState[key];
                          const isRunning = state?.running;
                          const hasInputs = (action.inputs ?? []).length > 0;
                          const isExpanded = expandedForms[key];
                          const baseStyle = action.destructive
                            ? 'bg-red-600 hover:bg-red-700 text-white'
                            : 'bg-violet-600 hover:bg-violet-700 text-white';
                          return (
                            <div key={action.id} className="flex items-center gap-2">
                              <button
                                onClick={() => {
                                  if (hasInputs) {
                                    setExpandedForms(s => ({ ...s, [key]: !s[key] }));
                                  } else {
                                    void runAction(probe, action);
                                  }
                                }}
                                disabled={isRunning || running}
                                title={action.description}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${baseStyle}`}
                              >
                                {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                                {action.label}
                                {hasInputs && (isExpanded ? ' ▴' : ' ▾')}
                              </button>
                              {state?.message && !isRunning && (
                                <span className={`text-xs ${state.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                  {state.ok ? '✓' : '✗'} {state.message}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {/* Multi-line action result details (e.g. log tails). One
                          block per action that produced details on its last
                          run. Rendered as a wrapped <pre> so newlines survive. */}
                      {(probe.actions ?? []).map(action => {
                        const key = `${probe.id}:${action.id}`;
                        const state = actionState[key];
                        if (!state?.details) return null;
                        return (
                          <pre
                            key={`${key}-details`}
                            className="text-xs text-gray-700 dark:text-gray-300 bg-white/60 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono"
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
                            className="p-3 rounded-md bg-white/60 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 space-y-2"
                          >
                            <p className="text-xs text-gray-600 dark:text-gray-400">{action.description}</p>
                            {inputs.map(input => (
                              <div key={input.name} className="space-y-1">
                                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                                  {input.label}{input.required !== false && <span className="text-red-500"> *</span>}
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
                                  className="w-full px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
                                  autoComplete="off"
                                />
                                {input.hint && (
                                  <p className="text-xs text-gray-500 dark:text-gray-400">{input.hint}</p>
                                )}
                              </div>
                            ))}
                            <div className="flex items-center gap-2 pt-1">
                              <button
                                type="submit"
                                disabled={!allRequiredFilled || isRunning || running}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
                              >
                                {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                                Submit
                              </button>
                              <button
                                type="button"
                                onClick={() => setExpandedForms(s => ({ ...s, [key]: false }))}
                                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                              >
                                Cancel
                              </button>
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
                            className={`flex flex-wrap items-center gap-2 px-2 py-1.5 rounded border ${itemMeta.ring} bg-white/60 dark:bg-gray-900/40`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className={`text-xs font-mono ${itemMeta.color}`}>{item.label}</div>
                              {item.detail && (
                                <div className="text-xs text-gray-600 dark:text-gray-400 font-mono">{item.detail}</div>
                              )}
                            </div>
                            {item.actions.map(action => {
                              const key = `${probe.id}:${action.id}:${item.id}`;
                              const state = actionState[key];
                              const isRunning = state?.running;
                              const baseStyle = action.destructive
                                ? 'bg-red-600 hover:bg-red-700 text-white'
                                : 'bg-violet-600 hover:bg-violet-700 text-white';
                              return (
                                <div key={action.id} className="flex items-center gap-2">
                                  <button
                                    onClick={() => void runAction(probe, action, undefined, item.id)}
                                    disabled={isRunning || running}
                                    title={action.description}
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${baseStyle}`}
                                  >
                                    {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                                    {action.label}
                                  </button>
                                  {state?.message && !isRunning && (
                                    <span className={`text-xs ${state.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                      {state.ok ? '✓' : '✗'} {state.message}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                            {/* Multi-line details for any per-item action that
                                produced them — rendered full-width below the
                                button row. flex-wrap on the parent makes
                                w-full take a new line cleanly. */}
                            {item.actions.map(action => {
                              const key = `${probe.id}:${action.id}:${item.id}`;
                              const state = actionState[key];
                              if (!state?.details) return null;
                              return (
                                <pre
                                  key={`${key}-details`}
                                  className="w-full text-xs text-gray-700 dark:text-gray-300 bg-white/80 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono"
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
        })}
      </div>
    </div>
  );
}
