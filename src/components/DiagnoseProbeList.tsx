'use client';

import { useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Wrench } from 'lucide-react';

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

export interface DiagnoseProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  detail: string;
  hint?: string;
  actions?: ProbeAction[];
  items?: ProbeItem[];
}

const STATUS_META: Record<ProbeStatus, { color: string; bg: string; ring: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  ok: { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-900/20', ring: 'border-emerald-200 dark:border-emerald-800', Icon: CheckCircle2 },
  warn: { color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-50 dark:bg-amber-900/20', ring: 'border-amber-200 dark:border-amber-800', Icon: AlertTriangle },
  fail: { color: 'text-red-700 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-900/20', ring: 'border-red-200 dark:border-red-800', Icon: AlertCircle },
  info: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-50 dark:bg-blue-900/20', ring: 'border-blue-200 dark:border-blue-800', Icon: Info },
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

  const runAction = async (probe: DiagnoseProbe, action: ProbeAction, payload?: Record<string, string>, itemId?: string) => {
    if (action.destructive) {
      const ok = window.confirm(`${action.label}\n\n${action.description}\n\nThis action can't be undone. Continue?`);
      if (!ok) return;
    }
    const key = itemId ? `${probe.id}:${action.id}:${itemId}` : `${probe.id}:${action.id}`;
    setActionState(s => ({ ...s, [key]: { running: true } }));

    // `verify_from_device` runs in the browser (the whole point is to test
    // *this device's* DNS resolver). Mirrors SelfDiagnoseSection.
    if (action.id === 'verify_from_device') {
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

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {visible.map(probe => {
        const meta = STATUS_META[probe.status];
        const Icon = meta.Icon;
        return (
          <div key={probe.id} className={`${compact ? 'p-2.5' : 'p-3'} rounded-lg border ${meta.ring} ${meta.bg}`}>
            <div className="flex items-start gap-2">
              <Icon size={compact ? 14 : 16} className={`shrink-0 mt-0.5 ${meta.color}`} />
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
                              disabled={isRunning || parentRunning}
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
                              disabled={!allRequiredFilled || isRunning || parentRunning}
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
                                  disabled={isRunning || parentRunning}
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
  );
}
