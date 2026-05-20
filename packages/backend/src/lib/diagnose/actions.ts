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

/**
 * Inline form field for an action that needs user input before it can
 * run (e.g. "use existing NPM password" needs the operator to type the
 * password). Without `inputs[]` an action dispatches on click; with
 * `inputs[]` the UI expands a small form first and submits the values
 * as the dispatch payload.
 */
export interface ProbeActionInput {
  /** Form field name — passed back as `payload[name]` to the handler. */
  name: string;
  /** Short label shown above the input. */
  label: string;
  /**
   * Field input type. `password` masks the value; `email`/`text` are
   * surface differences only — the handler should still validate.
   */
  type: 'text' | 'password' | 'email';
  /** Placeholder hint inside the input. */
  placeholder?: string;
  /** Helper text shown below the field. */
  hint?: string;
  /** Defaults to true. Required fields are validated before submit. */
  required?: boolean;
}

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
  /**
   * Optional inline form fields. When present, clicking the action
   * button reveals a small form rather than dispatching immediately;
   * the form's values are sent as `payload`. Use for actions that
   * legitimately need operator input (credentials, free-text values).
   * Hide expert-only knobs entirely instead of asking for them — see
   * the UX philosophy.
   */
  inputs?: ProbeActionInput[];
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
   * Optional multi-line content rendered as an expandable code block
   * below `message`. Use for actions that legitimately produce more
   * than a single sentence (log tails, du output, structured error
   * details). Hidden by default behind a "Show details" toggle so
   * the row stays compact when the operator just wants the verdict.
   */
  details?: string;
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
  /**
   * For per-item dynamic actions (`items[]` on a probe), the id of
   * the specific item the user clicked — e.g. an NPM proxy_host id.
   * Absent for probe-level actions; validate inside the handler.
   */
  itemId?: string;
}) => Promise<ProbeActionResult>;

/**
 * One row inside a probe's `items[]` — used for per-item dynamic
 * actions (#251). E.g. each dangling proxy route is an item with a
 * "Delete route" action targeted at its NPM proxy_host id.
 *
 * Items reference probe-level actions by id; the diagnose route
 * resolves the matching `ProbeAction` metadata into `actions[]`
 * before the response leaves the server, so the UI consumes
 * `ResolvedProbeItem` directly.
 */
export interface ProbeItem {
  /** Unique within the probe — passed back as `itemId` on dispatch. */
  id: string;
  /** Human-readable label, e.g. "vault.dopp.cloud → 192.168.0.10:8443". */
  label: string;
  /** Optional secondary line shown below the label. */
  detail?: string;
  /**
   * Optional per-item status. Lets the UI color-code an item
   * differently from its parent probe (e.g. one expired cert in a
   * list of healthy ones). Defaults to the probe status when omitted.
   */
  status?: 'ok' | 'warn' | 'fail' | 'info';
  /**
   * Action IDs available on this item. Must each match an action
   * registered against the probe via `registerProbeAction`.
   */
  actionIds: string[];
}

/** Server-to-client item shape — `actionIds` resolved to full
 *  `ProbeAction` objects by `resolveItemActions`. */
export interface ResolvedProbeItem {
  id: string;
  label: string;
  detail?: string;
  status?: 'ok' | 'warn' | 'fail' | 'info';
  actions: ProbeAction[];
}

/**
 * Resolve a probe's items[] action-ids to the full ProbeAction
 * objects from the registry, so the UI doesn't need a second lookup.
 * Items whose actionIds reference unknown actions silently drop those
 * ids — better to render fewer buttons than crash the diagnose page.
 */
export function resolveItemActions(probeId: string, items: ProbeItem[]): ResolvedProbeItem[] {
  const actions = actionsForProbe(probeId);
  const byId = new Map(actions.map(a => [a.id, a]));
  return items.map(item => ({
    id: item.id,
    label: item.label,
    detail: item.detail,
    status: item.status,
    actions: item.actionIds
      .map(id => byId.get(id))
      .filter((a): a is ProbeAction => a !== undefined),
  }));
}

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
  /** Optional — present only for per-item dynamic actions. See ProbeItem. */
  itemId?: string;
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
  // Validate required inline-form inputs are present before invoking
  // the handler. Handlers still need to validate types/values, but
  // missing-required is uniform and surfaces a clear message.
  const required = (entry.action.inputs ?? []).filter(i => i.required !== false);
  if (required.length > 0) {
    const payload = params.payload ?? {};
    const missing = required.filter(i => {
      const v = payload[i.name];
      return v === undefined || v === null || (typeof v === 'string' && v.length === 0);
    });
    if (missing.length > 0) {
      return {
        ok: false,
        message: `Missing required field${missing.length === 1 ? '' : 's'}: ${missing.map(i => i.label).join(', ')}.`,
        refresh: false,
      };
    }
  }
  try {
    const result = await entry.handler({
      node: params.node,
      payload: params.payload,
      itemId: params.itemId,
    });
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
