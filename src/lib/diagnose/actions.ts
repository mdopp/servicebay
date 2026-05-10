/**
 * Probe-action registry: the dispatcher that turns "click a fix button"
 * in the diagnose UI into a server-side handler call.
 *
 * Per the UX philosophy (`docs/UX_PHILOSOPHY.md`), every probe that
 * surfaces a `warn` or `fail` status should ship one or more actions
 * the user can click to remediate, with consequence-described labels
 * and a `destructive?` flag for confirm-on-destructive UI guards.
 *
 * This module keeps the registry, the action shape, and the dispatch
 * function. Per-probe handlers register themselves at module load via
 * `registerProbeAction`. The actual probes (added incrementally — see
 * the "Self-healing UX rollout" tracking issue) come in follow-up PRs.
 *
 * Wire shape (used by the API route + the SelfDiagnoseSection UI):
 *
 *   Probe.actions: [
 *     { id, label, description, destructive? }
 *   ]
 *
 *   POST /api/system/diagnose/run-action
 *   { probeId: 'npm_data_stale', actionId: 'reset_volume', payload?: {...} }
 *   → { ok, message, refresh? }
 */

import { logger } from '@/lib/logger';

/** Surface a fix the user can apply for a probe in `warn` or `fail` state. */
export interface ProbeAction {
  /** Stable id (referenced by the dispatch endpoint). */
  id: string;
  /** Short button label, ≤ ~24 chars. User-facing language. */
  label: string;
  /**
   * One- or two-sentence description of what will happen if the user
   * clicks. Includes consequences (data loss, restart, downtime). The
   * UI shows this as a tooltip + above the confirm dialog when
   * `destructive` is true.
   */
  description: string;
  /**
   * Marks the action as data-loss / hard-to-reverse. The UI guards it
   * behind a confirm dialog. Default false.
   */
  destructive?: boolean;
}

/** Result payload returned to the UI after an action runs. */
export interface ProbeActionResult {
  /** True iff the action ran to completion. */
  ok: boolean;
  /**
   * One-sentence outcome the UI surfaces as a toast: "NPM data reset
   * successfully — log in with the wizard credentials." Plain English.
   */
  message: string;
  /**
   * When true, the UI re-runs the diagnose suite after the action so
   * the operator immediately sees the probe transition to `ok` (or to
   * a different `warn` if there's a follow-up step). Defaults to true.
   */
  refresh?: boolean;
}

/** Server-side handler registered against `<probeId>:<actionId>`. */
export type ProbeActionHandler = (params: {
  /** Node the probe was running against. */
  node: string;
  /**
   * Optional structured payload from the UI (e.g. credentials the user
   * typed into a form before clicking "Use existing NPM password").
   * Validate inside the handler — the dispatch layer doesn't.
   */
  payload?: Record<string, unknown>;
}) => Promise<ProbeActionResult>;

interface RegistryEntry {
  action: ProbeAction;
  handler: ProbeActionHandler;
}

const registry = new Map<string, RegistryEntry>();

const key = (probeId: string, actionId: string) => `${probeId}:${actionId}`;

/**
 * Register a probe action. Called at module load by per-probe modules
 * (e.g. `lib/diagnose/probes/npmDataStale.ts`). Re-registering an
 * existing key throws — every action must be uniquely owned.
 */
export function registerProbeAction(
  probeId: string,
  action: ProbeAction,
  handler: ProbeActionHandler,
): void {
  const k = key(probeId, action.id);
  if (registry.has(k)) {
    throw new Error(`Probe action already registered: ${k}`);
  }
  registry.set(k, { action, handler });
}

/**
 * Look up the action metadata (without the handler) for a probe.
 * Probe routes call this to attach `actions[]` to their output.
 */
export function actionsForProbe(probeId: string): ProbeAction[] {
  const out: ProbeAction[] = [];
  for (const [k, entry] of registry) {
    if (k.startsWith(`${probeId}:`)) out.push(entry.action);
  }
  return out;
}

/**
 * Dispatch a single user-clicked action. Errors thrown by the handler
 * are caught and converted into `{ ok: false, message }` so the UI
 * always gets a structured response.
 */
export async function dispatchProbeAction(params: {
  probeId: string;
  actionId: string;
  node: string;
  payload?: Record<string, unknown>;
}): Promise<ProbeActionResult> {
  const k = key(params.probeId, params.actionId);
  const entry = registry.get(k);
  if (!entry) {
    return {
      ok: false,
      message: `Unknown probe action: ${k}`,
      refresh: false,
    };
  }
  try {
    const result = await entry.handler({ node: params.node, payload: params.payload });
    // Default refresh = true so probes auto-re-run after a fix.
    return { refresh: true, ...result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('diagnose:actions', `Action ${k} threw: ${message}`);
    return { ok: false, message: `Action failed: ${message}`, refresh: false };
  }
}

/**
 * Test-only: clear the registry between unit-test runs so each test
 * starts with a clean slate. Production code must never call this.
 */
export function _resetRegistryForTesting(): void {
  registry.clear();
}
